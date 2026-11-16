/*
 * Optional cloud sync. Leave this as-is to keep everything on this device only.
 *
 * To turn on cross-device sync later, create your own Firebase project (Auth: Anonymous + Google;
 * Firestore), then replace null below with its web config object, e.g.
 *   window.DAILY_PULSE_FIREBASE_CONFIG = { apiKey: "...", authDomain: "...", projectId: "...", appId: "..." };
 * Data is stored at artifacts/daily-pulse-app/users/{uid}/pulseData/main.
 */
window.DAILY_PULSE_FIREBASE_CONFIG = null;
