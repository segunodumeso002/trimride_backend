const express = require('express');
const request = require('supertest');

jest.mock('../config/database', () => ({
  query: jest.fn(),
}));

jest.mock('../middleware/auth', () => (req, _res, next) => {
  const raw = req.headers['x-user-id'];
  req.userId = raw ? Number(raw) : 1;
  next();
});

const pool = require('../config/database');
const customersRouter = require('../routes/customers');

function createTestApp(ioMock) {
  const app = express();
  app.use(express.json());
  app.set('io', ioMock);
  app.use('/api/customers', customersRouter);
  return app;
}

describe('Customers routes', () => {
  let ioMock;
  let emitMock;

  beforeEach(() => {
    emitMock = jest.fn();
    ioMock = {
      to: jest.fn(() => ({ emit: emitMock })),
    };
    pool.query.mockReset();
  });

  test('POST /api/customers/book validates missing barber id', async () => {
    const app = createTestApp(ioMock);

    const res = await request(app)
      .post('/api/customers/book')
      .set('x-user-id', '50')
      .send({ serviceId: 2 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('barberId is required');
  });

  test('POST /api/customers/book accepts alternate barber id field (barber_id)', async () => {
    const app = createTestApp(ioMock);

    pool.query
      .mockResolvedValueOnce({ rows: [{ email: 'customer@trimride.app' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 7, user_id: 88, is_active: true, email: 'barber@trimride.app' }],
      })
      .mockResolvedValueOnce({ rows: [{ next_position: 3 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 99,
            customer_id: 50,
            barber_id: 7,
            service_id: 2,
            booking_type: 'queue',
            queue_position: 3,
            status: 'pending',
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/customers/book')
      .set('x-user-id', '50')
      .send({ barber_id: 7, serviceId: 2 });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: 99,
        barber_id: 7,
        queue_position: 3,
        status: 'pending',
      })
    );

    expect(pool.query).toHaveBeenNthCalledWith(
      3,
      'SELECT COALESCE(MAX(queue_position), 0) + 1 as next_position FROM bookings WHERE barber_id = $1 AND status = $2',
      [7, 'pending']
    );

    expect(ioMock.to).toHaveBeenCalledWith('user-88');
    expect(emitMock).toHaveBeenCalledWith(
      'booking-requested',
      expect.objectContaining({
        bookingId: 99,
        customerId: 50,
        barberId: 7,
        queuePosition: 3,
      })
    );
  });

  test('POST /api/customers/book returns 409 when selected barber is offline', async () => {
    const app = createTestApp(ioMock);

    pool.query
      .mockResolvedValueOnce({ rows: [{ email: 'customer@trimride.app' }] })
      .mockResolvedValueOnce({
        rows: [{ id: 11, user_id: 88, is_active: false, email: 'barber@trimride.app' }],
      });

    const res = await request(app)
      .post('/api/customers/book')
      .set('x-user-id', '50')
      .send({ barberId: 11 });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Selected barber is currently offline');
    expect(ioMock.to).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  test('GET /api/customers/my-booking returns null when no active booking exists', async () => {
    const app = createTestApp(ioMock);

    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/customers/my-booking')
      .set('x-user-id', '50');

    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  test('GET /api/customers/my-booking returns most recent active booking', async () => {
    const app = createTestApp(ioMock);

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 200,
          status: 'confirmed',
          queue_position: 2,
          barber_id: 11,
          shop_name: 'Mike Cutz',
          latitude: -26.2,
          longitude: 28.0,
          service_name: 'Fade',
        },
      ],
    });

    const res = await request(app)
      .get('/api/customers/my-booking')
      .set('x-user-id', '50');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: 200,
        status: 'confirmed',
        shop_name: 'Mike Cutz',
      })
    );
  });

  test('GET /api/customers/my-bookings clamps limit to maximum 20', async () => {
    const app = createTestApp(ioMock);

    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/customers/my-bookings?limit=999')
      .set('x-user-id', '50');

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $2'),
      [50, 20]
    );
  });

  test('GET /api/customers/my-bookings clamps invalid/low limit to minimum 1', async () => {
    const app = createTestApp(ioMock);

    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/customers/my-bookings?limit=0')
      .set('x-user-id', '50');

    expect(res.status).toBe(200);
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining('LIMIT $2'),
      [50, 1]
    );
  });
});
