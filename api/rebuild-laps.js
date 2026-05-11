'use strict';

/**
 * GET  /api/rebuild-laps?accessToken=xxx
 *   Returns current rebuild progress for this athlete.
 *
 * POST /api/rebuild-laps
 *   Body: { accessToken, batchSize?: 5, reset?: false }
 *
 *   Works directly from the last 90 days of Strava activities — does NOT require
 *   the history pages in KV. Designed as a targeted fix for athletes whose
 *   historical lap cache is incomplete.
 *
 *   Call sequence:
 *     1st POST → builds queue from live Strava (returns initialized:true)
 *     Each subsequent POST → processes batchSize activities and returns progress
 *     When remaining === 0 → done (completedAt is set)
 *
 *   Already-cached v:2 entries are skipped without hitting Strava.
 *   Rate-limited responses cause an early stop; caller should back off 60s.
 */

const { getAthleteId, kvGet, kvSet, classifyLaps, detectPattern, fmtPace } = require('./_lib');

const PROG_KEY = (id) => `rebuild-laps:${id}:progress`;

module.exports = async (req, res) => {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(500).json({ error: 'KV not configured' });

  const accessToken = req.method === 'GET'
    ? req.query.accessToken
    : (req.body || {}).accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const athleteId = await getAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  /* ── GET: debug diagnostic or progress ── */
  if (req.method === 'GET') {
    if (req.query.action === 'debug') return debugLaps(req, res, athleteId, accessToken, kvUrl, kvToken);
    const prog = await kvGet(kvUrl, kvToken, PROG_KEY(athleteId));
    return res.status(200).json(prog || { started: false, totalQuality: 0 });
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { batchSize = 5, reset = false } = req.body || {};
  let prog = reset ? null : await kvGet(kvUrl, kvToken, PROG_KEY(athleteId));

  /* ── First call: build queue from live Strava ── */
  if (!prog || !prog.ids || !prog.ids.length || reset) {
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

    const quality = all
      .filter(a => {
        if (!/run/i.test(a.type || '')) return false;
        const mi     = (a.distance || 0) / 1609.34;
        const avgMPM = a.average_speed ? 1609.34 / a.average_speed / 60 : 99;
        return a.workout_type === 1 || a.workout_type === 3 ||
               avgMPM < 8.0 || (a.max_heartrate || 0) > 155 || (a.suffer_score || 0) > 40 || mi > 10;
      })
      .sort((a, b) => (b.start_date_local || '').localeCompare(a.start_date_local || '')); // newest first

    prog = {
      ids:          quality.map(a => a.id),
      totalQuality: quality.length,
      nextIndex:    0,
      processed:    0,
      skipped:      0,
      failed:       0,
      builtAt:      Date.now(),
      completedAt:  null,
    };
    await kvSet(kvUrl, kvToken, PROG_KEY(athleteId), prog);
    return res.status(200).json({
      initialized:  true,
      totalQuality: prog.totalQuality,
      nextIndex:    0,
      processed:    0,
      remaining:    prog.totalQuality,
    });
  }

  /* ── Already complete ── */
  if (prog.completedAt && prog.nextIndex >= prog.totalQuality) {
    return res.status(200).json({
      alreadyDone:  true,
      processed:    prog.processed,
      totalQuality: prog.totalQuality,
      remaining:    0,
      completedAt:  prog.completedAt,
    });
  }

  /* ── Process next batch ── */
  const batchIds = prog.ids.slice(prog.nextIndex, prog.nextIndex + batchSize);
  if (!batchIds.length) {
    prog.completedAt = Date.now();
    await kvSet(kvUrl, kvToken, PROG_KEY(athleteId), prog);
    return res.status(200).json({ processed: prog.processed, remaining: 0, completedAt: prog.completedAt });
  }

  // Check cache — skip v:2 entries without touching Strava
  const existing = await Promise.all(
    batchIds.map(id => kvGet(kvUrl, kvToken, `laps:${athleteId}:${id}`))
  );

  let thisFetched = 0, thisSkipped = 0, rateLimited = false;

  for (let i = 0; i < batchIds.length; i++) {
    const activityId = batchIds[i];

    if (existing[i]?.v === 2) {
      thisSkipped++;
      prog.skipped++;
      prog.nextIndex++;
      prog.processed++;
      continue;
    }

    // 100ms spacing between Strava calls
    if (thisFetched > 0) await new Promise(r => setTimeout(r, 100));

    let rawLaps;
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/laps`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (r.status === 429) { rateLimited = true; break; }
      if (!r.ok) { prog.failed++; prog.nextIndex++; continue; }
      rawLaps = await r.json();
    } catch (_) {
      prog.failed++;
      prog.nextIndex++;
      continue;
    }

    const classified = Array.isArray(rawLaps) && rawLaps.length >= 2
      ? classifyLaps(rawLaps, 7.5) : [];
    const pattern    = classified.length ? detectPattern(classified) : null;
    const hardLaps   = classified.filter(l => l.classification === 'Interval' || l.classification === 'Hard');
    const hrVals     = hardLaps.map(l => l.hr).filter(Boolean);
    const hrSuffix   = hrVals.length
      ? ' · HR ' + Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length) : '';
    const summary    = (pattern?.description && pattern.description !== 'Insufficient lap data')
      ? pattern.description + hrSuffix : null;

    await kvSet(kvUrl, kvToken, `laps:${athleteId}:${activityId}`, {
      v: 2, activityId, laps: classified, pattern,
      hardEffortSummary: summary,
      source:            'rebuild-laps',
      analyzedAt:        Date.now(),
    });

    thisFetched++;
    prog.nextIndex++;
    prog.processed++;
  }

  const remaining = Math.max(0, prog.totalQuality - prog.nextIndex);
  if (remaining === 0 && !rateLimited) prog.completedAt = Date.now();
  prog.updatedAt = Date.now();
  await kvSet(kvUrl, kvToken, PROG_KEY(athleteId), prog);

  return res.status(200).json({
    fetched:      thisFetched,
    skipped:      thisSkipped,
    rateLimited,
    processed:    prog.processed,
    totalQuality: prog.totalQuality,
    nextIndex:    prog.nextIndex,
    remaining,
    completedAt:  prog.completedAt || null,
  });
};

/* ── GET ?action=debug — lap cache diagnostic ──────────────────────────────
 * Merged from the former /api/debug-laps endpoint.
 * Checks last 90 days of quality runs against the KV lap cache.
 */
async function debugLaps(req, res, athleteId, accessToken, kvUrl, kvToken) {
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

  const cached = await Promise.all(
    quality.map(a => kvGet(kvUrl, kvToken, `laps:${athleteId}:${a.id}`))
  );

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
}
