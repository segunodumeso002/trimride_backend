const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const requireAuth = require('../middleware/auth');
const { sendPushToUser } = require('../services/pushService');

function normalizedEnvEmail(key) {
  if (process.env.NODE_ENV === 'test') {
    return '';
  }
  return String(process.env[key] || '').trim().toLowerCase();
}

// Book a service
router.post('/book', requireAuth, async (req, res) => {
  const { barberId, barber_id, id, serviceId, bookingType } = req.body;
  const customerId = req.userId;
  const normalizedBarberId = Number(barberId || barber_id || id || 0);
  const demoLockedCustomerEmail = normalizedEnvEmail('DEMO_LOCK_CUSTOMER_EMAIL');
  const demoLockedBarberEmail = normalizedEnvEmail('DEMO_LOCK_BARBER_EMAIL');

  if (!Number.isFinite(normalizedBarberId) || normalizedBarberId <= 0) {
    return res.status(400).json({ error: 'barberId is required' });
  }

  const normalizedBookingType = bookingType || 'queue';
  
  try {
    const io = req.app.get('io');

    const customerResult = await pool.query(
      'SELECT email FROM users WHERE id = $1 LIMIT 1',
      [customerId]
    );

    if (customerResult.rows.length === 0) {
      return res.status(401).json({ error: 'Customer account not found' });
    }

    const customerEmail = String(customerResult.rows[0].email || '').toLowerCase();
    if (demoLockedCustomerEmail && customerEmail !== demoLockedCustomerEmail) {
      return res.status(403).json({
        error: 'Demo mode: this customer account is not allowed to place bookings.',
      });
    }

    const barberProfileResult = await pool.query(
      `SELECT bp.id, bp.user_id, bp.is_active, u.email
       FROM barber_profiles bp
       JOIN users u ON u.id = bp.user_id
       WHERE bp.id = $1
       LIMIT 1`,
      [normalizedBarberId]
    );

    if (barberProfileResult.rows.length === 0) {
      return res.status(404).json({ error: 'Selected barber was not found' });
    }

    const selectedBarber = barberProfileResult.rows[0];

    if (!selectedBarber.is_active) {
      return res.status(409).json({ error: 'Selected barber is currently offline' });
    }

    const selectedBarberEmail = String(selectedBarber.email || '').toLowerCase();
    if (demoLockedBarberEmail && selectedBarberEmail !== demoLockedBarberEmail) {
      return res.status(403).json({
        error: 'Demo mode: only the demo barber account can receive requests.',
      });
    }

    // Get current queue position
    const queueResult = await pool.query(
      'SELECT COALESCE(MAX(queue_position), 0) + 1 as next_position FROM bookings WHERE barber_id = $1 AND status = $2',
      [normalizedBarberId, 'pending']
    );
    
    const queuePosition = queueResult.rows[0].next_position;
    
    // Create booking
    const result = await pool.query(
      'INSERT INTO bookings (customer_id, barber_id, service_id, booking_type, queue_position, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *',
      [customerId, normalizedBarberId, serviceId || null, normalizedBookingType, queuePosition, 'pending']
    );

    // Update barber queue count
    await pool.query(
      'UPDATE barber_profiles SET queue_count = queue_count + 1 WHERE id = $1',
      [normalizedBarberId]
    );

    const barberUserId = selectedBarber.user_id;
    io.to(`user-${barberUserId}`).emit('booking-requested', {
      bookingId: result.rows[0].id,
      customerId,
      barberId: normalizedBarberId,
      queuePosition,
    });

    sendPushToUser(barberUserId, {
      title: 'New booking request',
      body: 'A customer just requested your service.',
      data: {
        type: 'booking_requested',
        bookingId: result.rows[0].id,
        barberId: normalizedBarberId,
        customerId,
      },
    }).catch(() => {});

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get customer's current active booking (pending or confirmed)
router.get('/my-booking', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.status, b.queue_position, b.barber_id,
              bp.shop_name, bp.latitude, bp.longitude,
              s.name AS service_name
       FROM bookings b
       JOIN barber_profiles bp ON b.barber_id = bp.id
       LEFT JOIN services s ON b.service_id = s.id
       WHERE b.customer_id = $1 AND b.status IN ('pending', 'confirmed')
       ORDER BY b.created_at DESC
       LIMIT 1`,
      [req.userId]
    );
    res.json(result.rows[0] || null);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get recent customer booking outcomes (pending/confirmed/cancelled/completed)
router.get('/my-bookings', requireAuth, async (req, res) => {
  const requestedLimit = Number(req.query.limit || 8);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 20)
    : 8;

  try {
    const result = await pool.query(
      `SELECT b.id, b.status, b.queue_position, b.created_at,
              b.barber_id, bp.shop_name,
              s.name AS service_name
       FROM bookings b
       JOIN barber_profiles bp ON b.barber_id = bp.id
       LEFT JOIN services s ON b.service_id = s.id
       WHERE b.customer_id = $1
       ORDER BY b.created_at DESC
       LIMIT $2`,
      [req.userId, limit]
    );

    return res.json(result.rows);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;