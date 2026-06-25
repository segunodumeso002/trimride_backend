const express = require('express');
const request = require('supertest');
const bcrypt = require('bcryptjs');

jest.mock('../config/database', () => ({
  query: jest.fn(),
}));

jest.mock('../middleware/auth', () => (req, _res, next) => {
  const raw = req.headers['x-user-id'];
  req.userId = raw ? Number(raw) : 1;
  next();
});

jest.mock('jsonwebtoken', () => ({
  sign: jest.fn(() => 'mock-jwt-token'),
}));

const pool = require('../config/database');
const authRouter = require('../routes/auth');

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRouter);
  return app;
}

describe('Auth routes', () => {
  beforeEach(() => {
    pool.query.mockReset();
  });

  test('POST /api/auth/register creates account and returns token + user', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 101,
          email: 'new@trimride.app',
          first_name: 'New',
          last_name: 'User',
          user_type: 'customer',
        },
      ],
    });

    const res = await request(app).post('/api/auth/register').send({
      email: 'new@trimride.app',
      password: 'StrongPass123',
      firstName: 'New',
      lastName: 'User',
      userType: 'customer',
      phone: '+27123456789',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('mock-jwt-token');
    expect(res.body.user).toEqual(
      expect.objectContaining({
        id: 101,
        email: 'new@trimride.app',
        first_name: 'New',
        last_name: 'User',
        user_type: 'customer',
      })
    );

    expect(pool.query).toHaveBeenCalledTimes(1);
    expect(pool.query.mock.calls[0][0]).toContain('INSERT INTO users');
    expect(pool.query.mock.calls[0][1][0]).toBe('new@trimride.app');
    expect(pool.query.mock.calls[0][1][1]).not.toBe('StrongPass123');
  });

  test('POST /api/auth/register returns 400 for duplicate email', async () => {
    const app = createTestApp();

    pool.query.mockRejectedValueOnce({ code: '23505' });

    const res = await request(app).post('/api/auth/register').send({
      email: 'existing@trimride.app',
      password: 'StrongPass123',
      firstName: 'Existing',
      lastName: 'User',
      userType: 'customer',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Email already exists');
  });

  test('POST /api/auth/login returns 401 when user does not exist', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app).post('/api/auth/login').send({
      email: 'missing@trimride.app',
      password: 'StrongPass123',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('POST /api/auth/login returns 401 for wrong password', async () => {
    const app = createTestApp();
    const passwordHash = await bcrypt.hash('CorrectPassword1', 10);

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 33,
          email: 'barber@trimride.app',
          password_hash: passwordHash,
          first_name: 'Mike',
          last_name: 'Cutz',
          user_type: 'barber',
        },
      ],
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'barber@trimride.app',
      password: 'WrongPassword9',
    });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid credentials');
  });

  test('POST /api/auth/login succeeds and returns normalized user fields', async () => {
    const app = createTestApp();
    const passwordHash = await bcrypt.hash('CorrectPassword1', 10);

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 33,
          email: 'barber@trimride.app',
          password_hash: passwordHash,
          first_name: 'Mike',
          last_name: 'Cutz',
          user_type: 'barber',
        },
      ],
    });

    const res = await request(app).post('/api/auth/login').send({
      email: 'barber@trimride.app',
      password: 'CorrectPassword1',
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('mock-jwt-token');
    expect(res.body.user).toEqual({
      id: 33,
      email: 'barber@trimride.app',
      firstName: 'Mike',
      lastName: 'Cutz',
      userType: 'barber',
    });
  });

  test('GET /api/auth/me returns 404 when user is not found', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({ rows: [] });

    const res = await request(app)
      .get('/api/auth/me')
      .set('x-user-id', '88');

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('User not found');
  });

  test('GET /api/auth/me returns authenticated user profile', async () => {
    const app = createTestApp();

    pool.query.mockResolvedValueOnce({
      rows: [
        {
          id: 88,
          email: 'customer@trimride.app',
          first_name: 'Jane',
          last_name: 'Doe',
          user_type: 'customer',
          phone: '+27110000000',
        },
      ],
    });

    const res = await request(app)
      .get('/api/auth/me')
      .set('x-user-id', '88');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      user: {
        id: 88,
        email: 'customer@trimride.app',
        firstName: 'Jane',
        lastName: 'Doe',
        phone: '+27110000000',
        userType: 'customer',
      },
    });
  });
});
