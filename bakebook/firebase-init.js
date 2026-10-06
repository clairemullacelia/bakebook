// bakebook — Firebase connection
// These values are PUBLIC identifiers (safe to ship in web code). They only say
// "which Firebase project to talk to." Your data is protected by security rules,
// not by hiding this. (Your butter/Anthropic key is different — that one stays secret.)
const firebaseConfig = {
  apiKey: "YOUR_FIREBASE_WEB_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

firebase.initializeApp(firebaseConfig);
