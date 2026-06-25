/**
 * Global error handler — must be registered AFTER all routes.
 *
 * Express calls this whenever a route calls next(err) or throws inside
 * an async handler wrapped with a try/catch that forwards to next().
 *
 * - In production: hides internal details from the client to prevent
 *   information leakage (OWASP A05:2021 Security Misconfiguration).
 * - In development: returns the full stack so engineers can debug quickly.
 */

const isProd = process.env.NODE_ENV === 'production';

// eslint-disable-next-line no-unused-vars
module.exports = function errorHandler(err, req, res, next) {
  const status = err.status || err.statusCode || 500;

  // Always log the full error server-side
  // eslint-disable-next-line no-console
  console.error({
    ts: new Date().toISOString(),
    method: req.method,
    path: req.path,
    status,
    message: err.message,
    stack: err.stack,
  });

  if (res.headersSent) {
    // If headers were already sent (e.g. streaming), let Express default close the connection
    return next(err);
  }

  res.status(status).json({
    error: isProd ? 'An unexpected error occurred. Please try again later.' : err.message,
    ...(isProd ? {} : { stack: err.stack }),
  });
};
