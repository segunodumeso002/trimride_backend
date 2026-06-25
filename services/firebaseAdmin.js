const fs = require('fs');
const admin = require('firebase-admin');

let initAttempted = false;
let cachedApp = null;

function getServiceAccount() {
  const jsonRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonRaw) {
    return JSON.parse(jsonRaw);
  }

  const filePath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (filePath && fs.existsSync(filePath)) {
    const fileRaw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(fileRaw);
  }

  return null;
}

function getFirebaseApp() {
  if (cachedApp) {
    return cachedApp;
  }

  if (admin.apps.length > 0) {
    cachedApp = admin.app();
    return cachedApp;
  }

  if (initAttempted) {
    return null;
  }

  initAttempted = true;

  try {
    const serviceAccount = getServiceAccount();
    if (!serviceAccount) {
      return null;
    }

    cachedApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });

    return cachedApp;
  } catch (error) {
    console.error('Failed to initialize Firebase Admin SDK:', error.message);
    return null;
  }
}

function getFirebaseAuth() {
  const app = getFirebaseApp();
  return app ? app.auth() : null;
}

function getFirebaseMessaging() {
  const app = getFirebaseApp();
  return app ? app.messaging() : null;
}

module.exports = {
  getFirebaseApp,
  getFirebaseAuth,
  getFirebaseMessaging,
};
