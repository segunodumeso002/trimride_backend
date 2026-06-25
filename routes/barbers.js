const express = require('express');
const router = express.Router();
const pool = require('../config/database');
const requireAuth = require('../middleware/auth');
const { validate, Joi } = require('../middleware/validate');

function normalizedEnvEmail(key) {
  if (process.env.NODE_ENV === 'test') {
    return '';
  }
  return String(process.env[key] || '').trim().toLowerCase();
}

const serviceBodySchema = Joi.object({
  name:        Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(500).optional().allow('', null),
  price:       Joi.number().positive().max(10000).required(),
  duration:    Joi.number().integer().positive().max(480).required(), // minutes, max 8h
  is_active:   Joi.boolean().optional(),
});

const coordQuerySchema = Joi.object({
  lat:    Joi.number().min(-90).max(90).required(),
  lng:    Joi.number().min(-180).max(180).required(),
  radius: Joi.number().positive().max(100).default(5),
}).unknown(true); // allow extra query params like limit / serviceType

async function ensureBarberProfile(userId) {
  const barberResult = await pool.query(
    'SELECT id, is_active FROM barber_profiles WHERE user_id = $1 LIMIT 1',
    [userId]
  );

  if (barberResult.rows.length > 0) {
    return barberResult.rows[0];
  }

  const userResult = await pool.query(
    'SELECT first_name, last_name FROM users WHERE id = $1 LIMIT 1',
    [userId]
  );

  if (userResult.rows.length === 0) {
    return null;
  }

  const user = userResult.rows[0];
  const created = await pool.query(
    `INSERT INTO barber_profiles (
       user_id, shop_name, shop_address, latitude, longitude, description,
       is_active, rating, queue_count, estimated_wait_time
     ) VALUES ($1, $2, $3, $4, $5, $6, false, 0.00, 0, 0)
     RETURNING id, is_active`,
    [
      userId,
      `${user.first_name} ${user.last_name} Barber`,
      'Johannesburg Demo Zone',
      -26.2041,
      28.0473,
      'Profile auto-created during status sync',
    ]
  );

  return created.rows[0] || null;
}

// Get barber services
router.get('/:barberId/services', async (req, res) => {
  const { barberId } = req.params;
  
  try {
    const result = await pool.query(
      'SELECT * FROM services WHERE barber_id = $1 AND is_active = true ORDER BY name',
      [barberId]
    );
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add new service
router.post('/:barberId/services', requireAuth, validate(serviceBodySchema), async (req, res) => {
  const { barberId } = req.params;
  const { name, description, price, duration } = req.body;
  
  try {
    const result = await pool.query(
      'INSERT INTO services (barber_id, name, description, price, duration) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [barberId, name, description, price, duration]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update service
router.put('/services/:serviceId', requireAuth, validate(serviceBodySchema), async (req, res) => {
  const { serviceId } = req.params;
  const { name, description, price, duration, is_active } = req.body;
  
  try {
    const result = await pool.query(
      'UPDATE services SET name = $1, description = $2, price = $3, duration = $4, is_active = $5 WHERE id = $6 RETURNING *',
      [name, description, price, duration, is_active, serviceId]
    );
    res.json(result.rows[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get nearby barbers with queue info
router.get('/nearby', validate(coordQuerySchema, 'query'), async (req, res) => {
  const { lat, lng, radius } = req.query;
  
  try {
    const result = await pool.query(`
      SELECT bp.*, u.first_name, u.last_name,
             (6371 * acos(cos(radians($1)) * cos(radians(bp.latitude)) * 
             cos(radians(bp.longitude) - radians($2)) + sin(radians($1)) * 
             sin(radians(bp.latitude)))) AS distance
      FROM barber_profiles bp
      JOIN users u ON bp.user_id = u.id
      WHERE bp.is_active = true
      ORDER BY bp.queue_count ASC, bp.rating DESC
    `, [lat, lng]);

    // Filter by radius in JavaScript for simplicity
    const filteredResults = result.rows.filter(barber => 
      parseFloat(barber.distance) <= parseFloat(radius)
    );

    res.json(filteredResults);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Dispatch endpoint: rank barbers by distance, queue load, wait time, and rating.
router.get('/dispatch', validate(coordQuerySchema, 'query'), async (req, res) => {
  const { lat, lng, radius = 8, limit = 5, serviceType, customerId } = req.query;
  const demoLockedBarberEmail = normalizedEnvEmail('DEMO_LOCK_BARBER_EMAIL');

  // lat/lng presence already guaranteed by coordQuerySchema

  try {
    const result = await pool.query(
      `
      SELECT bp.id, bp.user_id, bp.shop_name, bp.latitude, bp.longitude, bp.rating, bp.queue_count, bp.estimated_wait_time,
             (6371 * acos(cos(radians($1)) * cos(radians(bp.latitude)) *
             cos(radians(bp.longitude) - radians($2)) + sin(radians($1)) *
             sin(radians(bp.latitude)))) AS distance
      FROM barber_profiles bp
      JOIN users u ON u.id = bp.user_id
      WHERE bp.is_active = true
        AND ($3 = '' OR LOWER(u.email) = $3)
      `,
      [lat, lng, demoLockedBarberEmail]
    );

    const hotspotZones = [
      { lat: -26.2041, lng: 28.0473, radiusKm: 2.2, boost: 0.18 },
      { lat: -26.1076, lng: 28.0567, radiusKm: 1.8, boost: 0.12 },
    ];

    const serviceResult = await pool.query(
      'SELECT barber_id, LOWER(name) AS name FROM services WHERE is_active = true'
    );

    const serviceMap = new Map();
    serviceResult.rows.forEach(row => {
      if (!serviceMap.has(row.barber_id)) {
        serviceMap.set(row.barber_id, []);
      }
      serviceMap.get(row.barber_id).push(row.name);
    });

    const normalizedServiceType = serviceType ? String(serviceType).trim().toLowerCase() : '';
    const normalizedCustomerId = customerId ? Number(customerId) : null;
    const serviceAliases = {
      fade: ['fade', 'haircut', 'cut', 'trim', 'clipper'],
      beard: ['beard', 'shave', 'mustache', 'goatee'],
      braids: ['braid', 'braids', 'cornrow', 'loc', 'twist', 'plait'],
    };
    const requestedKeywords = normalizedServiceType
      ? serviceAliases[normalizedServiceType] || [normalizedServiceType]
      : [];

    let affinityMap = new Map();
    if (normalizedCustomerId) {
      const affinityResult = await pool.query(
        `
        SELECT barber_id, COUNT(*)::int AS completed_count
        FROM bookings
        WHERE customer_id = $1 AND status = 'completed'
        GROUP BY barber_id
        `,
        [normalizedCustomerId]
      );

      affinityMap = new Map(
        affinityResult.rows.map(row => [Number(row.barber_id), Number(row.completed_count)])
      );
    }

    const hour = new Date().getHours();
    const isPeakHour = (hour >= 7 && hour <= 10) || (hour >= 16 && hour <= 20);

    const ranked = result.rows
      .map(row => {
        const distanceKm = parseFloat(row.distance);
        const queueCount = Number(row.queue_count || 0);
        const estimatedWait = Number(row.estimated_wait_time || 0);
        const rating = Number(row.rating || 0);
        const ratingPenalty = 5 - rating;
        const activeServices = serviceMap.get(row.id) || [];
        const hasServiceMatch =
          !normalizedServiceType ||
          activeServices.some(serviceName =>
            requestedKeywords.some(keyword => serviceName.includes(keyword))
          );

        const inHotspot = hotspotZones.some(zone => {
          const latDelta = row.latitude - zone.lat;
          const lngDelta = row.longitude - zone.lng;
          const approxDistanceKm = Math.sqrt(latDelta * latDelta + lngDelta * lngDelta) * 111;
          return approxDistanceKm <= zone.radiusKm;
        });

        const hotspotBoost = inHotspot ? 1 : 0;
        const servicePenalty = hasServiceMatch ? 0 : 1.4;

        const repeatCount = affinityMap.get(Number(row.id)) || 0;
        const repeatAffinityBoost = Math.min(repeatCount * 0.12, 0.6);
        const demandPenalty = isPeakHour ? queueCount * 0.08 : 0;

        const score =
          distanceKm * 0.45 +
          queueCount * 0.18 +
          estimatedWait * 0.14 +
          ratingPenalty * 0.08 +
          demandPenalty +
          servicePenalty -
          repeatAffinityBoost -
          hotspotBoost * 0.2;

        return {
          ...row,
          has_service_match: hasServiceMatch,
          service_fallback: false,
          hotspot_boosted: inHotspot,
          repeat_affinity_count: repeatCount,
          peak_hour_adjusted: isPeakHour,
          dispatch_score: Number(score.toFixed(4)),
        };
      })
      .filter(row => row.distance <= Number(radius))
      .sort((a, b) => a.dispatch_score - b.dispatch_score);

    let dispatchResults = ranked;

    if (normalizedServiceType) {
      const matchedResults = ranked.filter(row => row.has_service_match);
      if (matchedResults.length > 0) {
        dispatchResults = matchedResults;
      } else {
        dispatchResults = ranked.map(row => ({
          ...row,
          service_fallback: true,
        }));
      }
    }

    return res.json(dispatchResults.slice(0, Number(limit)));
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Barber sets online/offline status
router.post('/status', requireAuth, async (req, res) => {
  const { isOnline } = req.body;

  if (typeof isOnline !== 'boolean') {
    return res.status(400).json({ error: 'isOnline must be a boolean' });
  }

  try {
    const barberProfile = await ensureBarberProfile(req.userId);
    if (!barberProfile) {
      return res.status(403).json({ error: 'Barber profile not found' });
    }

    await pool.query(
      'UPDATE barber_profiles SET is_active = $1 WHERE id = $2',
      [isOnline, barberProfile.id]
    );

    return res.json({ ok: true, isOnline });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

// Get current barber online/offline status
router.get('/status', requireAuth, async (req, res) => {
  try {
    const barberProfile = await ensureBarberProfile(req.userId);
    if (!barberProfile) {
      return res.status(403).json({ error: 'Barber profile not found' });
    }

    return res.json({ ok: true, isOnline: !!barberProfile.is_active });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

module.exports = router;