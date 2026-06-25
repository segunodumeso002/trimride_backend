/**
 * Request logger middleware.
 * - Development: human-readable coloured output
 * - Production: single-line JSON (easy to ingest into any log aggregator)
 */

const isProd = process.env.NODE_ENV === 'production';

module.exports = function requestLogger(req, res, next) {
  const start = Date.now();

  // Capture status/duration after the response finishes
  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    if (isProd) {
      // Structured JSON — ingestible by Datadog, CloudWatch, Papertrail, etc.
      const entry = {
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status,
        ms: duration,
        ip: req.ip,
      };
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(entry));
    } else {
      // Dev: coloured, readable
      const colour =
        status >= 500 ? '\x1b[31m' // red
        : status >= 400 ? '\x1b[33m' // yellow
        : status >= 300 ? '\x1b[36m' // cyan
        : '\x1b[32m'; // green
      const reset = '\x1b[0m';
      // eslint-disable-next-line no-console
      console.log(
        `${colour}${req.method}${reset} ${req.path} → ${colour}${status}${reset} (${duration}ms)`
      );
    }
  });

  next();
};
