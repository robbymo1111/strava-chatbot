/**
 * Activity notes and weekly training targets
 *
 * GET  /api/activity-notes?accessToken=xxx
 *      &activityIds=id1,id2,id3        (comma-separated)
 *      [&weekKeys=2026-W14,2026-W15]   (optional)
 *   → { activities: { id: { title, notes } }, weeks: { key: { notes, targetMiles } } }
 *
 * POST /api/activity-notes
 *   body: { accessToken, activityId, title?, notes? }   — save activity note
 *      OR { accessToken, weekKey,    notes?, targetMiles? } — save weekly data
 *   → { ok: true }
 *
 * KV keys:
 *   note:a:{athleteId}:{activityId}  →  { title, notes, updatedAt }
 *   note:w:{athleteId}:{weekKey}     →  { notes, targetMiles, updatedAt }
 */
module.exports = async (req, res) => {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const accessToken = req.method === 'GET'
    ? req.query.accessToken
    : req.body?.accessToken;

  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  // Graceful degradation when KV is not configured
  if (!kvUrl || !kvToken) {
    if (req.method === 'GET') return res.status(200).json({ activities: {}, weeks: {} });
    return res.status(200).json({ ok: true });
  }

  // Resolve athlete ID
  const athleteId = await getAthleteId(accessToken);
  if (!athleteId) {
    if (req.method === 'GET') return res.status(200).json({ activities: {}, weeks: {} });
    return res.status(200).json({ ok: true });
  }

  /* ── GET ── */
  if (req.method === 'GET') {
    const activityIds = (req.query.activityIds || '').split(',').map(s => s.trim()).filter(Boolean);
    const weekKeys    = (req.query.weekKeys    || '').split(',').map(s => s.trim()).filter(Boolean);

    const activities = {};
    const weeks      = {};

    // Batch fetch with Upstash pipeline
    const pipeline = [
      ...activityIds.map(id  => ['GET', `note:a:${athleteId}:${id}`]),
      ...weekKeys.map(k      => ['GET', `note:w:${athleteId}:${k}`]),
    ];

    if (pipeline.length) {
      try {
        const r    = await fetch(`${kvUrl}/pipeline`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(pipeline),
        });
        const rows = await r.json(); // array of { result: jsonString | null }

        activityIds.forEach((id, i) => {
          const raw = rows[i]?.result;
          if (raw) try { activities[id] = JSON.parse(raw); } catch (_) {}
        });
        weekKeys.forEach((k, i) => {
          const raw = rows[activityIds.length + i]?.result;
          if (raw) try { weeks[k] = JSON.parse(raw); } catch (_) {}
        });
      } catch (_) {}
    }

    return res.status(200).json({ activities, weeks });
  }

  /* ── POST ── */
  if (req.method === 'POST') {
    const { activityId, weekKey, title, notes, targetMiles } = req.body || {};

    if (activityId) {
      const key     = `note:a:${athleteId}:${activityId}`;
      const current = await kvGet(kvUrl, kvToken, key) || {};
      const updated = Object.assign({}, current, {
        ...(title      !== undefined ? { title }      : {}),
        ...(notes      !== undefined ? { notes }      : {}),
        updatedAt: Date.now(),
      });
      await kvSet(kvUrl, kvToken, key, updated);
    } else if (weekKey) {
      const key     = `note:w:${athleteId}:${weekKey}`;
      const current = await kvGet(kvUrl, kvToken, key) || {};
      const updated = Object.assign({}, current, {
        ...(notes       !== undefined ? { notes }       : {}),
        ...(targetMiles !== undefined ? { targetMiles } : {}),
        updatedAt: Date.now(),
      });
      await kvSet(kvUrl, kvToken, key, updated);
    }

    return res.status(200).json({ ok: true });
  }

  return res.status(405).send('Method Not Allowed');
};

/* ── KV helpers ──────────────────────────────────────────────────────────── */

async function getAthleteId(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const a = await r.json();
    return a.id ? String(a.id) : null;
  } catch (_) { return null; }
}

async function kvGet(url, token, key) {
  const r    = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await r.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch (_) { return null; }
}

async function kvSet(url, token, key, value) {
  await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify([['SET', key, JSON.stringify(value)]]),
  });
}
