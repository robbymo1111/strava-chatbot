'use strict';

/**
 * GET /api/debug-laps?accessToken=xxx
 *
 * Diagnostic: checks the last 90 days of quality runs against the KV lap cache.
 * Returns a summary + per-activity list showing which sessions are cached, stale, or missing.
 * Useful for understanding scope before running /api/rebuild-laps.
 */

const { getAthleteId, kvGet, fmtPace } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const athleteId = await getAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  // Fetch last 90 days
  const since = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  let all = [];
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${since}&per_page=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) return res.status(502).json({ error: `Strava ${r.status}` });
    all = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'Strava unreachable' });
  }

  const quality = all.filter(a => {
    if (!/run/i.test(a.type || '')) return false;
    const mi     = (a.distance || 0) / 1609.34;
    const avgMPM = a.average_speed ? 1609.34 / a.average_speed / 60 : 99;
    return a.workout_type === 1 || a.workout_type === 3 ||
           avgMPM < 8.0 || (a.max_heartrate || 0) > 155 || (a.suffer_score || 0) > 40 || mi > 10;
  });

  const cached = (kvUrl && kvToken)
    ? await Promise.all(quality.map(a => kvGet(kvUrl, kvToken, `laps:${athleteId}:${a.id}`)))
    : quality.map(() => null);

  const activities = quality.map((a, i) => {
    const c      = cached[i];
    const date   = (a.start_date_local || a.start_date || '').slice(0, 10);
    const mi     = ((a.distance || 0) / 1609.34).toFixed(2);
    const avgMPM = a.average_speed ? 1609.34 / a.average_speed / 60 : null;
    const ver    = !c ? 'missing' : c.v === 2 ? 'v2' : 'stale';
    return {
      date,
      name:         a.name || a.type,
      distance:     mi + 'mi',
      avgPace:      avgMPM ? fmtPace(avgMPM) + '/mi' : null,
      workoutType:  a.workout_type || 0,
      maxHR:        a.max_heartrate || null,
      sufferScore:  a.suffer_score  || null,
      lapsCached:   ver === 'v2',
      lapCount:     c?.laps?.length ?? null,
      cacheVersion: ver,
    };
  });

  return res.status(200).json({
    summary: {
      totalQualityRuns: activities.length,
      cached:           activities.filter(a => a.lapsCached).length,
      missing:          activities.filter(a => a.cacheVersion === 'missing').length,
      stale:            activities.filter(a => a.cacheVersion === 'stale').length,
    },
    activities,
  });
};
