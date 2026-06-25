const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const pool = require('../config/database');
const requireAuth = require('../middleware/auth');
const { validate, Joi } = require('../middleware/validate');
const {
  isFirebaseAuthEnabled,
  createFirebaseUser,
  deleteFirebaseUser,
  signInWithFirebasePassword,
} = require('../services/firebaseAuthService');

const registerSchema = Joi.object({
  email:     Joi.string().email().max(254).required(),
  password:  Joi.string().min(8).max(128).required(),
  firstName: Joi.string().trim().min(1).max(50).required(),
  lastName:  Joi.string().trim().min(1).max(50).required(),
  userType:  Joi.string().valid('customer', 'barber').required(),
  phone:     Joi.string().trim().max(20).optional().allow('', null),
});

const loginSchema = Joi.object({
  email:    Joi.string().email().max(254).required(),
  password: Joi.string().min(1).max(128).required(),
});

function createJwtForUser(userId) {
  return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

async function createLocalUser({ email, password, firstName, lastName, userType, phone }) {
  const hashedPassword = await bcrypt.hash(password, 10);

  const result = await pool.query(
    'INSERT INTO users (email, password_hash, first_name, last_name, user_type, phone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, email, first_name, last_name, user_type',
    [email, hashedPassword, firstName, lastName, userType, phone]
  );

  return result.rows[0];
}

async function ensureBarberProfile(userType, userId, firstName, lastName) {
  if (userType !== 'barber') {
    return;
  }

  await pool.query(
    `INSERT INTO barber_profiles (
       user_id, shop_name, shop_address, latitude, longitude, description,
       is_active, rating, queue_count, estimated_wait_time
     ) VALUES ($1, $2, $3, $4, $5, $6, false, 0.00, 0, 0)`,
    [
      userId,
      `${firstName} ${lastName} Barber`,
      'Setup pending',
      0,
      0,
      'Profile setup pending',
    ]
  );
}

function isFirebaseInvalidCredential(errorCode) {
  return [
    'INVALID_LOGIN_CREDENTIALS',
    'EMAIL_NOT_FOUND',
    'INVALID_PASSWORD',
    'USER_DISABLED',
  ].includes(errorCode);
}

// Register
router.post('/register', validate(registerSchema), async (req, res) => {
  const { email, password, firstName, lastName, userType, phone } = req.body;

  const firebaseAuthEnabled = isFirebaseAuthEnabled();
  let createdFirebaseUid = null;

  try {
    if (firebaseAuthEnabled) {
      const firebaseUser = await createFirebaseUser({
        email,
        password,
        firstName,
        lastName,
        phone,
      });
      createdFirebaseUid = firebaseUser.uid;
    }

    const user = await createLocalUser({
      email,
      password,
      firstName,
      lastName,
      userType,
      phone,
    });

    await ensureBarberProfile(userType, user.id, firstName, lastName);

    const token = createJwtForUser(user.id);
    res.json({ token, user });
  } catch (error) {
    if (createdFirebaseUid && error.code === '23505') {
      await deleteFirebaseUser(createdFirebaseUid);
    }

    if (error.code === 'auth/email-already-exists') {
      return res.status(400).json({ error: 'Email already exists' });
    }

    if (error.code === 'firebase/admin-not-configured') {
      return res.status(500).json({
        error: 'Managed authentication is enabled, but Firebase Admin is not configured.',
      });
    }

    if (error.code === '23505') {
      return res.status(400).json({ error: 'Email already exists' });
    } else {
      return res.status(500).json({ error: error.message });
    }
  }
});

// Login
router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  try {
    const firebaseAuthEnabled = isFirebaseAuthEnabled();

    if (firebaseAuthEnabled) {
      try {
        await signInWithFirebasePassword(email, password);

        const localResult = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (localResult.rows.length === 0) {
          return res.status(401).json({
            error: 'Account exists in Firebase but not in TrimRide. Please create account in the app first.',
          });
        }

        const firebaseUser = localResult.rows[0];
        const token = createJwtForUser(firebaseUser.id);
        return res.json({
          token,
          user: {
            id: firebaseUser.id,
            email: firebaseUser.email,
            firstName: firebaseUser.first_name,
            lastName: firebaseUser.last_name,
            userType: firebaseUser.user_type,
          },
        });
      } catch (firebaseError) {
        if (firebaseError.code === 'firebase/web-api-key-missing') {
          return res.status(500).json({
            error: 'Managed authentication is enabled, but FIREBASE_WEB_API_KEY is missing.',
          });
        }

        if (!isFirebaseInvalidCredential(firebaseError.code)) {
          return res.status(500).json({ error: firebaseError.message });
        }
        // Invalid Firebase credentials can still be a legacy local user, so continue to local check.
      }
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const validPassword = await bcrypt.compare(password, user.password_hash);
    
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = createJwtForUser(user.id);
    res.json({ token, user: { id: user.id, email: user.email, firstName: user.first_name, lastName: user.last_name, userType: user.user_type } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Current authenticated user
router.get('/me', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, email, first_name, last_name, user_type, phone FROM users WHERE id = $1',
      [req.userId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      user: {
        id: result.rows[0].id,
        email: result.rows[0].email,
        firstName: result.rows[0].first_name,
        lastName: result.rows[0].last_name,
        phone: result.rows[0].phone,
        userType: result.rows[0].user_type,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;