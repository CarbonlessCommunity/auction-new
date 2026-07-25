import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth } from 'firebase/auth';
import { connectFirestoreEmulator, getFirestore } from 'firebase/firestore';

/**
 * Firebase Web config. These values are NOT secrets — Firebase's security
 * model puts all enforcement in `firestore.rules`, not in hiding this object.
 * It is safe to commit and ship inside the client bundle.
 *
 * Fill this in with your own project's values (Firebase Console → Project
 * settings → General → "Your apps" → SDK setup and configuration), or run:
 *   firebase apps:sdkconfig web
 * after `firebase use --add`.
 */
export const firebaseConfig = {
  apiKey: 'AIzaSyBLREKUJr5ozVcW1drGXgDoEsnsY2dnvso',
  authDomain: 'carbonless-auction.firebaseapp.com',
  projectId: 'carbonless-auction',
  storageBucket: 'carbonless-auction.firebasestorage.app',
  messagingSenderId: '837125960238',
  appId: '1:837125960238:web:459ea516a4873d4d3b65bf',
  measurementId: 'G-06NLGSMW5S',
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

/**
 * Point at the local emulator suite instead of the real project whenever
 * VITE_USE_EMULATOR is set (see `npm run dev:emulator`). Rehearsing an auction
 * against the live project would leave real documents behind, and the rules
 * being exercised here are the same ones `firebase deploy` ships.
 */
export const usingEmulator = import.meta.env.VITE_USE_EMULATOR === '1';

if (usingEmulator) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
