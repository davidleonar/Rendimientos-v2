import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, Auth } from 'firebase/auth';

const firebaseConfig = {
    apiKey: "AIzaSyBk_fTMgmkwZGoW154ntCxxXwiDMy5o7KA",
    authDomain: "rendimientos-5dbb9.firebaseapp.com",
    databaseURL: "https://rendimientos-5dbb9-default-rtdb.firebaseio.com",
    projectId: "rendimientos-5dbb9",
    storageBucket: "rendimientos-5dbb9.firebasestorage.app",
    messagingSenderId: "698366956468",
    appId: "1:698366956468:web:18ae8758f5f3c4fe5dd8e1",
    measurementId: "G-Y5QKXN0N6C"
  };

// Initialize only once
const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const auth: Auth = getAuth(app);