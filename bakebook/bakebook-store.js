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
//   bakebookOnRemoteChange(fn) -> fn(ids) runs when recipes changed in the cloud because of ANOTHER device
//                                 (never for this device's own saves coming back)
//
// Saves send only the parts of a recipe that changed (its name, its photos, its components...), not the
// whole recipe, so an edit to one part on another device survives. Every write also carries the server's
// clock (serverUpdatedAt) and which device made it (lastDevice).
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
  const DEVICE_KEY = "bakebook.deviceId"; // a random id made once per device, so we can tell our own saves
                                          // from another device's when a change comes back from the cloud
  const PARTS_KEY = "bakebook.changedParts"; // recipe id -> names of the parts (name, photos...) changed on THIS
                                             // device and not yet confirmed in the cloud. Kept on the device so a
                                             // page change or reload still knows which parts are ours: the next page
                                             // keeps only those and takes every other part from the cloud.
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
  const confirmedJson = {};     // id -> JSON of the recipe as the SERVER last confirmed it, with none of our own
                                // unsent writes mixed in. This is the starting point the part-by-part merge compares
                                // against. It must not include a write the server might still reject: if it did, and
                                // the write was rejected, the merge would think our edit was already in the cloud and
                                // throw it away for the cloud's old value.
  const pending = {};           // recipe ids with a LOCAL edit not yet confirmed in the cloud. These (and only
                                // these) keep the local copy over the cloud copy — everything else converges to
                                // the cloud, so devices agree on one truth instead of each clinging to its own.
  const deleting = {};          // recipe ids whose cloud delete has been SENT but not yet accepted by the server.
                                // Firestore shows our own delete straight away, before the server has it
                                // ("latency compensation"), and that early snapshot looks exactly like a
                                // confirmed delete. This set is how we tell the two apart.
  let wroteBeforeSignIn = false; // a page saved recipes before Firebase confirmed who is signed in
  const cloudHas = {};          // recipe ids the cloud holds right now (from the latest snapshot, plus ones we
                                // just wrote). Only these can take a "change just these parts" write: that kind
                                // of write fails if the recipe isn't there, so anything else is written whole.
  let remoteCbs = [];           // pages that want to know when a recipe changed on another device
  let firstSnap = true;         // the listener's first snapshot is just "everything that exists", not a change
  let serverSnap = false;       // has the SERVER itself sent a snapshot since sign-in? (Offline, a fresh page only
                                // gets an empty copy from the device's memory, which says nothing about the cloud.)

  // The real, untouched save method. Every storage object (localStorage, sessionStorage) inherits its
  // methods from one shared blueprint, `Storage.prototype`. We keep a reference to the original method
  // from that blueprint BEFORE we replace it below, so the store's own cache writes can call it directly
  // and never re-enter our hook (that plus `internalWrite` is the guarantee against a push loop).
  const nativeSetItem = Storage.prototype.setItem;
  const rawSetItem = function (key, value) { return nativeSetItem.call(localStorage, key, value); };
  // What each recipe looked like when this page opened, before anyone touched it. The home page paints
  // from the local copy BEFORE Firebase confirms the sign-in, so a tap in that first moment (an undo, a
  // delete) is a real edit we must not lose. Once sign-in confirms we compare against this to find them.
  const bootJson = {};
  try {
    (JSON.parse(localStorage.getItem(RECIPES_KEY)) || []).forEach(function (r) { if (r && r.id) bootJson[r.id] = JSON.stringify(r); });
  } catch (e) {}
  // Older builds tried `localStorage.setItem = function…`. On WebKit (every iPhone, the iOS app, Safari)
  // that does not replace the method: it stores a data item literally named "setItem" whose value is the
  // function's source text. Remove that junk item if it is there (harmless if absent). removeItem is not
  // hooked, so calling the blueprint's version directly just deletes the item and nothing else fires.
  try { Storage.prototype.removeItem.call(localStorage, "setItem"); } catch (e) {}
  // This device's id. Made once and kept, so it stays the same across reloads and sign-ins. Stored with
  // rawSetItem because it isn't recipe data (it must never trigger a sync).
  let deviceId = null;
  try { deviceId = localStorage.getItem(DEVICE_KEY); } catch (e) {}
  if (!deviceId) {
    deviceId = "d" + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    try { rawSetItem(DEVICE_KEY, deviceId); } catch (e) {}
  }

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
  // the parts changed here per recipe (see PARTS_KEY): { recipeId: ["description", "updatedAt"], ... }
  function getChangedParts() {
    try { const p = JSON.parse(localStorage.getItem(PARTS_KEY)); return (p && typeof p === "object" && !Array.isArray(p)) ? p : {}; } catch (e) { return {}; }
  }
  function setChangedParts(p) { internalWrite = true; rawSetItem(PARTS_KEY, JSON.stringify(p)); internalWrite = false; }
  // forget the noted parts of these recipes (their edits are confirmed in the cloud, or they're gone)
  function forgetChangedParts(ids) {
    const p = getChangedParts();
    let changed = false;
    ids.forEach(function (id) { if (p[id]) { delete p[id]; changed = true; } });
    if (changed) setChangedParts(p);
  }
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
  // Hooked on the shared blueprint (Storage.prototype), NOT on the localStorage object itself. Assigning
  // `localStorage.setItem = …` silently fails on WebKit (see the note by rawSetItem), which meant iPhone
  // saves never scheduled a push, never wrote tombstones, and a delete could come back from the cloud.
  // The blueprint is shared with sessionStorage, so `this` says which storage was written; only
  // localStorage writes to the recipes or categories keys matter, everything else passes straight through.
  Storage.prototype.setItem = function (key, value) {
    nativeSetItem.call(this, key, value);
    if (this !== localStorage) return;
    if ((key === RECIPES_KEY || key === CATS_KEY) && !internalWrite) {
      // not signed in yet (Firebase is still confirming): we can't push now, but remember that a
      // save happened so the sign-in handler picks it up instead of letting the cloud copy win.
      if (!uid) { if (key === RECIPES_KEY) { wroteBeforeSignIn = true; noteChangedParts(); noteEarlyDeletes(); } return; }
      changeSeq++;
      if (key === RECIPES_KEY) markPending();
      if (key === CATS_KEY) markCatDeletes();
      schedulePush();
    }
  };
  function schedulePush() { clearTimeout(pushTimer); pushTimer = setTimeout(pushToCloud, 700); }

  // A delete made before sign-in confirms. Normally the sign-in handler finds it (markPending) and writes
  // its "deleted here" note (a tombstone). But the recipe page goes home straight after a delete, so the
  // sign-in handler on that page never runs, and the home page opens without the recipe and without a note.
  // The cloud copy then brought it back. So write the note NOW, for every recipe this page opened with
  // (bootJson) that the new list no longer has. Only those: a recipe that was never on this page's list
  // can't have been deleted here. The note is kept on the device, and the next page's sign-in re-arms it.
  // If that sign-in turns out to be a different account, the account switch wipes the notes with the rest
  // of the old account's data, so a note can never delete another account's recipe.
  function noteEarlyDeletes() {
    const ids = Object.keys(bootJson);
    if (!ids.length) return;
    const now = {};
    getLocalRecipes().forEach(function (r) { if (r && r.id) now[r.id] = 1; });
    const tomb = getTombstones();
    let changed = false;
    ids.forEach(function (id) { if (!now[id] && tomb.indexOf(id) === -1) { tomb.push(id); changed = true; } });
    if (changed) setTombstones(tomb);
  }

  // Flag every recipe whose local copy differs from what we last pushed (a real unsynced edit),
  // plus any recipe deleted locally. Only pending recipes keep local over cloud.
  function markPending() {
    const local = getLocalRecipes();
    const seen = {};
    // Which recipes did this device know about, and how did they look? Normally the ones from the last sync
    // (lastPushedJson). But until this page's first cloud snapshot arrives, that list is empty: a slow
    // connection can take a few seconds, and a recipe deleted in that gap was not seen as a delete at all
    // (no tombstone), so it came back from the cloud later. Until then, the copy this page opened with
    // (bootJson) counts as well.
    // Offline, the first snapshot comes from the device's memory, not the server, and says nothing about
    // these recipes, so the copy this page opened with keeps counting until the server itself has answered.
    // It is also what an edit is measured against: without it every recipe looked edited here, and a recipe
    // deleted on another device in the meantime was sent back up whole instead of going away.
    const known = Object.assign({}, serverSnap ? {} : bootJson, lastPushedJson);
    local.forEach(function (r) {
      if (r && r.id) { seen[r.id] = 1; if (known[r.id] !== JSON.stringify(r)) pending[r.id] = 1; }
    });
    const tomb = getTombstones();
    let tombChanged = false;
    Object.keys(known).forEach(function (id) {                          // present last sync, gone now = deleted here
      if (!seen[id]) { pending[id] = 1; if (tomb.indexOf(id) === -1) { tomb.push(id); tombChanged = true; } }
    });
    if (tombChanged) setTombstones(tomb);   // persist the delete so a refresh can't resurrect it
    noteChangedParts(local);
  }
  // Write down which parts of each recipe this save changed, kept on the device (PARTS_KEY). Compared with the
  // recipe as the server last confirmed it; failing that, what we last sent; failing that, the copy this page
  // opened with. Added to the list already there, never replacing it: a part changed on an earlier page still
  // counts until the cloud confirms it. A recipe with nothing to compare against is brand-new and is written
  // whole anyway, so it needs no list. A recipe no longer on the device drops off (a delete has its own record).
  function noteChangedParts(local) {
    local = local || getLocalRecipes();
    const was = getChangedParts(), now = {};
    local.forEach(function (r) {
      if (!r || !r.id) return;
      const names = (was[r.id] || []).slice();
      const json = JSON.stringify(r);
      const baseJson = confirmedJson[r.id] || lastPushedJson[r.id] || bootJson[r.id];
      // quick way out: identical to a copy we already know about means nothing new changed here
      if (baseJson && json !== confirmedJson[r.id] && json !== lastPushedJson[r.id] && json !== bootJson[r.id]) {
        let base = null; try { base = cloudSafe(JSON.parse(baseJson)); } catch (e) {}
        const safe = cloudSafe(r);
        if (base) Object.keys(base).concat(Object.keys(safe)).forEach(function (k) {
          if (names.indexOf(k) === -1 && !sameValue(base[k], safe[k])) names.push(k);
        });
      }
      if (names.length) now[r.id] = names;
    });
    if (JSON.stringify(now) !== JSON.stringify(was)) setChangedParts(now);
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
  // has that primary lacks (a bake added on another device) is appended. A bake is never lost,
  // unless it was DELETED: a deleted bake's id goes on the recipe's `deletedLogs` list, and no
  // copy may bring that id back. Without the list, a second device that still held the bake put
  // it back on the next merge (fixed 28 Sep 2026). Undo gives the restored bake a new id, so the
  // list only ever grows and every device agrees on it.
  function unionLogs(primaryLogs, otherLogs, gone) {
    const out = [], seen = {};
    gone = gone || {};
    (primaryLogs || []).forEach(function (l) { if (l && !(l.id && gone[l.id])) { if (l.id) seen[l.id] = 1; out.push(l); } });
    (otherLogs || []).forEach(function (l) { if (l && l.id && !seen[l.id] && !gone[l.id]) { seen[l.id] = 1; out.push(l); } });
    return out;
  }
  // both copies' deleted-bake ids, in a stable order (base's first) so an unchanged list
  // compares equal and doesn't trigger a needless push
  function deletedLogIds(base, other) {
    const list = [], set = {};
    [base, other].forEach(function (r) {
      ((r && Array.isArray(r.deletedLogs)) ? r.deletedLogs : []).forEach(function (id) {
        if (id && !set[id]) { set[id] = 1; list.push(id); }
      });
    });
    return { list: list, set: set };
  }
  function withUnionedLogs(base, other) {
    const out = Object.assign({}, base);
    const gone = deletedLogIds(base, other);
    out.logs = unionLogs(base.logs, other && other.logs, gone.set);
    if (gone.list.length) out.deletedLogs = gone.list;
    return out;
  }
  // Turn a value into text with every object's keys in A-Z order, so two copies with the same content
  // always compare equal (the cloud can hand fields back in a different order than we wrote them).
  function sortKeys(v) {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") { const o = {}; Object.keys(v).sort().forEach(function (k) { o[k] = sortKeys(v[k]); }); return o; }
    return v;
  }
  function sameValue(a, b) {
    if (a === undefined || b === undefined) return a === b;
    return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
  }
  // Part-by-part merge of one recipe. `base` is what this device last knew the cloud held. A part (a
  // top-level field: name, photos, components...) that differs from base was changed HERE, so the local
  // version is kept; every other part takes the cloud's version, so a change another device made to a
  // different part is not thrown away. (Two devices changing the SAME part: this device's wins.)
  function mergeFields(local, cloud, base) {
    const out = {}, keys = {};
    [local, cloud, base].forEach(function (o) { Object.keys(o || {}).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      const v = sameValue(local[k], base[k]) ? cloud[k] : local[k];
      if (v !== undefined) out[k] = v;
    });
    return out;
  }
  // Same idea using a list of part names instead of an old copy: the named parts (changed here) come from the
  // local copy, every other part from the cloud. stepIngredients/stepIngHash only ever live on the device (the
  // cloud never holds them, see cloudSafe), so they stay as they are here.
  function keepParts(local, cloud, names) {
    const out = {}, keys = {};
    [local, cloud].forEach(function (o) { Object.keys(o || {}).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      const mine = names.indexOf(k) !== -1 || k === "stepIngredients" || k === "stepIngHash";
      const v = mine ? local[k] : cloud[k];
      if (v !== undefined) out[k] = v;
    });
    return out;
  }
  // Converge local + cloud to ONE agreed truth. A recipe keeps its LOCAL copy only if it is
  // `pending` (a genuine unsynced local edit or delete); every other recipe takes the CLOUD copy,
  // so all devices agree instead of each clinging to its own stale version. `everSeen` tells a
  // brand-new local recipe (never in the cloud -> keep + push) from one deleted on another device.
  // `baseJsonById` (optional) is each recipe as the server last CONFIRMED it (never including a write of ours
  // it hasn't accepted yet); with it, a kept local copy is merged part by part instead of replacing the
  // cloud's copy whole.
  // `partsById` (optional) is the list kept on the device of which parts were changed here (PARTS_KEY). It is
  // used when there is no confirmed copy to compare with, which is always the case on the first snapshot after
  // a page change or reload.
  // `keepMissing` (optional) is true when the snapshot came only from the device's memory (offline), not from
  // the server. Then a recipe missing from it proves nothing, so it is kept as it is instead of dropped.
  function mergeSets(local, cloudById, pendingSet, everSeenSet, baseJsonById, partsById, keepMissing) {
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
        // Know what the cloud held before? Then keep only the parts changed here and take the rest from
        // the cloud. Just after a page change or reload we don't, so the list of parts changed here (kept on
        // the device) says which to keep. Neither (e.g. a copy saved by an older app build)? Keep the whole
        // local copy, as before.
        let base = null;
        try { if (c && baseJsonById && baseJsonById[id]) base = JSON.parse(baseJsonById[id]); } catch (e) {}
        const names = (c && !base && partsById && Array.isArray(partsById[id])) ? partsById[id] : null;
        let kept;
        // Both paths also keep any bake only this device has, as the "cloud wins" path below does. Without
        // that, a bake another device's write left out (but never deleted) was lost here when this device
        // hadn't touched its bakes, because the parts merge then takes the cloud's bake list.
        if (base) kept = withUnionedLogs(withUnionedLogs(mergeFields(l, c, base), c), l);
        else if (names) kept = withUnionedLogs(withUnionedLogs(keepParts(l, c, names), c), l);
        else kept = c ? withUnionedLogs(l, c) : l;
        out.push(kept); needPush.push(id);
      } else if (c) {
        // converge to the cloud's version for recipe fields, but NEVER drop a bake that lives only in the
        // local copy (e.g. a bake logged here that hasn't reached the cloud, without a newer updatedAt).
        const merged = withUnionedLogs(c, l);   // also drops any deleted bake an older app version put back
        out.push(merged);
        if (l && JSON.stringify(merged) !== JSON.stringify(c)) needPush.push(id);   // local had an extra bake -> send it up
      } else if (l && !everSeenSet[id]) {
        out.push(l); needPush.push(id);               // brand-new local recipe (never in cloud) -> keep + push
      } else if (l && keepMissing) {
        out.push(l);   // offline: only the server can say it was deleted elsewhere -> keep it, send nothing
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
    firstSnap = true; serverSnap = false;
    let gotSnap = false;   // has this listener handled any snapshot yet?
    // includeMetadataChanges: also tell us when only the snapshot's notes change (where it came from, whether
    // our writes are still waiting), not just when a recipe changes. Without it, a page opened offline never
    // learned that the server had answered when the server's copy matched the device's copy exactly: no
    // recipe changed, so no update came, and the page kept waiting for the server (see serverSnap).
    unsub = recipesCol().onSnapshot({ includeMetadataChanges: true }, async function (snap) {
      // Notes-only update (no recipe added, changed or removed). These come often, e.g. each time the server
      // accepts one of our writes. Only one matters: the first answer from the server itself, after copies
      // from the device's memory. That one goes through the full step below, quietly (pages re-render only if
      // the merge really changed the local copy). Every other notes-only update is ignored: nothing to merge,
      // nothing to send, nothing to re-render.
      const metaOnly = gotSnap && snap.docChanges().length === 0;
      if (metaOnly && (serverSnap || snap.metadata.fromCache)) return;
      gotSnap = true;
      const cloudById = {};
      const unconfirmed = {};   // recipes this snapshot shows with one of our own writes the server hasn't accepted yet
      snap.forEach(function (doc) {
        // serverUpdatedAt and lastDevice are notes ABOUT the save, not part of the recipe. Keep them out of
        // the local copy so they never count as an edit or get compared field by field.
        const d = doc.data(); delete d.serverUpdatedAt; delete d.lastDevice;
        cloudById[doc.id] = d;
        if (doc.metadata.hasPendingWrites) unconfirmed[doc.id] = 1;
      });
      // Which recipes just changed because of ANOTHER device? Skip the first snapshot (that is just "what
      // exists"), and skip anything still carrying our own unsent write. Everything else counts unless it
      // is our own save coming back (see isOwnSave).
      const remoteIds = [];
      if (!firstSnap) {
        snap.docChanges().forEach(function (ch) {
          if (ch.type === "removed" || ch.doc.metadata.hasPendingWrites) return;
          if (!isOwnSave(ch.doc)) remoteIds.push(ch.doc.id);
        });
      }
      if (!snap.metadata.fromCache) { firstSnap = false; serverSnap = true; }   // a copy from the device's cache doesn't count as "what exists"

      // one-time migration: cloud empty but the old single-doc has recipes -> copy them up
      if (!migrated && Object.keys(cloudById).length === 0 && legacy && Array.isArray(legacy.recipes) && legacy.recipes.length) {
        migrated = true;
        try { await migrateLegacy(legacy.recipes); } catch (e) { console.error("bakebook: migration failed —", e); }
        return; // the migration writes trigger another snapshot we'll handle normally
      }
      migrated = true;

      // A snapshot straight from the server, with none of our own writes still waiting, is the only kind
      // that can confirm a delete. `metadata` is the SDK's note about where the snapshot came from.
      const confirmed = !!(snap.metadata && !snap.metadata.hasPendingWrites && !snap.metadata.fromCache);
      applyCloud(cloudById, confirmed, unconfirmed, !!(snap.metadata && snap.metadata.fromCache), metaOnly);
      if (remoteIds.length) fireRemoteChange(remoteIds);   // after applyCloud, so pages already have the new copy
      finishReady();
    }, function (err) {
      console.error("bakebook: live sync error —", err);
      showSyncError(err && err.message ? err.message : String(err));
      finishReady(); // don't hang the page if the listener errors
    });
  }

  // Is this cloud copy our own save coming back? Two things must both be true:
  //  1. lastDevice is this device, and
  //  2. serverUpdatedAt is a real server clock stamp.
  // Why both: an older app build (the phone versions in the store today) keeps the whole cloud copy on the
  // phone, these two notes included, and later writes that whole copy back. So its write can still say
  // lastDevice = this device. But its serverUpdatedAt has been through the phone's text storage and comes back
  // as a plain {seconds, nanoseconds} bundle, while a save from this version always carries the server's real
  // stamp (an object with a toMillis method). That plain bundle is how we spot the older build's write.
  function isOwnSave(doc) {
    if (doc.get("lastDevice") !== deviceId) return false;
    const t = doc.get("serverUpdatedAt");
    return !!(t && typeof t.toMillis === "function");
  }

  // `cacheOnly`: this snapshot came from the device's memory, not the server (offline). It can be empty or
  // partial, so a recipe missing from it is NOT treated as gone: nothing is dropped or forgotten because of it.
  // Recipes it does hold merge as usual. The server's first snapshot then settles everything.
  // `quiet`: the snapshot changed no recipe (only its notes changed, see startListener). Then pages are told
  // to re-render only if this merge really changed the local copy.
  function applyCloud(cloudById, confirmed, unconfirmed, cacheOnly, quiet) {
    unconfirmed = unconfirmed || {};
    const localBefore = quiet ? localStorage.getItem(RECIPES_KEY) : null;
    const res = mergeSets(getLocalRecipes(), cloudById, pending, everSeen, confirmedJson, getChangedParts(), cacheOnly);
    // remember exactly which recipes the cloud holds now (a recipe deleted elsewhere drops out here)
    if (!cacheOnly) Object.keys(cloudHas).forEach(function (id) { if (!cloudById[id]) delete cloudHas[id]; });
    Object.keys(cloudById).forEach(function (id) { cloudHas[id] = 1; });
    // Record every recipe the cloud currently holds as "last pushed". Without this, a recipe that
    // arrived FROM the cloud (made in an earlier session) isn't in lastPushedJson, so deleting it
    // never issues a cloud delete AND never marks it pending — the live listener then resurrects it
    // on the next snapshot/refresh. Seeding it here makes cloud-origin deletes actually stick.
    // A recipe that still carries one of our own unaccepted writes only fills a gap here: what we sent is
    // already noted in lastPushedJson, and it is NOT a confirmed starting point for the merge (see confirmedJson).
    if (!cacheOnly) Object.keys(confirmedJson).forEach(function (id) { if (!cloudById[id]) delete confirmedJson[id]; });
    Object.keys(cloudById).forEach(function (id) {
      // A recipe counts as "seen in the cloud" only once the server has accepted it. A new recipe we just
      // sent shows up here at once, before the server has it; if the page closes and that send is lost,
      // the next page must still treat it as new (keep it and send it), not as deleted on another device.
      if (!unconfirmed[id] || everSeen[id]) everSeen[id] = 1;
      const json = JSON.stringify(cloudById[id]);
      if (!unconfirmed[id]) { confirmedJson[id] = json; lastPushedJson[id] = json; }
      else if (lastPushedJson[id] === undefined) lastPushedJson[id] = json;
    });
    setSeenRecipes(Object.keys(everSeen));   // persist so a reload can tell a deleted recipe from a brand-new one
    // A tombstoned recipe the cloud no longer has = the delete is confirmed → forget the tombstone.
    // BUT only when this snapshot really came from the server AND the delete is not one we sent
    // ourselves that the server has not accepted yet (`deleting`). Firestore removes the recipe from
    // the snapshot the instant we ask for the delete, even offline, so without these two checks an
    // offline delete looked confirmed, the tombstone was dropped, and the recipe came back once the
    // device was online again. Deletes we sent are confirmed in pushToCloud, when the server says so.
    const tomb = getTombstones();
    const stillTomb = tomb.filter(function (id) {
      if (confirmed && !cloudById[id] && !deleting[id]) { delete pending[id]; return false; }
      return true;
    });
    if (stillTomb.length !== tomb.length) setTombstones(stillTomb);
    setLocalRecipes(res.merged);
    if (res.needPush.length || Object.keys(pending).length) schedulePush(); // push new/unsynced/newer recipes up
    if (!quiet || localStorage.getItem(RECIPES_KEY) !== localBefore) fireChange();
  }

  function fireChange() {
    changeCbs.forEach(function (cb) { try { cb(); } catch (e) {} });
  }
  function fireRemoteChange(ids) {
    remoteCbs.forEach(function (cb) { try { cb(ids.slice()); } catch (e) {} });
  }
  function finishReady() {
    if (!ready) { ready = true; readyCbs.splice(0).forEach(function (cb) { try { cb(); } catch (e) {} }); }
  }

  // stepIngredients is a derived LOCAL cache shaped as an array-of-arrays (each step's ingredient
  // indices, e.g. [[0,1],[2]]). Firestore rejects arrays that contain arrays ("nested arrays are not
  // supported"), so strip it (and its hash) from anything written to the cloud — cook mode recomputes
  // it on save per device, so it never needs to sync.
  // serverUpdatedAt and lastDevice are stripped too: a copy an older app build kept on this device can still
  // carry old ones, and every write stamps fresh ones anyway (saveStamp).
  function cloudSafe(r) {
    if (r && (r.stepIngredients !== undefined || r.stepIngHash !== undefined ||
              r.serverUpdatedAt !== undefined || r.lastDevice !== undefined)) {
      const c = Object.assign({}, r);
      delete c.stepIngredients; delete c.stepIngHash;
      delete c.serverUpdatedAt; delete c.lastDevice;
      return c;
    }
    return r;
  }

  // Stamped on every recipe write: the server's own clock (a device with a wrong clock can't make an old
  // edit look new) and which device saved it. The numeric updatedAt stays as it is: older app builds use it.
  // applyCloud relies on this: every save carries the server stamp, so a save the server has not yet
  // accepted shows up as unconfirmed, and a new recipe is not counted as "seen in the cloud" until it is.
  function saveStamp() {
    return { serverUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(), lastDevice: deviceId };
  }
  // The "change just these parts" write for a recipe the cloud already has. Compares what we last knew the
  // cloud held (`base`) with the local copy and returns only the parts that differ (a part removed here is
  // removed in the cloud too), or null if nothing really changed.
  // Bakes get extra care: if the only change is NEW bakes added at the end, they are sent as "add these to
  // the list" (arrayUnion) instead of a whole new list. The server adds them to whatever list it has, so a
  // bake another device logged a moment ago, that we haven't received yet, is not wiped. This works
  // offline too: the write waits in the queue and the server applies it when it arrives. The same goes
  // for new ids on the deleted-bakes list. (Any other bake change, like an edit or a delete, sends the
  // whole list; a bake that briefly goes missing that way is put back by the device that still has it,
  // through the bake merge in mergeSets, the same as before.)
  function changedParts(base, safe) {
    const FV = firebase.firestore.FieldValue;
    const out = {}, keys = {};
    let any = false;
    Object.keys(base).concat(Object.keys(safe)).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      if (sameValue(base[k], safe[k])) return;
      any = true;
      if (safe[k] === undefined) { out[k] = FV.delete(); return; }
      if (k === "logs" && Array.isArray(safe.logs)) {
        const was = Array.isArray(base.logs) ? base.logs : [];
        const wasIds = {};
        was.forEach(function (l) { if (l && l.id) wasIds[l.id] = 1; });
        const added = safe.logs.slice(was.length);
        const onlyAdded = safe.logs.length > was.length &&
          was.every(function (l, i) { return sameValue(l, safe.logs[i]); }) &&
          added.every(function (l) { return l && l.id && !wasIds[l.id]; });
        out.logs = onlyAdded ? FV.arrayUnion.apply(null, added) : safe.logs;
        return;
      }
      if (k === "deletedLogs" && Array.isArray(safe.deletedLogs)) {
        const was = Array.isArray(base.deletedLogs) ? base.deletedLogs : [];
        const keptAll = was.every(function (id) { return safe.deletedLogs.indexOf(id) !== -1; });
        const added = safe.deletedLogs.filter(function (id) { return was.indexOf(id) === -1; });
        out.deletedLogs = (keptAll && added.length) ? FV.arrayUnion.apply(null, added) : safe.deletedLogs;
        return;
      }
      out[k] = safe[k];
    });
    return any ? out : null;
  }

  // ---------- migration: old single-doc array -> per-recipe docs ----------
  async function migrateLegacy(recipes) {
    for (const r of recipes) { if (r && r.id) await uploadRecipePhotos(r); }
    const batch = db.batch();
    recipes.forEach(function (r) {
      if (r && r.id) { const safe = cloudSafe(r); batch.set(recipesCol().doc(r.id), Object.assign({}, safe, saveStamp())); lastPushedJson[r.id] = JSON.stringify(safe); everSeen[r.id] = 1; cloudHas[r.id] = 1; }
    });
    await batch.commit();
    // seed the merged set locally too, so the page has data immediately
    const m = {}; recipes.forEach(function (r) { if (r && r.id) m[r.id] = r; });
    setLocalRecipes(mergeSets(getLocalRecipes(), m, pending, everSeen).merged);
    fireChange();
  }

  // ---------- push: local -> cloud, per changed recipe ----------
  // Each recipe is sent as its OWN write, not one all-or-nothing bundle. Why: a "change just these parts"
  // write fails if the recipe was deleted on another device in the meantime, and in a bundle that one failure
  // would throw back every other recipe's edit too. On its own, only that one recipe fails, and it is sent
  // again whole on the next try.
  async function pushToCloud() {
    if (!uid) return;
    // Wait for the first cloud snapshot: until it arrives we don't know what the cloud holds, so every
    // recipe would look new and be written whole, over whatever another device changed. (`ready` also
    // turns true if the live listener fails, so this can't wait forever.)
    if (!ready) { schedulePush(); return; }
    if (pushing) { schedulePush(); return; }
    pushing = true;
    const seqAtStart = changeSeq;
    const jobs = [];       // one entry per recipe write or delete: what to send, and what to put back if it fails
    let answered = false;  // true once every write has had its answer (success or failure) handled below
    // A write that failed: forget that we "sent" it, so the next push tries it again. Skipped when a newer
    // cloud snapshot has already replaced what we noted (compared by content, not exact text, because the
    // cloud can hand the same recipe back with its fields in a different order).
    function undoJob(j) {
      if (j.del) { delete deleting[j.id]; return; }
      let same = false;
      try { same = sameValue(JSON.parse(lastPushedJson[j.id]), JSON.parse(j.json)); } catch (e) { same = false; }
      if (same) { if (j.before === undefined) delete lastPushedJson[j.id]; else lastPushedJson[j.id] = j.before; }
      if (!j.had) delete cloudHas[j.id];
    }
    try {
      const local = getLocalRecipes();
      for (const r of local) { if (r && r.id) await uploadRecipePhotos(r); } // base64 -> URLs (async)
      // if an edit landed while we were uploading photos, this snapshot is stale — redo later
      if (changeSeq !== seqAtStart) { schedulePush(); return; }
      setLocalRecipes(local); // cache now holds the smaller URL version

      const localById = {};
      local.forEach(function (r) { if (r && r.id) localById[r.id] = r; });

      // upsert changed recipes: a recipe the cloud already has gets ONLY its changed parts; a recipe the
      // cloud has never had (or no longer has) is written whole.
      // A recipe with parts noted as changed here waits until the server itself has said what the cloud holds.
      // Offline, a fresh page only has an empty copy in memory, so the recipe would look new and be written
      // whole, over whatever another device changed in the meantime. It stays pending (and its list stays
      // on the device), and the server's first snapshot sends it with only its own parts.
      const heldIds = {};
      const noted = serverSnap ? {} : getChangedParts();
      // A recipe deleted here before the server has answered can't be deleted in the cloud yet (we only send a
      // delete for a recipe we know the cloud has). It stays pending, so the server's first snapshot doesn't
      // bring it back, and the push after that snapshot sends the delete.
      if (!serverSnap) Object.keys(pending).forEach(function (id) { if (!localById[id] && lastPushedJson[id] === undefined) heldIds[id] = 1; });
      local.forEach(function (r) {
        if (!r || !r.id) return;
        if (noted[r.id]) { heldIds[r.id] = 1; return; }
        // Same for a recipe kept from before because an offline snapshot said nothing about it: it was in the
        // cloud once, but we don't know what the cloud holds for it now (it may even be deleted elsewhere).
        // Written whole, it could undo another device's change or bring a deleted recipe back. It waits too.
        if (!serverSnap && everSeen[r.id] && lastPushedJson[r.id] === undefined) { heldIds[r.id] = 1; return; }
        const safe = cloudSafe(r);
        const json = JSON.stringify(safe);
        const before = lastPushedJson[r.id];
        if (before === json) return;
        const ref = recipesCol().doc(r.id);
        if (before !== undefined && cloudHas[r.id]) {
          let parts = null;
          try { parts = changedParts(JSON.parse(before), safe); } catch (e) { parts = null; }
          if (!parts) { lastPushedJson[r.id] = json; return; }   // same content, only the order differed
          const data = Object.assign(parts, saveStamp());
          jobs.push({ id: r.id, before: before, json: json, had: true, run: function () { return ref.update(data); } });
        } else {
          const data = Object.assign({}, safe, saveStamp());
          jobs.push({ id: r.id, before: before, json: json, had: !!cloudHas[r.id], run: function () { return ref.set(data); } });
          cloudHas[r.id] = 1;
        }
        lastPushedJson[r.id] = json;
      });
      // delete recipes removed locally (present last push, gone now). We keep them in `lastPushedJson`
      // and note them in `deleting` until the server has accepted the delete: if the page closes first
      // (offline, or the 2.5 s cap on the recipe page), nothing is forgotten too early, the tombstone
      // survives, and the next page load sends the delete again.
      Object.keys(lastPushedJson).forEach(function (id) {
        if (!localById[id]) {
          const ref = recipesCol().doc(id);
          deleting[id] = 1;
          jobs.push({ id: id, del: true, run: function () { return ref.delete(); } });
        }
      });
      // Send every write at once and wait until each has its answer. A failure is kept as that write's
      // answer instead of stopping the rest.
      const errs = await Promise.all(jobs.map(function (j) {
        return Promise.resolve().then(j.run).then(function () { return null; }, function (err) { return err || new Error("write failed"); });
      }));
      answered = true;
      let failure = null, retry = false;
      const failedIds = {}, doneDeletes = [];
      jobs.forEach(function (j, i) {
        const err = errs[i];
        if (!err) {
          // A delete the server has accepted is confirmed only NOW: forget what we last pushed for it and
          // stop treating it as in flight (its tombstone is dropped just below).
          if (j.del) { delete lastPushedJson[j.id]; delete deleting[j.id]; doneDeletes.push(j.id); }
          return;
        }
        failure = failure || err;
        failedIds[j.id] = 1;
        undoJob(j);
        // "not found": the recipe was deleted on another device while this edit waited. This device still has
        // an unsent edit to it, so (as always for an edit here versus a delete elsewhere) the edit is kept:
        // the next push writes the recipe whole, which works whether or not the cloud has it.
        if (!j.del && err.code === "not-found") { delete cloudHas[j.id]; retry = true; }
      });
      if (doneDeletes.length) {
        const tomb = getTombstones();
        const stillTomb = tomb.filter(function (id) { return doneDeletes.indexOf(id) === -1; });
        if (stillTomb.length !== tomb.length) setTombstones(stillTomb);
      }
      // the edits that landed are now confirmed in the cloud — they're no longer "pending", so the cloud is
      // free to become the agreed truth for them again. A recipe whose write failed stays pending, so the
      // merge keeps this device's edit until it is sent.
      // The list of parts changed here (kept on the device) is cleared at the same moment, for the same recipes.
      if (changeSeq === seqAtStart) {
        const done = Object.keys(pending).filter(function (id) { return !failedIds[id] && !heldIds[id]; });
        done.forEach(function (id) { delete pending[id]; });
        forgetChangedParts(Object.keys(getChangedParts()).filter(function (id) { return !failedIds[id] && !heldIds[id]; }));
      }
      if (failure) {
        console.error("bakebook: cloud sync failed —", failure);
        showSyncError(failure && failure.message ? failure.message : String(failure));
        if (retry || changeSeq !== seqAtStart) schedulePush();
        return;
      }

      // categories live in their own client-writable doc
      await metaDoc().set({ categories: getLocalCategories() }, { merge: true });

      hideSyncError();
      if (changeSeq !== seqAtStart) schedulePush(); // a change slipped in during the network write
    } catch (e) {
      console.error("bakebook: cloud sync failed —", e);
      showSyncError(e && e.message ? e.message : String(e));
      // Something went wrong before the writes got their answers: put back what we noted for every one of
      // them, so the next push tries them all again.
      if (!answered) jobs.forEach(undoJob);
    } finally {
      pushing = false;
    }
  }

  // ---------- public ----------
  window.bakebookWhenReady = function (cb) { if (ready) { try { cb(); } catch (e) {} } else { readyCbs.push(cb); } };
  window.bakebookOnChange = function (cb) { if (typeof cb === "function") changeCbs.push(cb); };
  window.bakebookOnRemoteChange = function (cb) { if (typeof cb === "function") remoteCbs.push(cb); };
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
    Object.keys(confirmedJson).forEach(function (k) { delete confirmedJson[k]; });
    Object.keys(pending).forEach(function (k) { delete pending[k]; });
    Object.keys(cloudHas).forEach(function (k) { delete cloudHas[k]; });

    // localStorage is shared by the whole browser. If the cache belongs to a DIFFERENT account,
    // wipe it before loading this user's data (prevents cross-account bleed).
    const sameOwner = localStorage.getItem(OWNER_KEY) === uid;
    if (!sameOwner) {
      internalWrite = true;
      localStorage.removeItem(RECIPES_KEY);
      localStorage.removeItem(CATS_KEY);
      localStorage.removeItem(TOMB_KEY);   // tombstones are per-account too
      localStorage.removeItem(CATS_TOMB_KEY);
      localStorage.removeItem(SEEN_CATS_KEY);
      localStorage.removeItem(SEEN_RECIPES_KEY);
      localStorage.removeItem(PARTS_KEY);   // parts changed on the other account's recipes
      // butter is per-ACCOUNT too: clear the previous account's conversations, saved chats, and daily
      // usage so nothing bleeds into a different account on a shared device.
      localStorage.removeItem("bakebook.butterUsage");
      localStorage.removeItem("bakebook.butterSaved");
      localStorage.removeItem("bakebook.butterSavedDeleted"); // saved-conversation sync tombstones (per account)
      localStorage.removeItem("bakebook.butterSavedSeen");    // saved-conversation "seen in cloud" ids (per account)
      Object.keys(localStorage).forEach(function (k) {
        if (k.indexOf("bakebook.butterThread.") === 0) localStorage.removeItem(k);
      });
      rawSetItem(OWNER_KEY, uid);
      internalWrite = false;
      // the copy this page opened with was the other account's too: forget it, so none of its recipes can
      // look "deleted here" to markPending
      Object.keys(bootJson).forEach(function (k) { delete bootJson[k]; });
    }
    lastCats = [];
    // Re-arm any delete that hadn't finished syncing before the last refresh: mark it pending so the
    // merge keeps it deleted (instead of "cloud wins" resurrecting it) and the next push removes it.
    getTombstones().forEach(function (id) { pending[id] = 1; });
    // Same for edits that hadn't been confirmed in the cloud: a recipe with parts noted as changed here is
    // pending again, so the first merge keeps those parts (only those) and the next push sends them.
    Object.keys(getChangedParts()).forEach(function (id) { pending[id] = 1; });
    // Restore the "ever seen in the cloud" recipe ids from the last session. Without this, a fresh page
    // load has an empty `everSeen`, so a recipe still in the local cache but already deleted from the cloud
    // looks brand-new and gets re-uploaded — resurrecting a delete made on another device.
    getSeenRecipes().forEach(function (id) { everSeen[id] = 1; });
    // A save that happened BEFORE this sign-in confirmed (the home page paints from the local copy first,
    // so an "undo" or a delete can land in that moment) was never marked pending. Find what changed since
    // the page opened and mark it now, so the first cloud merge keeps it and the push sends it up. Skipped
    // when the cache was just wiped above (it belonged to another account, so nothing here is this user's).
    if (wroteBeforeSignIn && sameOwner) {
      Object.keys(bootJson).forEach(function (id) { lastPushedJson[id] = bootJson[id]; });
      markPending();   // compares the local copy against bootJson: edited + new → pending, gone → pending + tombstone
      Object.keys(lastPushedJson).forEach(function (k) { delete lastPushedJson[k]; });   // the cloud snapshot seeds this properly
    }
    wroteBeforeSignIn = false;

    // read the legacy single-doc once (for migration + to seed categories), then start live sync
    try {
      const snap = await db.collection("users").doc(uid).get();
      legacy = (snap.exists && snap.data()) ? snap.data() : {};
      // AUTO-RESTORE: if this account was soft-deleted (the delete button, or one of the unexplained
      // deletions) and the baker is signing back in within the 10-day grace window, quietly bring it back —
      // the data was never actually erased. cancelDeletion clears the stamp so the daily purge won't take it.
      if (legacy.deletedAt && firebase.functions) {
        try {
          const res = await firebase.functions().httpsCallable("cancelDeletion")();
          delete legacy.deletedAt;
          if (res && res.data && res.data.restored) {
            try { window.dispatchEvent(new CustomEvent("bakebook:restored")); } catch (e) {}
          }
        } catch (e) { console.error("bakebook: auto-restore failed —", e); }
      }
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
