// Improvement for fcm-service.js's ensureInitialized() — same logic,
// but distinguishes the three real failure causes instead of
// collapsing them into one generic message, so the next failure (if
// any) tells you exactly which one it is.

function ensureInitialized() {
  if (initialized) return;

  // NEW: catches the exact symptom you hit — admin.credential being
  // undefined means the firebase-admin package didn't load correctly
  // (most likely: not in package.json "dependencies", so Vercel's
  // production build never installed it).
  if (!admin || !admin.credential) {
    throw new Error(
      "firebase-admin package did not load correctly (admin.credential is undefined). " +
        "Check that 'firebase-admin' is listed under \"dependencies\" (not devDependencies) " +
        "in package.json, and that it's actually present in this deployment.",
    );
  }

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (parseErr) {
      throw new Error(
        `FIREBASE_SERVICE_ACCOUNT_JSON is set but is not valid JSON: ${parseErr.message}`,
      );
    }
    credential = admin.credential.cert(serviceAccount);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    credential = admin.credential.cert(
      require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH),
    );
  } else {
    throw new Error(
      "Neither FIREBASE_SERVICE_ACCOUNT_JSON nor FIREBASE_SERVICE_ACCOUNT_PATH is set — " +
        "check they're set for the PRODUCTION environment specifically in Vercel, not just Preview/Development.",
    );
  }

  admin.initializeApp({ credential });
  initialized = true;
}