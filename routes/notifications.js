const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const requireAuth = require('../middleware/auth');
const { validate, Joi } = require('../middleware/validate');
const { sendPushToUser } = require('../services/pushService');

let pushTableReady = false;

async function ensurePushTable() {
  if (pushTableReady) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_push_tokens (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      platform VARCHAR(20) NOT NULL DEFAULT 'android' CHECK (platform IN ('android', 'ios')),
      device_id VARCHAR(200),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await pool.query(
    'CREATE INDEX IF NOT EXISTS idx_user_push_tokens_user_id ON user_push_tokens(user_id)'
  );

  pushTableReady = true;
}

const registerTokenSchema = Joi.object({
  token: Joi.string().trim().min(20).required(),
  platform: Joi.string().valid('android', 'ios').default('android'),
  deviceId: Joi.string().trim().max(200).optional().allow('', null),
});

const unregisterTokenSchema = Joi.object({
  token: Joi.string().trim().min(20).required(),
});

const testNotificationSchema = Joi.object({
  title: Joi.string().trim().min(1).max(120).default('TrimRide test notification'),
  body: Joi.string().trim().min(1).max(240).default('Your push notifications are now active.'),
});

router.post('/register-token', requireAuth, validate(registerTokenSchema), async (req, res) => {
  const { token, platform, deviceId } = req.body;

  try {
    await ensurePushTable();

    await pool.query(
      `
      INSERT INTO user_push_tokens (user_id, token, platform, device_id, last_seen_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (token)
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        platform = EXCLUDED.platform,
        device_id = EXCLUDED.device_id,
        last_seen_at = NOW(),
        updated_at = NOW()
      `,
      [req.userId, token, platform, deviceId || null]
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/unregister-token', requireAuth, validate(unregisterTokenSchema), async (req, res) => {
  const { token } = req.body;

  try {
    await ensurePushTable();

    await pool.query(
      'DELETE FROM user_push_tokens WHERE user_id = $1 AND token = $2',
      [req.userId, token]
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

router.post('/test-self', requireAuth, validate(testNotificationSchema), async (req, res) => {
  const { title, body } = req.body;

  try {
    await ensurePushTable();

    const result = await sendPushToUser(req.userId, {
      title,
      body,
      data: {
        type: 'test',
        userId: req.userId,
      },
    });

    return res.json({ ok: true, result });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;
