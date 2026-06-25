const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const BASE_URL = process.env.REHEARSAL_BASE_URL || 'http://localhost:3001/api';
const HEALTH_URL = BASE_URL.replace(/\/api$/, '/api/health');
const JWT_SECRET = process.env.JWT_SECRET;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(endpoint, options = {}) {
  const response = await fetch(`${BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const body = await response.json().catch(() => ({}));

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}

function record(results, name, pass, details) {
  results.push({ name, pass, details });
  const marker = pass ? 'PASS' : 'FAIL';
  console.log(`[${marker}] ${name} - ${details}`);
}

async function waitForBackend(maxAttempts = 8) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(HEALTH_URL, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.status === 'ok') {
        return { up: true, db: body.db };
      }
      if (res.status === 503) {
        // Server is up but DB is degraded — report it and stop waiting
        return { up: true, db: body.db || 'unreachable' };
      }
    } catch (_) {
      // Server not yet accepting connections — keep retrying
    }
    await sleep(800);
  }
  return { up: false, db: 'unknown' };
}

function buildReportMarkdown({ startedAt, finishedAt, baseUrl, results, context }) {
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const overall = passed === total ? 'PASS' : 'FAIL';

  const lines = [];
  lines.push('# Live API Rehearsal Report');
  lines.push('');
  lines.push(`Date: ${finishedAt}`);
  lines.push(`Backend Base URL: ${baseUrl}`);
  lines.push(`Duration: ${Math.round((new Date(finishedAt) - new Date(startedAt)) / 1000)}s`);
  lines.push('');
  lines.push('## Overall Result');
  lines.push(`- Status: ${overall}`);
  lines.push(`- Passed: ${passed}/${total}`);
  lines.push('');
  lines.push('## Rehearsal Context');
  lines.push(`- Barber Profile ID: ${context.barberProfileId || 'N/A'}`);
  lines.push(`- Barber User ID: ${context.barberUserId || 'N/A'}`);
  lines.push(`- Booking ID: ${context.bookingId || 'N/A'}`);
  lines.push(`- Customer Email: ${context.customerEmail || 'N/A'}`);
  lines.push('');
  lines.push('## Step Results');

  for (const result of results) {
    lines.push(`- [${result.pass ? 'PASS' : 'FAIL'}] ${result.name}: ${result.details}`);
  }

  lines.push('');
  lines.push('## Notes');
  lines.push('- This rehearsal validates live API behavior against a running local backend and database.');
  lines.push('- Mobile UI/device interaction still requires separate manual device-level verification.');

  return lines.join('\n');
}

async function run() {
  const startedAt = new Date().toISOString();
  const results = [];
  const context = {
    barberProfileId: null,
    barberUserId: null,
    bookingId: null,
    customerEmail: null,
  };

  if (!JWT_SECRET) {
    record(results, 'Environment readiness', false, 'JWT_SECRET missing in backend .env');
  } else {
    record(results, 'Environment readiness', true, 'JWT_SECRET found');
  }

  const backendStatus = await waitForBackend();
  if (!backendStatus.up) {
    record(results, 'Backend availability', false, 'Backend not reachable at rehearsal base URL');
    const report = buildReportMarkdown({
      startedAt,
      finishedAt: new Date().toISOString(),
      baseUrl: BASE_URL,
      results,
      context,
    });
    const reportPath = path.join(__dirname, '..', '..', 'LIVE_REHEARSAL_REPORT.md');
    fs.writeFileSync(reportPath, report, 'utf8');
    process.exitCode = 1;
    return;
  }
  record(
    results,
    'Backend availability',
    true,
    `Health check OK — DB: ${backendStatus.db}`
  );

  const dispatchJhb = await requestJson('/barbers/dispatch?lat=-26.2041&lng=28.0473&limit=3');
  let dispatchBody = Array.isArray(dispatchJhb.body) ? dispatchJhb.body : [];

  if (dispatchBody.length === 0) {
    const dispatchNy = await requestJson('/barbers/dispatch?lat=40.7128&lng=-74.0060&limit=3');
    dispatchBody = Array.isArray(dispatchNy.body) ? dispatchNy.body : [];
  }

  if (dispatchBody.length === 0) {
    record(results, 'Dispatch returns available barber', false, 'No barbers returned from configured test coordinates');
  } else {
    const first = dispatchBody[0];
    context.barberProfileId = Number(first.id);
    context.barberUserId = Number(first.user_id);
    record(results, 'Dispatch returns available barber', true, `Found barber profile ${context.barberProfileId}`);
  }

  const customerEmail = `rehearsal.customer.${Date.now()}@trimride.app`;
  context.customerEmail = customerEmail;
  const customerPassword = 'TempPass123!';

  const registerResponse = await requestJson('/auth/register', {
    method: 'POST',
    body: JSON.stringify({
      email: customerEmail,
      password: customerPassword,
      firstName: 'Rehearsal',
      lastName: 'Customer',
      userType: 'customer',
      phone: '+27100000000',
    }),
  });

  let customerToken = null;
  if (registerResponse.ok && registerResponse.body?.token) {
    customerToken = registerResponse.body.token;
    record(results, 'Customer registration', true, 'Temporary customer account created');
  } else {
    record(results, 'Customer registration', false, `Register failed (${registerResponse.status})`);
  }

  if (customerToken) {
    const meRes = await requestJson('/auth/me', {
      headers: { Authorization: `Bearer ${customerToken}` },
    });

    if (meRes.ok && meRes.body?.user?.email === customerEmail) {
      record(results, 'Customer token + /auth/me', true, 'Authenticated customer profile resolved');
    } else {
      record(results, 'Customer token + /auth/me', false, `Customer /me failed (${meRes.status})`);
    }
  } else {
    record(results, 'Customer token + /auth/me', false, 'Skipped because registration failed');
  }

  let barberToken = null;
  if (JWT_SECRET && context.barberUserId) {
    barberToken = jwt.sign({ userId: context.barberUserId }, JWT_SECRET, { expiresIn: '1h' });
    record(results, 'Barber token generation', true, `Generated token for barber user ${context.barberUserId}`);
  } else {
    record(results, 'Barber token generation', false, 'Missing JWT secret or barber user id');
  }

  if (customerToken && context.barberProfileId) {
    const bookRes = await requestJson('/customers/book', {
      method: 'POST',
      headers: { Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify({
        barberId: context.barberProfileId,
        bookingType: 'queue',
      }),
    });

    if (bookRes.ok && bookRes.body?.id) {
      context.bookingId = Number(bookRes.body.id);
      record(results, 'Customer booking request', true, `Booking created with id ${context.bookingId}`);
    } else {
      record(results, 'Customer booking request', false, `Booking failed (${bookRes.status})`);
    }
  } else {
    record(results, 'Customer booking request', false, 'Skipped because token/barber unavailable');
  }

  if (barberToken) {
    const requestsRes = await requestJson('/bookings/my-requests', {
      headers: { Authorization: `Bearer ${barberToken}` },
    });

    if (requestsRes.ok && Array.isArray(requestsRes.body)) {
      const found = context.bookingId
        ? requestsRes.body.some(item => Number(item.id) === context.bookingId)
        : false;
      record(results, 'Barber incoming requests visibility', found, found ? 'Booking visible to barber' : 'Booking not visible in barber queue');
    } else {
      record(results, 'Barber incoming requests visibility', false, `my-requests failed (${requestsRes.status})`);
    }
  } else {
    record(results, 'Barber incoming requests visibility', false, 'Skipped because barber token unavailable');
  }

  if (barberToken && context.bookingId) {
    const respondRes = await requestJson(`/bookings/${context.bookingId}/respond`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${barberToken}` },
      body: JSON.stringify({ action: 'accept' }),
    });

    if (respondRes.ok && respondRes.body?.status === 'confirmed') {
      record(results, 'Barber accepts booking', true, 'Booking transitioned to confirmed');
    } else {
      record(results, 'Barber accepts booking', false, `Respond failed (${respondRes.status})`);
    }
  } else {
    record(results, 'Barber accepts booking', false, 'Skipped because booking/barber token unavailable');
  }

  if (customerToken) {
    const activeRes = await requestJson('/customers/my-booking', {
      headers: { Authorization: `Bearer ${customerToken}` },
    });

    const activeOk = activeRes.ok && activeRes.body && Number(activeRes.body.id) === context.bookingId;
    record(results, 'Customer active booking fetch', activeOk, activeOk ? `Active booking id ${context.bookingId} resolved` : `Active booking check failed (${activeRes.status})`);
  } else {
    record(results, 'Customer active booking fetch', false, 'Skipped because customer token unavailable');
  }

  if (barberToken && context.bookingId) {
    const locationRes = await requestJson(`/bookings/${context.bookingId}/location`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${barberToken}` },
      body: JSON.stringify({ latitude: -26.2041, longitude: 28.0473 }),
    });

    record(results, 'Barber location update API', locationRes.ok, locationRes.ok ? 'Location update accepted' : `Location update failed (${locationRes.status})`);
  } else {
    record(results, 'Barber location update API', false, 'Skipped because booking/barber token unavailable');
  }

  if (context.bookingId) {
    const paymentRes = await requestJson('/payments/process', {
      method: 'POST',
      body: JSON.stringify({
        bookingId: context.bookingId,
        amount: 180,
        paymentMethod: 'card',
      }),
    });

    record(results, 'Payment processing API', paymentRes.ok, paymentRes.ok ? 'Payment persisted and booking marked paid' : `Payment failed (${paymentRes.status})`);
  } else {
    record(results, 'Payment processing API', false, 'Skipped because booking was not created');
  }

  if (customerToken) {
    const historyRes = await requestJson('/customers/my-bookings?limit=5', {
      headers: { Authorization: `Bearer ${customerToken}` },
    });

    const inHistory = historyRes.ok && Array.isArray(historyRes.body)
      ? historyRes.body.some(item => Number(item.id) === context.bookingId)
      : false;

    record(results, 'Customer booking history includes booking', inHistory, inHistory ? `Booking ${context.bookingId} found in history` : `History check failed (${historyRes.status})`);
  } else {
    record(results, 'Customer booking history includes booking', false, 'Skipped because customer token unavailable');
  }

  const finishedAt = new Date().toISOString();
  const report = buildReportMarkdown({
    startedAt,
    finishedAt,
    baseUrl: BASE_URL,
    results,
    context,
  });

  const reportPath = path.join(__dirname, '..', '..', 'LIVE_REHEARSAL_REPORT.md');
  fs.writeFileSync(reportPath, report, 'utf8');

  const allPass = results.every(r => r.pass);
  if (!allPass) {
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('Live rehearsal runner failed:', error);
  process.exitCode = 1;
});
