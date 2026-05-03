'use strict';

/**
 * GET /api/threshold-drift?accessToken=xxx&maxHR=187
 *
 * Identifies qualifying threshold runs from the last 90 days, computes
 * a longitudinal drift trend (is threshold pace improving or declining?),
 * and stores the history in KV for the Fitness tab and chat system prompt.
 *
 * Qualifying run criteria:
 *   - Run type, duration > 20 min
 *   - Avg HR in threshold zone (86–91% maxHR, or 165–178 bpm if maxHR unknown)
 *   - max_speed / avg_speed < 1.15 (proxy for pace variance < 8% — steady effort)
 *
 * KV keys:
 *   threshold:{athleteId}:drift-history  — full session array (persistent)
 *   threshold:{athleteId}:drift-cache    — computed result (5 min TTL)
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const maxHR   = parseInt(req.query.maxHR) || null;
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  /* ── Resolve athlete ID ── */
  let athleteId;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (!r.ok)           return res.status(502).json({ error: 'Could not verify Strava session' });
    const a = await r.json();
    athleteId = String(a.id);
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  /* ── Check short-lived result cache ── */
  const cacheKey = `threshold:${athleteId}:drift-cache`;
  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, cacheKey);
    if (cached && Date.now() - (cached.builtAt || 0) < 5 * 60 * 1000) {
      return res.status(200).json(cached);
    }
  }

  /* ── Fetch 90 days of activities ── */
  const since90 = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  let activities = [];
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${since90}&per_page=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit reached' });
    if (!r.ok)            return res.status(502).json({ error: 'Could not fetch activities' });
    activities = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'Network error fetching activities' });
  }

  /* ── Threshold HR zone ── */
  // Personalized if maxHR known (86–91%), otherwise generic 165–178
  const threshLow  = maxHR ? Math.round(maxHR * 0.86) : 165;
  const threshHigh = maxHR ? Math.round(maxHR * 0.91) : 178;

  /* ── Identify qualifying sessions ── */
  const qualifying = [];
  for (const a of activities) {
    if (!/run/i.test(a.type || '')) continue;
    const durationMin = (a.moving_time || 0) / 60;
    if (durationMin < 20) continue;

    const avgHR = a.average_heartrate;
    if (!avgHR || avgHR < threshLow || avgHR > threshHigh) continue;

    const avgSpeed = a.average_speed;
    if (!avgSpeed || avgSpeed < 0.1) continue;

    // Steady-effort filter: max_speed / avg_speed < 1.15
    const maxSpeed   = a.max_speed || avgSpeed;
    const speedRatio = maxSpeed / avgSpeed;
    if (speedRatio > 1.15) continue;

    const paceMPM = 1609.34 / avgSpeed / 60;

    qualifying.push({
      date:            (a.start_date_local || a.start_date).split('T')[0],
      activityId:      String(a.id),
      name:            a.name || 'Run',
      paceMPM:         Math.round(paceMPM * 1000) / 1000,
      avgHR:           Math.round(avgHR),
      durationMin:     Math.round(durationMin),
      efficiencyRatio: Math.round((paceMPM / avgHR) * 10000) / 10000,
    });
  }

  /* ── Load + merge with stored history ── */
  const histKey = `threshold:${athleteId}:drift-history`;
  let history = [];
  if (kvUrl && kvToken) {
    const stored = await kvGet(kvUrl, kvToken, histKey);
    if (stored && Array.isArray(stored)) history = stored;
  }

  const existingIds = new Set(history.map(h => h.activityId));
  for (const s of qualifying) {
    if (!existingIds.has(s.activityId)) {
      history.push(s);
      existingIds.add(s.activityId);
    }
  }
  history.sort((a, b) => a.date.localeCompare(b.date));

  /* ── Weighted current estimate (exponential decay, half-life ~4 weeks) ── */
  const now = Date.now();
  const DECAY = 0.85; // per week
  let weightedSum = 0, weightTotal = 0;
  for (const s of history) {
    const weeksAgo = (now - new Date(s.date + 'T12:00:00Z').getTime()) / (7 * 86400 * 1000);
    const w = Math.pow(DECAY, weeksAgo);
    weightedSum  += s.paceMPM * w;
    weightTotal  += w;
  }
  const currentEstimate = weightTotal > 0
    ? Math.round((weightedSum / weightTotal) * 1000) / 1000
    : null;

  /* ── 30-day-ago estimate (for delta display) ── */
  const d30 = new Date(now - 30 * 86400 * 1000).toISOString().split('T')[0];
  const sessionsAt30 = history.filter(h => h.date <= d30);
  const estimate30dAgo = sessionsAt30.length >= 1
    ? Math.round(sessionsAt30.slice(-3).reduce((s, h) => s + h.paceMPM, 0) / Math.min(3, sessionsAt30.length) * 1000) / 1000
    : null;

  /* ── Trend direction: recent 4 sessions vs prior 4 ── */
  let trendDirection = 'flat';
  let trendSeconds   = 0;
  if (history.length >= 4) {
    const recent = history.slice(-4);
    const prior  = history.slice(-8, -4);
    if (prior.length >= 2) {
      const ra = recent.reduce((s, h) => s + h.paceMPM, 0) / recent.length;
      const pa = prior.reduce((s, h) => s + h.paceMPM, 0) / prior.length;
      trendSeconds = Math.round((ra - pa) * 60); // negative = faster = improving
      if (trendSeconds < -5)      trendDirection = 'improving';
      else if (trendSeconds > 5)  trendDirection = 'declining';
    }
  }

  /* ── Flag if threshold has shifted >5 sec/mile in 2 weeks ── */
  const d14 = new Date(now - 14 * 86400 * 1000).toISOString().split('T')[0];
  const recentSessions = history.filter(h => h.date >= d14);
  const olderSessions  = history.filter(h => h.date <  d14).slice(-5);
  let bigShift = false;
  if (recentSessions.length >= 1 && olderSessions.length >= 1) {
    const ra = recentSessions.reduce((s, h) => s + h.paceMPM, 0) / recentSessions.length;
    const oa = olderSessions.reduce((s, h) => s + h.paceMPM, 0) / olderSessions.length;
    bigShift = Math.abs((ra - oa) * 60) > 5;
  }

  const result = {
    builtAt:        Date.now(),
    thresholdZone:  { low: threshLow, high: threshHigh },
    totalSessions:  history.length,
    currentEstimate,
    estimate30dAgo,
    trendDirection,
    trendSeconds,
    bigShift,
    last5: history.slice(-5).reverse().map(s => ({
      date:            s.date,
      name:            s.name,
      paceMPM:         s.paceMPM,
      avgHR:           s.avgHR,
      durationMin:     s.durationMin,
      efficiencyRatio: s.efficiencyRatio,
    })),
    // Full history for SVG chart (date + pace only to keep payload lean)
    history: history.map(s => ({ date: s.date, paceMPM: s.paceMPM })),
  };

  /* ── Persist and cache ── */
  if (kvUrl && kvToken) {
    await kvPipeline(kvUrl, kvToken, [
      ['SET', histKey,  JSON.stringify(history)],
      ['SET', cacheKey, JSON.stringify(result), 'EX', 300],
    ]);
  }

  return res.status(200).json(result);
};

/* ── KV helpers ── */

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

async function kvPipeline(url, token, commands) {
  try {
    await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(commands),
    });
  } catch (_) {}
}
