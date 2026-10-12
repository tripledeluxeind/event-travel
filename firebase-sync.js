// Pure Firebase Auth + Firestore wrapper - no DOM code here, that's all in
// auth-ui.js, which dynamically imports this module. Loaded from Google's
// CDN as real ES-module imports, so this adds zero npm dependencies to the
// project (see server.js's own "zero npm dependencies" comment).
//
// All authorization is enforced server-side by Firestore Security Rules
// (see firestore.rules: a user may only read/write their own `users/{uid}`
// doc) - not by anything in this file or by hiding firebaseConfig below.
// The config object is a public client identifier by Firebase's own
// design, not a secret, so it's safe to commit as-is.
import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInWithPopup,
  GoogleAuthProvider,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  signOut as firebaseSignOut,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

// Web app config for the event-travel-tdi Firebase project - see HANDOFF.md
// section 1b for the full console setup steps (enabling Google +
// Email/Password sign-in, creating the Firestore database, and publishing
// firestore.rules). If any of those steps aren't done yet, sign-in will
// fail with a friendly error when clicked, but the rest of the app is
// unaffected either way.
const firebaseConfig = {
  apiKey: "AIzaSyA_nZC3eX4Y4dmIh9K1x0PFPWEBqz4j5fc",
  authDomain: "event-travel-tdi.firebaseapp.com",
  projectId: "event-travel-tdi",
  storageBucket: "event-travel-tdi.firebasestorage.app",
  messagingSenderId: "265280350675",
  appId: "1:265280350675:web:eb9d9bed6df2af6ee8a726",
};

let auth = null;
let db = null;

export async function init() {
  const app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
}

export function onAuthChange(cb) {
  onAuthStateChanged(auth, cb);
}

export function signInGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

export function signInEmail(email, password) {
  return signInWithEmailAndPassword(auth, email, password);
}

export function signUpEmail(email, password) {
  return createUserWithEmailAndPassword(auth, email, password);
}

export function resetPassword(email) {
  return sendPasswordResetEmail(auth, email);
}

export function signOut() {
  return firebaseSignOut(auth);
}

export async function pullUserDoc(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

export function pushUserDoc(uid, partial) {
  // updatedAt is plain bookkeeping (and satisfies firestore.rules' field
  // allowlist) - the actual merge decision for defaultCity uses the
  // explicit defaultCityUpdatedAt field passed in via `partial`, not this.
  return setDoc(doc(db, "users", uid), { ...partial, updatedAt: Date.now() }, { merge: true });
}
