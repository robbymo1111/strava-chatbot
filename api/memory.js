/**
 * GET  /api/memory?accessToken=xxx  →  { memory: {...} | null }
 * POST /api/memory                  →  body: { accessToken, memory }  →  { ok: true }
 *
 * Memory is stored in Vercel KV (Upstash Redis) keyed by Strava athlete ID.
 * The Strava access token is used to verify identity before every read/write.
 *
 * Required env vars: KV_REST_API_URL, KV_REST_API_TOKEN
 */
module.exports = async (req, res) => {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // If KV is not configured, degrade gracefully so localStorage still works
  if (!kvUrl || !kvToken) {
    if (req.method === 'GET') return res.status(200).json({ memory: null });
    return res.status(200).json({ ok: true });
  }

  const accessToken = req.method === 'GET'
    ? req.query.accessToken
    : req.body?.accessToken;

  if (!accessToken) {
    return res.status(401).json({ error: 'accessToken required.' });
  }

  // Verify the token and resolve the athlete ID via Strava
  let athleteId;
  try {
    const stravaRes = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!stravaRes.ok) {
      // Expired token — return empty rather than erroring
      if (req.method === 'GET') return res.status(200).json({ memory: null });
      return res.status(200).json({ ok: true });
    }
    const athlete = await stravaRes.json();
    athleteId = String(athlete.id);
  } catch (err) {
    if (req.method === 'GET') return res.status(200).json({ memory: null });
    return res.status(200).json({ ok: true });
  }

  const key = `memory:${athleteId}`;

  if (req.method === 'GET') {
    try {
      const memory = await kvGet(kvUrl, kvToken, key);
      return res.status(200).json({ memory: memory || null });
    } catch (err) {
      console.error('KV get error:', err);
      return res.status(200).json({ memory: null });
    }
  }

  if (req.method === 'POST') {
    const { memory } = req.body || {};
    if (memory) {
      try {
        await kvSet(kvUrl, kvToken, key, memory);
      } catch (err) {
        console.error('KV set error:', err);
      }
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).send('Method Not Allowed');
};

/* ── Upstash REST helpers (no npm required) ── */

async function kvGet(url, token, key) {
  const res  = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await res.json();
  if (!data.result) return null;
  // Value is stored as a JSON string; parse it
  try { return JSON.parse(data.result); } catch (_) { return null; }
}

async function kvSet(url, token, key, value) {
  // Use the Upstash pipeline API: [["SET", key, jsonString]]
  // This avoids any encoding ambiguity with the simple REST endpoint
  const jsonStr = JSON.stringify(value);
  await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: {
      Authorization:  `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([['SET', key, jsonStr]]),
  });
}
