const express = require('express');
const router = express.Router();
const pool = require('../config/database');

// Process payment
router.post('/process', async (req, res) => {
  const { bookingId, amount, paymentMethod } = req.body;

  const normalizedBookingId = Number(bookingId);
  const normalizedAmount = Number(amount);
  const normalizedPaymentMethod =
    typeof paymentMethod === 'string' ? paymentMethod.trim() : '';

  if (!Number.isFinite(normalizedBookingId) || normalizedBookingId <= 0) {
    return res.status(400).json({ error: 'bookingId must be a positive number' });
  }

  if (!Number.isFinite(normalizedAmount) || normalizedAmount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  if (!normalizedPaymentMethod) {
    return res.status(400).json({ error: 'paymentMethod is required' });
  }
  
  try {
    const result = await pool.query(
      'INSERT INTO payments (booking_id, amount, payment_method, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [normalizedBookingId, normalizedAmount, normalizedPaymentMethod, 'completed']
    );

    // Update booking payment status
    await pool.query(
      'UPDATE bookings SET payment_status = $1, payment_method = $2 WHERE id = $3',
      ['paid', normalizedPaymentMethod, normalizedBookingId]
    );

    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;