// fcm-service.js — replace the old style:
// const admin = require("firebase-admin");

const { cert, initializeApp } = require("firebase-admin/app");
const { getMessaging } = require("firebase-admin/messaging");

let messaging = null;

function ensureInitialized() {
  if (messaging) return;

  let credential;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    let serviceAccount;
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    } catch (parseErr) {
      throw new Error(`FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON: ${parseErr.message}`);
    }
    credential = cert(serviceAccount);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    credential = cert(require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH));
  } else {
    throw new Error("Neither FIREBASE_SERVICE_ACCOUNT_JSON nor FIREBASE_SERVICE_ACCOUNT_PATH is set.");
  }

  initializeApp({ credential });
  messaging = getMessaging();
}