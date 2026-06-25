const pool = require('../config/database');

async function run() {
  try {
    const email = 'barber.resume.test@trimride.app';
    const userRes = await pool.query('SELECT id, email, user_type FROM users WHERE email = $1 LIMIT 1', [email]);
    if (userRes.rows.length === 0) {
      throw new Error('Barber demo user not found: ' + email);
    }
    const user = userRes.rows[0];
    if (user.user_type !== 'barber') {
      throw new Error('User exists but is not barber type: ' + JSON.stringify(user));
    }

    let profileRes = await pool.query('SELECT id, user_id, is_active FROM barber_profiles WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [user.id]);
    let profileId;
    if (profileRes.rows.length === 0) {
      const insertRes = await pool.query(
        `INSERT INTO barber_profiles (user_id, shop_name, shop_address, latitude, longitude, description, is_active, rating, queue_count, estimated_wait_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id`,
        [
          user.id,
          'TrimRide Demo Barber',
          'Johannesburg Demo Zone',
          -26.2041,
          28.0473,
          'Demo barber profile for investor rehearsal',
          true,
          4.8,
          0,
          5,
        ]
      );
      profileId = insertRes.rows[0].id;
      console.log('Created barber profile id:', profileId);
    } else {
      profileId = profileRes.rows[0].id;
      await pool.query('UPDATE barber_profiles SET is_active = true, latitude = $2, longitude = $3, shop_name = $4 WHERE id = $1', [
        profileId,
        -26.2041,
        28.0473,
        'TrimRide Demo Barber',
      ]);
      console.log('Updated existing barber profile id:', profileId);
    }

    const services = [
      ['Fade', 'Demo fade service', 25, 30],
      ['Beard', 'Demo beard service', 15, 20],
      ['Braids', 'Demo braids service', 40, 60],
      ['Refresh', 'Demo refresh service', 20, 20],
    ];

    for (const [name, description, price, duration] of services) {
      const exists = await pool.query('SELECT id FROM services WHERE barber_id = $1 AND LOWER(name)=LOWER($2) LIMIT 1', [profileId, name]);
      if (exists.rows.length === 0) {
        await pool.query(
          'INSERT INTO services (barber_id, name, description, price, duration, is_active) VALUES ($1,$2,$3,$4,$5,true)',
          [profileId, name, description, price, duration]
        );
      } else {
        await pool.query('UPDATE services SET is_active = true, price = $3, duration = $4 WHERE id = $1', [exists.rows[0].id, name, price, duration]);
      }
    }

    const summary = await pool.query(
      `SELECT u.email, bp.id AS barber_profile_id, bp.is_active,
              (SELECT COUNT(*) FROM services s WHERE s.barber_id = bp.id AND s.is_active = true) AS active_services
       FROM users u
       JOIN barber_profiles bp ON bp.user_id = u.id
       WHERE u.id = $1`,
      [user.id]
    );
    console.log('Summary:', summary.rows[0]);
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
