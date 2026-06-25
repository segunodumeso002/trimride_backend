const { getFirebaseAuth } = require('./firebaseAdmin');

function isFirebaseAuthEnabled() {
  return String(process.env.FIREBASE_AUTH_ENABLED || '').toLowerCase() === 'true';
}

function getFirebaseWebApiKey() {
  return String(process.env.FIREBASE_WEB_API_KEY || '').trim();
}

function normalizePhone(phone) {
  const value = String(phone || '').trim();
  return value || undefined;
}

async function createFirebaseUser({ email, password, firstName, lastName, phone }) {
  const auth = getFirebaseAuth();
  if (!auth) {
    const error = new Error('Firebase Admin SDK is not configured on backend.');
    error.code = 'firebase/admin-not-configured';
    throw error;
  }

  const displayName = `${firstName || ''} ${lastName || ''}`.trim() || undefined;

  return auth.createUser({
    email,
    password,
    displayName,
    phoneNumber: normalizePhone(phone),
  });
}

async function deleteFirebaseUser(uid) {
  if (!uid) return;

  const auth = getFirebaseAuth();
  if (!auth) return;

  try {
    await auth.deleteUser(uid);
  } catch (_error) {
    // Best-effort cleanup only.
  }
}

async function signInWithFirebasePassword(email, password) {
  const apiKey = getFirebaseWebApiKey();
  if (!apiKey) {
    const error = new Error('FIREBASE_WEB_API_KEY is missing in backend environment.');
    error.code = 'firebase/web-api-key-missing';
    throw error;
  }

  const response = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        password,
        returnSecureToken: true,
      }),
    }
  );

  const raw = await response.text().catch(() => '');
  let data = {};
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch (_error) {
      data = {};
    }
  }

  if (!response.ok) {
    const firebaseMessage = data?.error?.message || '';
    const error = new Error(firebaseMessage || 'Firebase sign-in failed.');
    error.code = firebaseMessage || `firebase/http-${response.status}`;
    throw error;
  }

  return {
    email: data.email,
    firebaseUid: data.localId,
    idToken: data.idToken,
  };
}

module.exports = {
  isFirebaseAuthEnabled,
  createFirebaseUser,
  deleteFirebaseUser,
  signInWithFirebasePassword,
};
