// bakebook-store.js — robust per-recipe cloud sync.
//
// WHY THIS EXISTS: the old design kept ALL recipes in one Firestore document and overwrote
// the whole thing on every save, so two devices clobbered each other — a note saved on one
// device could be wiped by an unrelated save on another. Now EACH recipe is its own document
// at users/{uid}/recipes/{recipeId}, kept live-synced by a real-time listener. Edits to
// different recipes never collide, and a change on one device shows on the other within a
// second. Bake logs merge by entry id, so a bake is never lost.
//
// Pages don't change how they read data — localStorage stays the fast working copy. New hook:
//   bakebookWhenReady(fn) -> fn() runs once we're signed in AND the first cloud sync is in
//   bakebookOnChange(fn)  -> fn() runs every time a change arrives from the cloud (re-render)
//   bakebookFlush()       -> force pending local changes up to the cloud now (before navigating)
(function () {
  const RECIPES_KEY = "bakebook.recipes";
  const CATS_KEY = "bakebook.categories";
  const OWNER_KEY = "bakebook.uid"; // which account the cached data belongs to
  const TOMB_KEY = "bakebook.deleted"; // ids deleted locally but maybe not yet synced — survive a refresh
                                       // so a not-yet-pushed delete isn't resurrected by the "cloud wins" merge
  const CATS_TOMB_KEY = "bakebook.deletedCats"; // same, for category names (merged by union on load)
  const SEEN_CATS_KEY = "bakebook.seenCats";    // category names ever seen in the cloud — lets us tell a
                                                // brand-new local category from one DELETED on another device
  const SEEN_RECIPES_KEY = "bakebook.seenRecipes"; // recipe ids ever seen in the cloud, PERSISTED — same job as
                                                   // seenCats but for recipes, so a reload doesn't mistake a
                                                   // recipe deleted on another device for a brand-new local one
  const auth = firebase.auth();
  const db = firebase.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  const storage = firebase.storage();

  let uid = null;
  let ready = false;
  let readyCbs = [];
  let changeCbs = [];
  let internalWrite = false;    // our own cache writes must not re-trigger a push
  let pushTimer = null;
  let pushing = false;
  let changeSeq = 0;            // bumps on every local change (to detect edits made mid-push)
  let lastCats = [];            // the category list we last knew as synced (to detect a local delete)
  let unsub = null;             // the live listener's unsubscribe
  const everSeen = {};          // recipe ids we've ever seen in the cloud (tells "new local" from "deleted elsewhere")
  const lastPushedJson = {};    // id -> JSON we last wrote (so we push only real changes, and know what to delete)
  const pending = {};           // recipe ids with a LOCAL edit not yet confirmed in the cloud. These (and only
                                // these) keep the local copy over the cloud copy — everything else converges to
                                // the cloud, so devices agree on one truth instead of each clinging to its own.

  const rawSetItem = localStorage.setItem.bind(localStorage);

  // ---------- collection helpers ----------
  function recipesCol() { return db.collection("users").doc(uid).collection("recipes"); }
  function metaDoc() { return db.collection("users").doc(uid).collection("meta").doc("book"); }

  // ---------- error banner: never lose data silently ----------
  function showSyncError(msg) {
    let el = document.getElementById("bakebookSyncError");
    if (!el) {
      el = document.createElement("div");
      el.id = "bakebookSyncError";
      el.style.cssText = "position:fixed;left:0;right:0;top:0;z-index:9999;background:#C0392B;color:#fff;" +
        "font:600 13px/1.4 system-ui,sans-serif;padding:8px 12px;text-align:center;";
      (document.body || document.documentElement).appendChild(el);
    }
    el.textContent = "couldn't save to the cloud: " + msg + " — your changes are safe on this device";
  }
  function hideSyncError() {
    const el = document.getElementById("bakebookSyncError");
    if (el) el.remove();
  }

  // ---------- localStorage helpers ----------
  function getLocalRecipes() { try { return JSON.parse(localStorage.getItem(RECIPES_KEY)) || []; } catch (e) { return []; } }
  function setLocalRecipes(recipes) { internalWrite = true; rawSetItem(RECIPES_KEY, JSON.stringify(recipes)); internalWrite = false; }
  function getLocalCategories() { try { const c = JSON.parse(localStorage.getItem(CATS_KEY)); return Array.isArray(c) ? c : []; } catch (e) { return []; } }
  function setLocalCategories(cats) { internalWrite = true; rawSetItem(CATS_KEY, JSON.stringify(cats)); internalWrite = false; }
  // tombstones: recipe ids the user deleted here. Persisted so an un-synced delete survives a refresh
  // (otherwise the merge sees it only in the cloud and brings it back). Cleared once the cloud agrees.
  function getTombstones() { try { const t = JSON.parse(localStorage.getItem(TOMB_KEY)); return Array.isArray(t) ? t : []; } catch (e) { return []; } }
  function setTombstones(ids) { internalWrite = true; rawSetItem(TOMB_KEY, JSON.stringify(ids)); internalWrite = false; }
  // same idea for categories (a plain list, no per-item docs): remember deletions so the union-on-load
  // can't bring a deleted category back before the delete has synced.
  function getCatTombstones() { try { const t = JSON.parse(localStorage.getItem(CATS_TOMB_KEY)); return Array.isArray(t) ? t : []; } catch (e) { return []; } }
  function setCatTombstones(ids) { internalWrite = true; rawSetItem(CATS_TOMB_KEY, JSON.stringify(ids)); internalWrite = false; }
  function getSeenCats() { try { const t = JSON.parse(localStorage.getItem(SEEN_CATS_KEY)); return Array.isArray(t) ? t : []; } catch (e) { return []; } }
  function setSeenCats(ids) { internalWrite = true; rawSetItem(SEEN_CATS_KEY, JSON.stringify(ids)); internalWrite = false; }
  // recipe ids ever seen in the cloud, persisted across reloads (see SEEN_RECIPES_KEY). We seed `everSeen`
  // from this on load and write it back whenever the cloud snapshot arrives.
  function getSeenRecipes() { try { const t = JSON.parse(localStorage.getItem(SEEN_RECIPES_KEY)); return Array.isArray(t) ? t : []; } catch (e) { return []; } }
  function setSeenRecipes(ids) { internalWrite = true; rawSetItem(SEEN_RECIPES_KEY, JSON.stringify(ids)); internalWrite = false; }
  // Converge a category list the way we converge recipes: cloud is the shared truth. Keep every cloud
  // category (unless tombstoned as a local unsynced delete); keep a LOCAL-only category only if it's
  // brand-new (never seen in the cloud) — if it was seen before and is now gone from the cloud, it was
  // deleted on another device, so drop it (this is what stops union from resurrecting deletes).
  function convergeCats(localCats, cloudCats, tomb, seen) {
    const out = [];
    cloudCats.forEach(function (c) { if (tomb.indexOf(c) === -1 && out.indexOf(c) === -1) out.push(c); });
    localCats.forEach(function (c) {
      if (out.indexOf(c) !== -1 || tomb.indexOf(c) !== -1) return;
      if (seen.indexOf(c) === -1) out.push(c);   // brand-new local category the cloud hasn't got yet -> keep + push
      // else: seen in the cloud before, absent now -> deleted elsewhere -> drop
    });
    return out;
  }
  function markCatDeletes() {
    const cur = getLocalCategories();
    let tomb = getCatTombstones();
    lastCats.forEach(function (c) { if (cur.indexOf(c) === -1 && tomb.indexOf(c) === -1) tomb.push(c); }); // removed here
    tomb = tomb.filter(function (c) { return cur.indexOf(c) === -1; });   // re-created -> forget the tombstone
    setCatTombstones(tomb);
    lastCats = cur.slice();
  }
  function unionCats(a, b) {
    const out = [], seen = {};
    (a || []).concat(b || []).forEach(function (c) { const k = String(c); if (!seen[k]) { seen[k] = 1; out.push(c); } });
    return out;
  }

  // ---------- intercept saves: a local write schedules a cloud sync ----------
  localStorage.setItem = function (key, value) {
    rawSetItem(key, value);
    if ((key === RECIPES_KEY || key === CATS_KEY) && !internalWrite && uid) {
      changeSeq++;
      if (key === RECIPES_KEY) markPending();
      if (key === CATS_KEY) markCatDeletes();
      schedulePush();
    }
  };
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushToCloud, 700); }

  // Flag every recipe whose local copy differs from what we last pushed (a real unsynced edit),
  // plus any recipe deleted locally. Only pending recipes keep local over cloud.
  function markPending() {
    const local = getLocalRecipes();
    const seen = {};
    local.forEach(function (r) {
      if (r && r.id) { seen[r.id] = 1; if (lastPushedJson[r.id] !== JSON.stringify(r)) pending[r.id] = 1; }
    });
    const tomb = getTombstones();
    let tombChanged = false;
    Object.keys(lastPushedJson).forEach(function (id) {                 // present last sync, gone now = deleted here
      if (!seen[id]) { pending[id] = 1; if (tomb.indexOf(id) === -1) { tomb.push(id); tombChanged = true; } }
    });
    if (tombChanged) setTombstones(tomb);   // persist the delete so a refresh can't resurrect it
  }

  // ---------- photos: base64 -> Storage URL (keeps recipe docs small) ----------
  async function maybeUpload(photo, recipeId) {
    if (typeof photo !== "string" || photo.indexOf("data:") !== 0) return photo; // already a URL
    const name = Date.now() + "-" + Math.random().toString(36).slice(2, 8) + ".jpg";
    const ref = storage.ref().child("users/" + uid + "/" + (recipeId || "misc") + "/" + name);
    await ref.putString(photo, "data_url");
    return await ref.getDownloadURL();
  }
  async function uploadRecipePhotos(r) {
    if (Array.isArray(r.photos)) {
      for (let i = 0; i < r.photos.length; i++) r.photos[i] = await maybeUpload(r.photos[i], r.id);
    }
    if (Array.isArray(r.logs)) {
      for (const log of r.logs) {
        if (log && Array.isArray(log.photos)) {
          for (let i = 0; i < log.photos.length; i++) log.photos[i] = await maybeUpload(log.photos[i], r.id);
        }
      }
    }
  }

  // ---------- pure merge helpers (unit-tested) ----------
  // Union bake logs by id: `primary`'s versions win (its edits), and any log the other side
  // has that primary lacks (a bake added on another device) is appended. A bake is never lost.
  function unionLogs(primaryLogs, otherLogs) {
    const out = [], seen = {};
    (primaryLogs || []).forEach(function (l) { if (l) { if (l.id) seen[l.id] = 1; out.push(l); } });
    (otherLogs || []).forEach(function (l) { if (l && l.id && !seen[l.id]) { seen[l.id] = 1; out.push(l); } });
    return out;
  }
  function withUnionedLogs(base, other) {
    const out = Object.assign({}, base);
    out.logs = unionLogs(base.logs, other && other.logs);
    return out;
  }
  // Converge local + cloud to ONE agreed truth. A recipe keeps its LOCAL copy only if it is
  // `pending` (a genuine unsynced local edit or delete); every other recipe takes the CLOUD copy,
  // so all devices agree instead of each clinging to its own stale version. `everSeen` tells a
  // brand-new local recipe (never in the cloud -> keep + push) from one deleted on another device.
  function mergeSets(local, cloudById, pendingSet, everSeenSet) {
    const localById = {};
    (local || []).forEach(function (r) { if (r && r.id) localById[r.id] = r; });
    const out = [], needPush = [], ids = {};
    Object.keys(localById).forEach(function (id) { ids[id] = 1; });
    Object.keys(cloudById || {}).forEach(function (id) { ids[id] = 1; });
    Object.keys(ids).forEach(function (id) {
      const l = localById[id], c = (cloudById || {})[id];
      if (pendingSet[id] && !l) return;   // a pending local delete -> stay deleted (don't resurrect from cloud)
      // Keep the LOCAL copy when it's a real edit we must not lose: an unsynced change this session
      // (pending), OR a genuinely newer edit than the cloud (by updatedAt — e.g. a note added just
      // before a refresh that hadn't finished uploading). Those also get pushed up so devices converge.
      const localNewer = l && c && (l.updatedAt || 0) > (c.updatedAt || 0);
      if (l && (pendingSet[id] || localNewer)) {
        out.push(c ? withUnionedLogs(l, c) : l); needPush.push(id);
      } else if (c) {
        // converge to the cloud's version for recipe fields, but NEVER drop a bake that lives only in the
        // local copy (e.g. a bake logged here that hasn't reached the cloud, without a newer updatedAt).
        const merged = l ? withUnionedLogs(c, l) : c;
        out.push(merged);
        if (l && JSON.stringify(merged) !== JSON.stringify(c)) needPush.push(id);   // local had an extra bake -> send it up
      } else if (l && !everSeenSet[id]) {
        out.push(l); needPush.push(id);               // brand-new local recipe (never in cloud) -> keep + push
      }
      // else: was in the cloud before, now gone, not newer, not pending -> deleted elsewhere -> drop
    });
    return { merged: out, needPush: needPush };
  }

  // ---------- live listener: cloud -> local, and re-render the open page ----------
  let migrated = false;
  let legacy = null; // the old users/{uid} doc (recipes array + categories), read once for migration
  function startListener() {
    if (unsub) { unsub(); unsub = null; }
    unsub = recipesCol().onSnapshot(async function (snap) {
      const cloudById = {};
      snap.forEach(function (doc) { cloudById[doc.id] = doc.data(); });

      // one-time migration: cloud empty but the old single-doc has recipes -> copy them up
      if (!migrated && Object.keys(cloudById).length === 0 && legacy && Array.isArray(legacy.recipes) && legacy.recipes.length) {
        migrated = true;
        try { await migrateLegacy(legacy.recipes); } catch (e) { console.error("bakebook: migration failed —", e); }
        return; // the migration writes trigger another snapshot we'll handle normally
      }
      migrated = true;

      applyCloud(cloudById);
      finishReady();
    }, function (err) {
      console.error("bakebook: live sync error —", err);
      showSyncError(err && err.message ? err.message : String(err));
      finishReady(); // don't hang the page if the listener errors
    });
  }

  function applyCloud(cloudById) {
    const res = mergeSets(getLocalRecipes(), cloudById, pending, everSeen);
    // Record every recipe the cloud currently holds as "last pushed". Without this, a recipe that
    // arrived FROM the cloud (made in an earlier session) isn't in lastPushedJson, so deleting it
    // never issues a cloud delete AND never marks it pending — the live listener then resurrects it
    // on the next snapshot/refresh. Seeding it here makes cloud-origin deletes actually stick.
    Object.keys(cloudById).forEach(function (id) { everSeen[id] = 1; lastPushedJson[id] = JSON.stringify(cloudById[id]); });
    setSeenRecipes(Object.keys(everSeen));   // persist so a reload can tell a deleted recipe from a brand-new one
    // a tombstoned recipe the cloud no longer has = the delete is confirmed → forget the tombstone.
    const tomb = getTombstones();
    const stillTomb = tomb.filter(function (id) { if (!cloudById[id]) { delete pending[id]; return false; } return true; });
    if (stillTomb.length !== tomb.length) setTombstones(stillTomb);
    setLocalRecipes(res.merged);
    if (res.needPush.length || Object.keys(pending).length) schedulePush(); // push new/unsynced/newer recipes up
    fireChange();
  }

  function fireChange() {
    changeCbs.forEach(function (cb) { try { cb(); } catch (e) {} });
  }
  function finishReady() {
    if (!ready) { ready = true; readyCbs.splice(0).forEach(function (cb) { try { cb(); } catch (e) {} }); }
  }

  // ---------- migration: old single-doc array -> per-recipe docs ----------
  async function migrateLegacy(recipes) {
    for (const r of recipes) { if (r && r.id) await uploadRecipePhotos(r); }
    const batch = db.batch();
    recipes.forEach(function (r) {
      if (r && r.id) { batch.set(recipesCol().doc(r.id), r); lastPushedJson[r.id] = JSON.stringify(r); everSeen[r.id] = 1; }
    });
    await batch.commit();
    // seed the merged set locally too, so the page has data immediately
    const m = {}; recipes.forEach(function (r) { if (r && r.id) m[r.id] = r; });
    setLocalRecipes(mergeSets(getLocalRecipes(), m, pending, everSeen).merged);
    fireChange();
  }

  // ---------- push: local -> cloud, per changed recipe ----------
  async function pushToCloud() {
    if (!uid) return;
    if (pushing) { schedulePush(); return; }
    pushing = true;
    const seqAtStart = changeSeq;
    try {
      const local = getLocalRecipes();
      for (const r of local) { if (r && r.id) await uploadRecipePhotos(r); } // base64 -> URLs (async)
      // if an edit landed while we were uploading photos, this snapshot is stale — redo later
      if (changeSeq !== seqAtStart) { schedulePush(); return; }
      setLocalRecipes(local); // cache now holds the smaller URL version

      const localById = {};
      local.forEach(function (r) { if (r && r.id) localById[r.id] = r; });

      const batch = db.batch();
      let writes = 0;
      // upsert changed recipes
      local.forEach(function (r) {
        if (!r || !r.id) return;
        const json = JSON.stringify(r);
        if (lastPushedJson[r.id] !== json) { batch.set(recipesCol().doc(r.id), r); lastPushedJson[r.id] = json; writes++; }
      });
      // delete recipes removed locally (present last push, gone now)
      Object.keys(lastPushedJson).forEach(function (id) {
        if (!localById[id]) { batch.delete(recipesCol().doc(id)); delete lastPushedJson[id]; writes++; }
      });
      if (writes) await batch.commit();
      // these edits are now confirmed in the cloud — they're no longer "pending", so the cloud is
      // free to become the agreed truth for them again.
      if (changeSeq === seqAtStart) { Object.keys(pending).forEach(function (id) { delete pending[id]; }); }

      // categories live in their own client-writable doc
      await metaDoc().set({ categories: getLocalCategories() }, { merge: true });

      hideSyncError();
      if (changeSeq !== seqAtStart) schedulePush(); // a change slipped in during the network write
    } catch (e) {
      console.error("bakebook: cloud sync failed —", e);
      showSyncError(e && e.message ? e.message : String(e));
    } finally {
      pushing = false;
    }
  }

  // ---------- public ----------
  window.bakebookWhenReady = function (cb) { if (ready) { try { cb(); } catch (e) {} } else { readyCbs.push(cb); } };
  window.bakebookOnChange = function (cb) { if (typeof cb === "function") changeCbs.push(cb); };
  window.bakebookFlush = function () { clearTimeout(pushTimer); return pushToCloud(); };
  // Undo support: when a just-deleted recipe is put back, forget its tombstone so the "cloud wins"
  // merge doesn't re-delete it. The caller re-adds the recipe to localStorage, which re-pushes it
  // to the cloud as a normal recipe.
  window.bakebookForgetDeletes = function (ids) {
    const set = {}; (ids || []).forEach(function (id) { if (id) set[id] = 1; });
    const tomb = getTombstones().filter(function (id) { return !set[id]; });
    if (tomb.length !== getTombstones().length) setTombstones(tomb);
    // NOTE: we leave `pending` alone on purpose — the restore re-saves the recipe to localStorage,
    // which re-flags it pending (so the merge keeps it and pushes it back up). Clearing it here would
    // risk the recipe being dropped if the cloud delete had already landed.
  };

  auth.onAuthStateChanged(async function (user) {
    if (unsub) { unsub(); unsub = null; }
    if (!user) { uid = null; ready = false; clearTimeout(pushTimer); return; }
    uid = user.uid;
    ready = false; migrated = false; legacy = null;
    Object.keys(everSeen).forEach(function (k) { delete everSeen[k]; });
    Object.keys(lastPushedJson).forEach(function (k) { delete lastPushedJson[k]; });
    Object.keys(pending).forEach(function (k) { delete pending[k]; });

    // localStorage is shared by the whole browser. If the cache belongs to a DIFFERENT account,
    // wipe it before loading this user's data (prevents cross-account bleed).
    if (localStorage.getItem(OWNER_KEY) !== uid) {
      internalWrite = true;
      localStorage.removeItem(RECIPES_KEY);
      localStorage.removeItem(CATS_KEY);
      localStorage.removeItem(TOMB_KEY);   // tombstones are per-account too
      localStorage.removeItem(CATS_TOMB_KEY);
      localStorage.removeItem(SEEN_CATS_KEY);
      localStorage.removeItem(SEEN_RECIPES_KEY);
      rawSetItem(OWNER_KEY, uid);
      internalWrite = false;
    }
    lastCats = [];
    // Re-arm any delete that hadn't finished syncing before the last refresh: mark it pending so the
    // merge keeps it deleted (instead of "cloud wins" resurrecting it) and the next push removes it.
    getTombstones().forEach(function (id) { pending[id] = 1; });
    // Restore the "ever seen in the cloud" recipe ids from the last session. Without this, a fresh page
    // load has an empty `everSeen`, so a recipe still in the local cache but already deleted from the cloud
    // looks brand-new and gets re-uploaded — resurrecting a delete made on another device.
    getSeenRecipes().forEach(function (id) { everSeen[id] = 1; });

    // read the legacy single-doc once (for migration + to seed categories), then start live sync
    try {
      const snap = await db.collection("users").doc(uid).get();
      legacy = (snap.exists && snap.data()) ? snap.data() : {};
      const metaSnap = await metaDoc().get();
      const cloudCats = (metaSnap.exists && Array.isArray(metaSnap.data().categories))
        ? metaSnap.data().categories
        : (Array.isArray(legacy.categories) ? legacy.categories : []);
      // converge to the cloud (drop categories deleted on another device) instead of unioning them back
      const catTomb = getCatTombstones();
      const seenBefore = getSeenCats();
      const mergedCats = convergeCats(getLocalCategories(), cloudCats, catTomb, seenBefore);
      setLocalCategories(mergedCats);
      setSeenCats(unionCats(seenBefore, cloudCats));   // remember everything the cloud has ever shown us
      lastCats = mergedCats.slice();
      // a tombstoned category the cloud no longer has = delete confirmed → forget the tombstone
      const keptTomb = catTomb.filter(function (c) { return cloudCats.indexOf(c) !== -1; });
      if (keptTomb.length !== catTomb.length) setCatTombstones(keptTomb);
      // if our converged list differs from the cloud's, push it so every device agrees
      if (mergedCats.slice().sort().join("|") !== cloudCats.slice().sort().join("|")) schedulePush();
    } catch (e) { console.error("bakebook: initial read failed —", e); }

    startListener();
  });
})();
