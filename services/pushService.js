const pool = require('../config/database');
const { getFirebaseMessaging } = require('./firebaseAdmin');

let messaging = null;

function ensureMessaging() {
  if (messaging) {
    return messaging;
  }

  messaging = getFirebaseMessaging();
  return messaging;
}

async function deleteInvalidTokens(tokens) {
  if (!tokens.length) return;

  await pool.query(
    'DELETE FROM user_push_tokens WHERE token = ANY($1::text[])',
    [tokens]
  );
}

async function sendPushToUser(userId, payload) {
  const sdk = ensureMessaging();
  if (!sdk) {
    return { sent: 0, reason: 'firebase-not-configured' };
  }

  const tokenResult = await pool.query(
    'SELECT token FROM user_push_tokens WHERE user_id = $1',
    [userId]
  );

  const tokens = tokenResult.rows.map(row => row.token).filter(Boolean);
  if (tokens.length === 0) {
    return { sent: 0, reason: 'no-device-token' };
  }

  const safeData = Object.fromEntries(
    Object.entries(payload.data || {}).map(([key, value]) => [key, String(value)])
  );

  const response = await sdk.sendEachForMulticast({
    tokens,
    notification: {
      title: payload.title,
      body: payload.body,
    },
    data: safeData,
    android: {
      priority: 'high',
    },
  });

  const invalidTokens = [];
  response.responses.forEach((result, index) => {
    if (!result.success) {
      const code = result.error?.code || '';
      if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token') {
        invalidTokens.push(tokens[index]);
      }
    }
  });

  await deleteInvalidTokens(invalidTokens);

  return {
    sent: response.successCount,
    failed: response.failureCount,
  };
}

module.exports = {
  sendPushToUser,
};
