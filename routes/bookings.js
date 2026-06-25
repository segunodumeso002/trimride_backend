const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const requireAuth = require('../middleware/auth');
const { validate, Joi } = require('../middleware/validate');
const { sendPushToUser } = require('../services/pushService');

const locationSchema = Joi.object({
  latitude:  Joi.number().min(-90).max(90).required(),
  longitude: Joi.number().min(-180).max(180).required(),
});

async function resolveBarberProfileId(userId) {
  const barberResult = await pool.query(
    'SELECT id FROM barber_profiles WHERE user_id = $1 LIMIT 1',
    [userId]
  );
  return barberResult.rows.length > 0 ? barberResult.rows[0].id : null;
}

// Complete a booking session (barber ends service)
router.post('/complete/:bookingId', requireAuth, async (req, res) => {
  const { bookingId } = req.params;
  
  try {
    // Update booking status to completed
    await pool.query(
      'UPDATE bookings SET status = $1, actual_end_time = NOW() WHERE id = $2',
      ['completed', bookingId]
    );

    // Move queue positions up for remaining customers
    const barberResult = await pool.query(
      'SELECT barber_id FROM bookings WHERE id = $1',
      [bookingId]
    );
    
    if (barberResult.rows.length > 0) {
      const barberId = barberResult.rows[0].barber_id;
      
      // Update queue positions
      await pool.query(
        'UPDATE bookings SET queue_position = queue_position - 1 WHERE barber_id = $1 AND status = $2 AND queue_position > 0',
        [barberId, 'pending']
      );

      // Update barber queue count
      await pool.query(
        'UPDATE barber_profiles SET queue_count = queue_count - 1 WHERE id = $1',
        [barberId]
      );
    }

    res.json({ success: true, message: 'Session completed successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get authenticated barber incoming booking requests.
router.get('/my-requests', requireAuth, async (req, res) => {
  try {
    const barberProfileId = await resolveBarberProfileId(req.userId);
    if (!barberProfileId) {
      return res.status(403).json({ error: 'Barber profile not found' });
    }

    const result = await pool.query(
      `
      SELECT b.id, b.status, b.queue_position, b.created_at,
             u.first_name, u.last_name,
             s.name AS service_name
      FROM bookings b
      JOIN users u ON b.customer_id = u.id
      LEFT JOIN services s ON b.service_id = s.id
      WHERE b.barber_id = $1 AND b.status = 'pending'
      ORDER BY b.created_at ASC
      `,
      [barberProfileId]
    );

    return res.json(result.rows);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Barber accepts or declines incoming request.
router.post('/:bookingId/respond', requireAuth, async (req, res) => {
  const { bookingId } = req.params;
  const { action } = req.body;

  if (!['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'action must be accept or decline' });
  }

  try {
    const io = req.app.get('io');
    const barberProfileId = await resolveBarberProfileId(req.userId);

    if (!barberProfileId) {
      return res.status(403).json({ error: 'Barber profile not found' });
    }

    const bookingResult = await pool.query(
      'SELECT id, customer_id, barber_id, status FROM bookings WHERE id = $1',
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const booking = bookingResult.rows[0];

    if (booking.barber_id !== barberProfileId) {
      return res.status(403).json({ error: 'Not authorized for this booking' });
    }

    if (booking.status !== 'pending') {
      return res.status(409).json({ error: `Cannot respond to booking in ${booking.status} state` });
    }

    const nextStatus = action === 'accept' ? 'confirmed' : 'cancelled';

    await pool.query('UPDATE bookings SET status = $1 WHERE id = $2', [nextStatus, bookingId]);

    if (action === 'decline') {
      await pool.query(
        'UPDATE barber_profiles SET queue_count = GREATEST(queue_count - 1, 0) WHERE id = $1',
        [barberProfileId]
      );
    }

    io.to(`user-${booking.customer_id}`).emit('booking-status-updated', {
      bookingId: booking.id,
      status: nextStatus,
      byBarber: true,
    });

    sendPushToUser(booking.customer_id, {
      title: action === 'accept' ? 'Barber accepted your booking' : 'Booking declined',
      body: action === 'accept'
        ? 'Your barber is on the way. Open TrimRide for live tracking.'
        : 'Your booking was declined. Please request another barber.',
      data: {
        type: 'booking_status_updated',
        bookingId: booking.id,
        status: nextStatus,
      },
    }).catch(() => {});

    return res.json({ bookingId: booking.id, status: nextStatus });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Barber pushes live location updates to customer tracking screen.
router.post('/:bookingId/location', requireAuth, validate(locationSchema), async (req, res) => {
  const { bookingId } = req.params;
  const { latitude, longitude } = req.body;

  // latitude/longitude already validated and coerced to numbers by schema

  try {
    const io = req.app.get('io');
    const bookingResult = await pool.query(
      'SELECT customer_id FROM bookings WHERE id = $1',
      [bookingId]
    );

    if (bookingResult.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    io.to(`booking-${bookingId}`).emit('barber-location-updated', {
      bookingId: Number(bookingId),
      latitude,
      longitude,
      sentAt: new Date().toISOString(),
    });

    io.to(`user-${bookingResult.rows[0].customer_id}`).emit('barber-location-updated', {
      bookingId: Number(bookingId),
      latitude,
      longitude,
      sentAt: new Date().toISOString(),
    });

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get barber's current queue
router.get('/queue/:barberId', async (req, res) => {
  const { barberId } = req.params;
  
  try {
    const result = await pool.query(`
      SELECT b.*, u.first_name, u.last_name, s.name as service_name, s.price, s.duration
      FROM bookings b
      JOIN users u ON b.customer_id = u.id
      LEFT JOIN services s ON b.service_id = s.id
      WHERE b.barber_id = $1 AND b.status = 'pending'
      ORDER BY b.queue_position ASC
    `, [barberId]);

    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;