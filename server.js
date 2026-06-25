const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3000;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:8081';

// Security middleware
app.use(helmet());
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json());

// Request logging (before routes so every request is captured)
app.use(requestLogger);

// Rate limiting
const isDevelopment = process.env.NODE_ENV !== 'production';
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDevelopment ? 3000 : 300,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) =>
    req.path === '/api/health' ||
    req.path.startsWith('/api/barbers/dispatch'),
});
app.use(limiter);

// Stricter rate limit for auth endpoints to prevent brute-force attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15 minutes
  max: 25,
  message: 'Too many authentication attempts. Please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Routes
app.use('/api/auth', authLimiter, require('./routes/auth'));
app.use('/api/barbers', require('./routes/barbers'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/bookings', require('./routes/bookings'));
app.use('/api/payments', require('./routes/payments'));
app.use('/api/notifications', require('./routes/notifications'));

// Health endpoint — no auth, no rate-limit, exempt from request logger noise.
// Returns DB connectivity status so uptime monitors get a meaningful signal.
app.get('/api/health', async (req, res) => {
  const started = Date.now();
  try {
    const db = require('./config/database');
    await db.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      uptime: Math.floor(process.uptime()),
      ts: new Date().toISOString(),
      latencyMs: Date.now() - started,
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      db: 'unreachable',
      error: err.message,
      ts: new Date().toISOString(),
    });
  }
});

// Global error handler — must come after all routes
app.use(errorHandler);

// Socket.io for real-time features
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
  cors: { origin: CLIENT_ORIGIN, methods: ["GET", "POST"] }
});

app.set('io', io);

require('./services/socketService')(io);

// Process-level crash guards — prevent silent exits in production
process.on('unhandledRejection', (reason, promise) => {
  console.error({
    ts: new Date().toISOString(),
    event: 'unhandledRejection',
    reason: reason instanceof Error ? reason.stack : reason,
    promise,
  });
  // Do NOT exit; let the request time out naturally so other requests keep serving.
  // For a critical service you may want to exit(1) here and let the process manager restart.
});

process.on('uncaughtException', (err) => {
  console.error({
    ts: new Date().toISOString(),
    event: 'uncaughtException',
    message: err.message,
    stack: err.stack,
  });
  // uncaughtException leaves the process in an undefined state — exit and let PM2/Docker restart it.
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Barber Backend running on port ${PORT}`);
});

module.exports = app;
