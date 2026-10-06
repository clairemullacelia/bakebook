// bakebook-events.js — the event log: a short record of what people do in bakebook.
//
// WHY THIS EXISTS: the growth question is "who keeps developing recipes?", and the stored recipes can't
// answer all of it (nothing records opening Make It, or accepting a change butter proposed). So each of
// those moments saves one small entry at users/{uid}/events/{id}: the event name, the time, iPhone /
// Android / web, and the recipe id where there is one. Never the words of a recipe or a butter message.
// The privacy policy ("How you use bakebook"), the App Store label and Play's Data safety form all say so;
// change what is recorded here and those three must change too (docs/analytics-privacy-packet.html).
//
// Entries are deleted with the account: the purge job erases everything under users/{uid}.
//
// Use: bbLog("bake_logged", { recipeId: recipe.id })   // also kind: "imported", "edit", …
//
// Many events happen right before the page changes (saving a recipe opens it), and a cloud write can't
// finish once the page is gone. So every event goes into a small queue in localStorage first, and is
// removed only when the cloud confirms it. Whatever is left is sent from the next page that loads.
// Each entry has its own id, so sending one twice can never make a duplicate.
(function () {
  const QUEUE_KEY = "bakebook.eventQueue";
  const OPENED_KEY = "bakebook.openedToday";   // recipe_opened is logged at most once per recipe per day
  const MAX_QUEUE = 200;                        // a phone offline for weeks keeps the newest 200
  // The names the database rules accept. Keep this list and firestore.rules in step.
  const NAMES = ["recipe_created", "recipe_opened", "bake_logged", "make_it_started",
                 "butter_asked", "butter_change_approved", "recipe_shared"];

  function platform() {
    try { const C = window.Capacitor; if (C && C.getPlatform) return C.getPlatform(); } catch (e) {}
    return "web";
  }
  function readQueue() {
    try { const q = JSON.parse(localStorage.getItem(QUEUE_KEY)); return Array.isArray(q) ? q : []; } catch (e) { return []; }
  }
  function writeQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q.slice(-MAX_QUEUE))); } catch (e) {}
  }
  function currentUid() {
    const u = firebase.auth().currentUser;
    return u ? u.uid : null;
  }

  let sending = false;
  function flush() {
    const uid = currentUid();
    if (!uid || sending) return;
    const q = readQueue();
    // entries belong to the account that was signed in when they happened; another account's leftovers
    // (someone switched accounts on this device) are dropped rather than filed under the wrong person
    const mine = q.filter(function (e) { return e.uid === uid; });
    if (mine.length !== q.length) writeQueue(mine);
    if (!mine.length) return;
    sending = true;
    const col = firebase.firestore().collection("users").doc(uid).collection("events");
    Promise.all(mine.map(function (e) {
      const doc = { name: e.name, at: firebase.firestore.FieldValue.serverTimestamp(), clientAt: e.clientAt, platform: e.platform };
      if (e.recipeId) doc.recipeId = e.recipeId;
      if (e.kind) doc.kind = e.kind;
      return col.doc(e.id).set(doc).then(
        function () { return e.id; },
        // "permission-denied" here means the entry is already in the cloud (the rules allow creating an
        // entry, never changing one) or was malformed; either way retrying can't help, so let it go
        function (err) { return err && err.code === "permission-denied" ? e.id : null; }
      );
    })).then(function (ids) {
      const done = {}; ids.forEach(function (id) { if (id) done[id] = true; });
      const tried = {}; mine.forEach(function (e) { tried[e.id] = true; });
      const left = readQueue().filter(function (e) { return !done[e.id]; });   // re-read: more may have been added meanwhile
      writeQueue(left);
      sending = false;
      // an event logged while this batch was in flight waited for it; send it now. (Entries that just
      // failed are not retried here, only on the next page load or when the connection comes back.)
      if (left.some(function (e) { return !tried[e.id]; })) flush();
    }, function () { sending = false; });
  }

  window.bbLog = function (name, extra) {
    try {
      if (NAMES.indexOf(name) === -1) return;
      const uid = currentUid() || localStorage.getItem("bakebook.uid");   // the store remembers the account before sign-in confirms
      if (!uid) return;                                                   // signed out: nothing is recorded
      extra = extra || {};
      const now = Date.now();
      const q = readQueue();
      q.push({
        id: "e" + now + Math.random().toString(36).slice(2, 8),
        uid: uid, name: name, clientAt: now, platform: platform(),
        recipeId: extra.recipeId ? String(extra.recipeId).slice(0, 100) : undefined,
        kind: extra.kind ? String(extra.kind).slice(0, 30) : undefined
      });
      writeQueue(q);
      flush();
    } catch (e) {}   // the log must never break the app
  };

  // Opening a recipe counts once per recipe per day, so flicking between recipes doesn't flood the log.
  window.bbLogOpened = function (recipeId) {
    if (!recipeId) return;
    try {
      const today = new Date().toISOString().slice(0, 10);
      let seen = {}; try { seen = JSON.parse(localStorage.getItem(OPENED_KEY)) || {}; } catch (e) {}
      if (seen.day !== today) seen = { day: today, ids: [] };
      if (seen.ids.indexOf(recipeId) !== -1) return;
      seen.ids.push(recipeId);
      localStorage.setItem(OPENED_KEY, JSON.stringify(seen));
    } catch (e) {}
    window.bbLog("recipe_opened", { recipeId: recipeId });
  };

  // send anything a previous page left behind, as soon as we know who is signed in
  firebase.auth().onAuthStateChanged(function (u) { if (u) flush(); });
  window.addEventListener("online", flush);
})();
