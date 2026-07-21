// bakebook — Firebase connection
// These are PUBLIC client identifiers (safe to ship in web code) — they only say
// "which Firebase project to talk to." Data is protected by Firestore/Storage security
// rules, not by hiding this. (The butter/Anthropic key is a real secret and lives
// server-side in a Cloud Function — never in the client.)
//
// NOTE: in this PUBLIC showcase mirror the values are placeholders. The live app fills
// in its real Firebase web config (also public by design), locked down with API-key
// application restrictions in Google Cloud Console.
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
