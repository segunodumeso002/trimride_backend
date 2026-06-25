const express = require('express');
const request = require('supertest');

jest.mock('../config/database', () => ({
  query: jest.fn(),
}));

const pool = require('../config/database');
const paymentsRouter = require('../routes/payments');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/payments', paymentsRouter);
  return app;
}

describe('Payments routes', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test('POST /api/payments/process validates bookingId', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/payments/process')
      .send({ bookingId: 0, amount: 120, paymentMethod: 'card' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('bookingId must be a positive number');
  });

  test('POST /api/payments/process validates amount', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/payments/process')
      .send({ bookingId: 7, amount: -1, paymentMethod: 'card' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('amount must be a positive number');
  });

  test('POST /api/payments/process validates paymentMethod', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/payments/process')
      .send({ bookingId: 7, amount: 120, paymentMethod: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('paymentMethod is required');
  });

  test('POST /api/payments/process creates payment and updates booking payment status', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 901,
            booking_id: 7,
            amount: 120,
            payment_method: 'card',
            status: 'completed',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/payments/process')
      .send({ bookingId: 7, amount: 120, paymentMethod: 'card' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: 901,
        booking_id: 7,
        amount: 120,
        payment_method: 'card',
        status: 'completed',
      })
    );

    expect(pool.query).toHaveBeenNthCalledWith(
      1,
      'INSERT INTO payments (booking_id, amount, payment_method, status) VALUES ($1, $2, $3, $4) RETURNING *',
      [7, 120, 'card', 'completed']
    );

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      'UPDATE bookings SET payment_status = $1, payment_method = $2 WHERE id = $3',
      ['paid', 'card', 7]
    );
  });

  test('POST /api/payments/process returns 500 when payment insert fails', async () => {
    const app = createTestApp();

    pool.query.mockRejectedValueOnce(new Error('db write failed'));

    const res = await request(app)
      .post('/api/payments/process')
      .send({ bookingId: 7, amount: 120, paymentMethod: 'card' });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('db write failed');
  });
});
