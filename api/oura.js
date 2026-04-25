'use strict';

/**
 * GET /api/oura?accessToken=xxx
 *
 * Fetches Oura Ring recovery data (readiness, sleep, HRV) for the last 30 days,
 * computes HRV baseline and 7-day trend, caches in KV with 12-hour TTL.
 *
 * Requires OURA_ACCESS_TOKEN env var (personal access token from
 * cloud.ouraring.com/personal-access-tokens). Returns { available: false }
 * if env var is not set, so callers can degrade gracefully.
 */

const OURA_BASE = 'https://api.ouraring.com/v2';
const CACHE_TTL = 43200; // 12 hours in seconds

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required.' });

  const ouraToken = process.env.OURA_ACCESS_TOKEN;
  if (!ouraToken) return res.status(200).json({ available: false, reason: 'not_configured' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // Resolve Strava athlete ID (used as the KV namespace)
  let athleteId;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired.' });
    if (!r.ok) return res.status(502).json({ error: 'Could not verify Strava session.' });
    const a = await r.json();
    athleteId = String(a.id);
  } catch (_) {
    return res.status(502).json({ error: 'Could not verify Strava session.' });
  }

  // Check summary cache (one read to serve the whole tab)
  const today    = new Date().toISOString().split('T')[0];
  const cacheKey = `oura:${athleteId}:summary:${today}`;

  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, cacheKey);
    if (cached && cached.available) return res.status(200).json(cached);
  }

  // Fetch 30 days of readiness + sleep from Oura in parallel
  const since30     = dateMinus(today, 30);
  const ouraHeaders = { Authorization: `Bearer ${ouraToken}`, Accept: 'application/json' };

  let readinessItems, sleepItems;
  try {
    const [rRes, sRes] = await Promise.all([
      fetch(`${OURA_BASE}/usercollection/daily_readiness?start_date=${since30}&end_date=${today}`, { headers: ouraHeaders }),
      fetch(`${OURA_BASE}/usercollection/daily_sleep?start_date=${since30}&end_date=${today}`,     { headers: ouraHeaders }),
    ]);

    if (!rRes.ok || !sRes.ok) {
      const status = !rRes.ok ? rRes.status : sRes.status;
      if (status === 401 || status === 403) {
        return res.status(200).json({ available: false, reason: 'invalid_token' });
      }
      return res.status(200).json({ available: false, reason: 'oura_error' });
    }

    readinessItems = (await rRes.json()).data || [];
    sleepItems     = (await sRes.json()).data || [];
  } catch (_) {
    return res.status(200).json({ available: false, reason: 'oura_unreachable' });
  }

  // Normalize and sort ascending by day
  readinessItems.sort((a, b) => a.day.localeCompare(b.day));
  sleepItems.sort((a, b) => a.day.localeCompare(b.day));

  const readinessAll = readinessItems.map(d => ({
    day:   d.day,
    score: d.score ?? null,
    contributors: {
      hrv_balance:        d.contributors?.hrv_balance        ?? null,
      resting_heart_rate: d.contributors?.resting_heart_rate ?? null,
      recovery_index:     d.contributors?.recovery_index     ?? null,
      sleep_balance:      d.contributors?.sleep_balance      ?? null,
      body_temperature:   d.contributors?.body_temperature   ?? null,
    },
  }));

  const sleepAll = sleepItems.map(d => ({
    day:         d.day,
    score:       d.score ?? null,
    durationMin: d.total_sleep_duration != null ? Math.round(d.total_sleep_duration / 60) : null,
    avgHrv:      d.average_hrv ?? null,
    restingHr:   d.lowest_resting_heart_rate ?? null,
    contributors: {
      deep_sleep:  d.contributors?.deep_sleep  ?? null,
      efficiency:  d.contributors?.efficiency  ?? null,
      latency:     d.contributors?.latency     ?? null,
      rem_sleep:   d.contributors?.rem_sleep   ?? null,
      restfulness: d.contributors?.restfulness ?? null,
      timing:      d.contributors?.timing      ?? null,
      total_sleep: d.contributors?.total_sleep ?? null,
    },
  }));

  // HRV baseline: 30-day average
  const hrvValues  = sleepAll.map(d => d.avgHrv).filter(v => v != null);
  const hrvBaseline = hrvValues.length
    ? Math.round(hrvValues.reduce((a, b) => a + b, 0) / hrvValues.length * 10) / 10
    : null;

  // Last 7 days slices
  const readiness7d = readinessAll.slice(-7);
  const sleep7d     = sleepAll.slice(-7);

  // HRV 7-day with % deviation from baseline
  const hrv7d = sleep7d.map(d => {
    const pct = (hrvBaseline && d.avgHrv != null)
      ? Math.round((d.avgHrv - hrvBaseline) / hrvBaseline * 1000) / 10
      : null;
    return { day: d.day, value: d.avgHrv, pctVsBaseline: pct };
  });

  const todayReadiness = readiness7d.length ? readiness7d[readiness7d.length - 1] : null;
  const todayHrv       = hrv7d.length       ? hrv7d[hrv7d.length - 1]             : null;

  const result = {
    available:      true,
    readiness7d,
    sleep7d,
    hrv7d,
    hrvBaseline,
    todayReadiness: todayReadiness?.score ?? null,
    todayHrvPct:    todayHrv?.pctVsBaseline ?? null,
  };

  // Write to KV: summary cache + per-spec individual day keys + baseline
  if (kvUrl && kvToken) {
    const cmds = [
      // Summary (12h TTL — data updates once daily)
      ['SET', cacheKey, JSON.stringify(result), 'EX', CACHE_TTL],
    ];

    if (hrvBaseline != null) {
      cmds.push(['SET', `oura:${athleteId}:hrv-baseline`,
        JSON.stringify({ baseline: hrvBaseline, updatedAt: today })]);
    }

    for (const d of readinessAll) {
      cmds.push(['SET', `oura:${athleteId}:readiness:${d.day}`, JSON.stringify(d), 'EX', CACHE_TTL]);
    }
    for (const d of sleepAll) {
      cmds.push(['SET', `oura:${athleteId}:sleep:${d.day}`, JSON.stringify(d), 'EX', CACHE_TTL]);
    }

    try {
      await fetch(`${kvUrl}/pipeline`, {
        method:  'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(cmds),
      });
    } catch (_) {}
  }

  return res.status(200).json(result);
};

/* ── Helpers ────────────────────────────────────────────────────────────── */

function dateMinus(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

async function kvGet(url, token, key) {
  try {
    const r    = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch (_) { return null; }
}
