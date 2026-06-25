/**
 * validate(schema, source?)
 *
 * Returns an Express middleware that validates req[source] against a Joi schema.
 * Strips unknown fields, collects all errors in one response, and replaces the
 * original input with the sanitized/coerced value so downstream handlers are safe.
 *
 * Usage:
 *   const { validate, Joi } = require('../middleware/validate');
 *
 *   router.post('/register', validate(registerSchema), handler);
 *   router.get('/nearby',    validate(nearbySchema, 'query'), handler);
 */

const Joi = require('joi');

function validate(schema, source = 'body') {
  return (req, res, next) => {
    const { error, value } = schema.validate(req[source], {
      abortEarly: false,    // collect ALL errors, not just the first
      stripUnknown: true,   // remove unexpected fields silently
      convert: true,        // coerce strings to numbers/booleans where the schema says so
    });

    if (error) {
      const message = error.details.map(d => d.message).join('; ');
      return res.status(400).json({ error: message });
    }

    // Replace with the sanitized + coerced value so handlers get clean data
    req[source] = value;
    return next();
  };
}

module.exports = { validate, Joi };
