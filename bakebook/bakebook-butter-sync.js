// bakebook-butter-sync.js — cloud backup for butter's SAVED/named conversations.
//
// WHY THIS EXISTS: butter's saved chats lived ONLY in localStorage, so an in-place app update
// that cleared the WebView wiped them for good — recipes and logs came back (they sync to
// Firestore) but saved butter conversations were lost because there was never a second copy.
// This gives saved conversations the same durability: ONE Firestore document per saved chat at
// users/{uid}/butterConversations/{id}, so they survive updates, reinstalls, and new devices.
//
// SCOPE: only the explicitly SAVED/named conversations sync. The live/ongoing threads
// (bakebook.butterThread.*) are deliberately local-only — tapping "save" is what makes a chat
// durable. That's a known, accepted limitation, not a bug.
//
// This file is the raw cloud layer (read/write one conversation doc). It needs firebase app +
// auth + firestore already loaded. The MERGE with the local saved list lives in butter.html,
// which calls these. It runs where auth is reliable: the signed-in PARENT page (which relays for
// the embedded popup) and butter's own STANDALONE full page.
(function () {
  function db() { return firebase.firestore(); }
  function currentUid() { var u = firebase.auth().currentUser; return u ? u.uid : null; }
  function col(uid) { return db().collection("users").doc(uid).collection("butterConversations"); }

  window.bakebookButterConvStore = {
    // upsert one saved conversation. The entry's stable id is the doc id, so re-saving the same
    // conversation overwrites its doc (no duplicate).
    save: function (entry) {
      var uid = currentUid();
      if (!uid || !entry || !entry.id) return Promise.resolve();
      return col(uid).doc(entry.id).set(entry);
    },
    // delete one saved conversation from the cloud (so it's gone on other devices too).
    remove: function (id) {
      var uid = currentUid();
      if (!uid || !id) return Promise.resolve();
      return col(uid).doc(id).delete();
    },
    // live listener: cb(entriesArray) fires with the FULL cloud list on every change, so a save
    // on one device shows up on another. Returns an unsubscribe function. Signed-out → no-op.
    subscribe: function (cb) {
      var uid = currentUid();
      if (!uid) return function () {};
      return col(uid).onSnapshot(function (snap) {
        var list = [];
        snap.forEach(function (d) { list.push(d.data()); });
        try { cb(list); } catch (e) {}
      }, function (err) { console.error("bakebook: butter conversation sync error —", err); });
    }
  };
})();
