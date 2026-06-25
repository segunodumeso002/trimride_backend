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
const barbersRouter = require('../routes/barbers');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/barbers', barbersRouter);
  return app;
}

describe('Barbers routes', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test('GET /api/barbers/:barberId/services returns active services', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, barber_id: 7, name: 'Fade', is_active: true },
        { id: 2, barber_id: 7, name: 'Beard Trim', is_active: true },
      ],
    });

    const res = await request(app).get('/api/barbers/7/services');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(pool.query).toHaveBeenCalledWith(
      'SELECT * FROM services WHERE barber_id = $1 AND is_active = true ORDER BY name',
      ['7']
    );
  });

  test('POST /api/barbers/:barberId/services creates service', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          barber_id: 7,
          name: 'Premium Fade',
          description: 'Fade with line-up',
          price: 180,
          duration: 45,
        },
      ],
    });

    const res = await request(app)
      .post('/api/barbers/7/services')
      .set('x-user-id', '11')
      .send({
        name: 'Premium Fade',
        description: 'Fade with line-up',
        price: 180,
        duration: 45,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: 11,
        barber_id: 7,
        name: 'Premium Fade',
      })
    );

    expect(pool.query).toHaveBeenCalledWith(
      'INSERT INTO services (barber_id, name, description, price, duration) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      ['7', 'Premium Fade', 'Fade with line-up', 180, 45]
    );
  });

  test('PUT /api/barbers/services/:serviceId updates service', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 11,
          name: 'Premium Fade+',
          description: 'Fade plus wash',
          price: 220,
          duration: 60,
          is_active: true,
        },
      ],
    });

    const res = await request(app)
      .put('/api/barbers/services/11')
      .set('x-user-id', '11')
      .send({
        name: 'Premium Fade+',
        description: 'Fade plus wash',
        price: 220,
        duration: 60,
        is_active: true,
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        id: 11,
        name: 'Premium Fade+',
        price: 220,
      })
    );

    expect(pool.query).toHaveBeenCalledWith(
      'UPDATE services SET name = $1, description = $2, price = $3, duration = $4, is_active = $5 WHERE id = $6 RETURNING *',
      ['Premium Fade+', 'Fade plus wash', 220, 60, true, '11']
    );
  });

  test('GET /api/barbers/nearby filters out barbers beyond radius', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({
      rows: [
        { id: 1, first_name: 'A', last_name: 'Barber', distance: 2.1 },
        { id: 2, first_name: 'B', last_name: 'Barber', distance: 6.4 },
      ],
    });

    const res = await request(app)
      .get('/api/barbers/nearby?lat=-26.2041&lng=28.0473&radius=5');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
  });

  test('GET /api/barbers/nearby returns 500 on database failure', async () => {
    const app = createTestApp();

    pool.query.mockRejectedValueOnce(new Error('nearby query failed'));

    const res = await request(app)
      .get('/api/barbers/nearby?lat=-26.2041&lng=28.0473&radius=5');

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('nearby query failed');
  });

  test('GET /api/barbers/dispatch validates required lat/lng', async () => {
    const app = createTestApp();

    const res = await request(app).get('/api/barbers/dispatch?lng=28.04');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/lat/);
  });

  test('GET /api/barbers/dispatch applies radius and limit', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            user_id: 21,
            shop_name: 'Inside Radius',
            latitude: -26.204,
            longitude: 28.047,
            rating: 4.7,
            queue_count: 2,
            estimated_wait_time: 12,
            distance: 1.4,
          },
          {
            id: 2,
            user_id: 22,
            shop_name: 'Outside Radius',
            latitude: -26.5,
            longitude: 28.5,
            rating: 4.9,
            queue_count: 0,
            estimated_wait_time: 3,
            distance: 12.2,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/barbers/dispatch?lat=-26.2041&lng=28.0473&radius=8&limit=1');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].shop_name).toBe('Inside Radius');
  });

  test('GET /api/barbers/dispatch keeps only service matches when available', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            user_id: 21,
            shop_name: 'Fade Master',
            latitude: -26.204,
            longitude: 28.047,
            rating: 4.7,
            queue_count: 2,
            estimated_wait_time: 12,
            distance: 1.4,
          },
          {
            id: 2,
            user_id: 22,
            shop_name: 'Braids Only',
            latitude: -26.205,
            longitude: 28.046,
            rating: 4.9,
            queue_count: 1,
            estimated_wait_time: 8,
            distance: 1.2,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          { barber_id: 1, name: 'premium fade' },
          { barber_id: 2, name: 'knotless braids' },
        ],
      });

    const res = await request(app)
      .get('/api/barbers/dispatch?lat=-26.2041&lng=28.0473&serviceType=fade');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(1);
    expect(res.body[0].has_service_match).toBe(true);
    expect(res.body[0].service_fallback).toBe(false);
  });

  test('GET /api/barbers/dispatch marks service_fallback when no service matches exist', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            user_id: 21,
            shop_name: 'General Cuts',
            latitude: -26.204,
            longitude: 28.047,
            rating: 4.7,
            queue_count: 2,
            estimated_wait_time: 12,
            distance: 1.4,
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ barber_id: 1, name: 'kids haircut' }],
      });

    const res = await request(app)
      .get('/api/barbers/dispatch?lat=-26.2041&lng=28.0473&serviceType=braids');

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].has_service_match).toBe(false);
    expect(res.body[0].service_fallback).toBe(true);
  });

  test('GET /api/barbers/dispatch includes repeat affinity count for customer', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            user_id: 21,
            shop_name: 'Repeat Barber',
            latitude: -26.204,
            longitude: 28.047,
            rating: 4.7,
            queue_count: 2,
            estimated_wait_time: 12,
            distance: 1.4,
          },
          {
            id: 2,
            user_id: 22,
            shop_name: 'New Barber',
            latitude: -26.205,
            longitude: 28.046,
            rating: 4.7,
            queue_count: 2,
            estimated_wait_time: 12,
            distance: 1.5,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ barber_id: 1, completed_count: 3 }] });

    const res = await request(app)
      .get('/api/barbers/dispatch?lat=-26.2041&lng=28.0473&customerId=50');

    expect(res.status).toBe(200);
    const repeatBarber = res.body.find(item => item.id === 1);
    const newBarber = res.body.find(item => item.id === 2);

    expect(repeatBarber.repeat_affinity_count).toBe(3);
    expect(newBarber.repeat_affinity_count).toBe(0);
  });

  test('POST /api/barbers/status validates isOnline type', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/api/barbers/status')
      .set('x-user-id', '11')
      .send({ isOnline: 'true' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('isOnline must be a boolean');
  });

  test('POST /api/barbers/status returns 403 when profile is missing', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/barbers/status')
      .set('x-user-id', '11')
      .send({ isOnline: true });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Barber profile not found');
  });

  test('POST /api/barbers/status auto-creates profile when missing and updates status', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ first_name: 'Demo', last_name: 'Barber' }] })
      .mockResolvedValueOnce({ rows: [{ id: 99, is_active: false }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/barbers/status')
      .set('x-user-id', '11')
      .send({ isOnline: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, isOnline: true });
    expect(pool.query).toHaveBeenNthCalledWith(
      4,
      'UPDATE barber_profiles SET is_active = $1 WHERE id = $2',
      [true, 99]
    );
  });

  test('POST /api/barbers/status updates active status for barber profile', async () => {
    const app = createTestApp();

    pool.query
      .mockResolvedValueOnce({ rows: [{ id: 7 }] })
      .mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .post('/api/barbers/status')
      .set('x-user-id', '11')
      .send({ isOnline: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, isOnline: false });

    expect(pool.query).toHaveBeenNthCalledWith(
      2,
      'UPDATE barber_profiles SET is_active = $1 WHERE id = $2',
      [false, 7]
    );
  });
});
