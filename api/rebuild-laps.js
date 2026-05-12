'use strict';

/**
 * Unified lap + stream cache builder.
 *
 * GET  /api/rebuild-laps?accessToken=xxx[&action=debug|history-laps|streams]
 *
 * POST /api/rebuild-laps
 *   Body: { accessToken, batchSize?: 5, reset?: false, action?: 'history-laps'|'streams' }
 *
 * action omitted  → 90-day emergency rebuild (no history sync required)
 * action='history-laps' → full history lap fetch (requires history sync)
 * action='streams'      → per-mile split / stream fetch (requires history sync)
 * action='debug'  (GET) → lap cache diagnostic
 */

const {
  getAthleteId, kvGet, kvSet,
  classifyLaps, detectPattern, fmtPace,
  computeMileSplits, computeVelocityBlocks,
} = require('./_lib');

const REBUILD_KEY = (id) => `rebuild-laps:${id}:progress`;
const HISTORY_KEY = (id) => `history:${id}:lap-fetch-progress`;
const STREAMS_KEY = (id) => `history:${id}:stream-fetch-progress`;

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

  /* ── GET ── */
  if (req.method === 'GET') {
    const action = req.query.action;
    if (action === 'debug') return debugLaps(req, res, athleteId, accessToken, kvUrl, kvToken);
    if (action === 'history-laps') {
      const prog = await kvGet(kvUrl, kvToken, HISTORY_KEY(athleteId));
      if (!prog) return res.status(200).json({ started: false, totalQuality: 0 });
      return res.status(200).json({ started: true, ...prog });
    }
    if (action === 'streams') {
      const prog = await kvGet(kvUrl, kvToken, STREAMS_KEY(athleteId));
      if (!prog) return res.status(200).json({ started: false, totalQuality: 0 });
      return res.status(200).json({ started: true, ...prog });
    }
    // Default: 90-day rebuild progress
    const prog = await kvGet(kvUrl, kvToken, REBUILD_KEY(athleteId));
    return res.status(200).json(prog || { started: false, totalQuality: 0 });
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { batchSize = 5, reset = false, action } = req.body || {};

  if (action === 'history-laps') return runHistoryLapsBatch(res, athleteId, accessToken, kvUrl, kvToken, batchSize, reset);
  if (action === 'streams')      return runStreamsBatch(res, athleteId, accessToken, kvUrl, kvToken, batchSize, reset);

  /* ── 90-day rebuild ─────────────────────────────────────────────────────── */

  let prog = reset ? null : await kvGet(kvUrl, kvToken, REBUILD_KEY(athleteId));

  /* First call: build queue from live Strava */
  if (!prog || !prog.ids || !prog.ids.length || reset) {
    const since = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
    let all = [];
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${since}&per_page=200`,
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
      .sort((a, b) => (b.start_date_local || '').localeCompare(a.start_date_local || ''));

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
    await kvSet(kvUrl, kvToken, REBUILD_KEY(athleteId), prog);
    return res.status(200).json({
      initialized:  true,
      totalQuality: prog.totalQuality,
      nextIndex:    0,
      processed:    0,
      remaining:    prog.totalQuality,
    });
  }

  /* Already complete */
  if (prog.completedAt && prog.nextIndex >= prog.totalQuality) {
    return res.status(200).json({
      alreadyDone:  true,
      processed:    prog.processed,
      totalQuality: prog.totalQuality,
      remaining:    0,
      completedAt:  prog.completedAt,
    });
  }

  /* Process next batch */
  const batchIds = prog.ids.slice(prog.nextIndex, prog.nextIndex + batchSize);
  if (!batchIds.length) {
    prog.completedAt = Date.now();
    await kvSet(kvUrl, kvToken, REBUILD_KEY(athleteId), prog);
    return res.status(200).json({ processed: prog.processed, remaining: 0, completedAt: prog.completedAt });
  }

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
    const summary    = buildHardEffortSummary(classified, pattern);

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
  await kvSet(kvUrl, kvToken, REBUILD_KEY(athleteId), prog);

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

/* ── Full history lap fetch ───────────────────────────────────────────────── */

async function runHistoryLapsBatch(res, athleteId, accessToken, kvUrl, kvToken, batchSize, reset) {
  const progressKey = HISTORY_KEY(athleteId);

  const meta = await kvGet(kvUrl, kvToken, `history:${athleteId}:meta`);
  if (!meta || !meta.complete) {
    return res.status(200).json({
      error:    'History sync not complete — open the Insights tab first to start the full history sync',
      notReady: true,
    });
  }

  let prog = reset ? null : await kvGet(kvUrl, kvToken, progressKey);

  // v:1 used oldest→newest order; v:2 flipped to newest→oldest for recency priority
  if (prog && prog.v < 2) prog = null;

  if (!prog || !prog.ids || prog.ids.length === 0 || reset) {
    const pageKeys = [];
    for (let i = 0; i < meta.pages; i++) pageKeys.push(`history:${athleteId}:page:${i}`);
    const pageResults    = await Promise.all(pageKeys.map(k => kvGet(kvUrl, kvToken, k)));
    const allActivities  = pageResults.filter(Boolean).flat().filter(a => a && a.d && a.id);

    const qualitySessions = allActivities
      .filter(a => {
        if (!/run/i.test(a.ty || '')) return false;
        const labeled  = a.wt === 1 || a.wt === 3;
        const fastPace = a.pa && a.pa < 8.0 && (a.mi || 0) >= 3;
        const longRun  = (a.mi || 0) >= 12;
        const effort   = (a.mhr && a.mhr > 155) || (a.ss && a.ss > 40);
        return labeled || fastPace || longRun || effort;
      })
      .sort((a, b) => b.d.localeCompare(a.d));

    prog = {
      v:            2,
      ids:          qualitySessions.map(s => s.id),
      totalQuality: qualitySessions.length,
      nextIndex:    0,
      processed:    0,
      failed:       0,
      builtAt:      Date.now(),
      completedAt:  null,
    };
    await kvSet(kvUrl, kvToken, progressKey, prog);
    return res.status(200).json({
      initialized:  true,
      totalQuality: prog.totalQuality,
      nextIndex:    0,
      processed:    0,
      remaining:    prog.totalQuality,
      completedAt:  null,
    });
  }

  if (prog.completedAt && prog.nextIndex >= prog.totalQuality) {
    return res.status(200).json({
      alreadyDone:  true,
      processed:    prog.processed,
      totalQuality: prog.totalQuality,
      remaining:    0,
      completedAt:  prog.completedAt,
    });
  }

  const batchIds = prog.ids.slice(prog.nextIndex, prog.nextIndex + batchSize);
  if (!batchIds.length) {
    prog.completedAt = Date.now();
    await kvSet(kvUrl, kvToken, progressKey, prog);
    return res.status(200).json({ processed: prog.processed, totalQuality: prog.totalQuality, remaining: 0, completedAt: prog.completedAt });
  }

  const existingEntries = await Promise.all(
    batchIds.map(id => kvGet(kvUrl, kvToken, `laps:${athleteId}:${id}`))
  );

  let thisFetched = 0, thisSkipped = 0, rateLimited = false;

  for (let i = 0; i < batchIds.length; i++) {
    const activityId = batchIds[i];

    if (existingEntries[i] && existingEntries[i].v === 2) {
      thisSkipped++;
      prog.nextIndex++;
      prog.processed++;
      continue;
    }

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

    let result;
    if (!Array.isArray(rawLaps) || rawLaps.length < 2) {
      result = { v: 2, activityId, laps: [], pattern: null, hardEffortSummary: null, source: 'history-lap-fetch', analyzedAt: Date.now() };
    } else {
      const classified = classifyLaps(rawLaps, 7.5);
      const pattern    = detectPattern(classified);
      result = {
        v: 2, activityId, laps: classified, pattern,
        hardEffortSummary: buildHardEffortSummary(classified, pattern),
        source: 'history-lap-fetch', analyzedAt: Date.now(),
      };
    }

    await kvSet(kvUrl, kvToken, `laps:${athleteId}:${activityId}`, result);
    thisFetched++;
    prog.nextIndex++;
    prog.processed++;
  }

  const remaining = Math.max(0, prog.totalQuality - prog.nextIndex);
  if (remaining === 0 && !rateLimited) prog.completedAt = Date.now();
  prog.updatedAt = Date.now();
  await kvSet(kvUrl, kvToken, progressKey, prog);

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
}

/* ── Streams / per-mile splits fetch ─────────────────────────────────────── */

async function runStreamsBatch(res, athleteId, accessToken, kvUrl, kvToken, batchSize, reset) {
  const progressKey = STREAMS_KEY(athleteId);

  const meta = await kvGet(kvUrl, kvToken, `history:${athleteId}:meta`);
  if (!meta || !meta.complete) {
    return res.status(200).json({ error: 'History sync not complete — open the Insights tab first', notReady: true });
  }

  let prog = reset ? null : await kvGet(kvUrl, kvToken, progressKey);

  if (!prog || !prog.ids || !prog.ids.length || reset) {
    const pageKeys = [];
    for (let i = 0; i < meta.pages; i++) pageKeys.push(`history:${athleteId}:page:${i}`);
    const pageResults   = await Promise.all(pageKeys.map(k => kvGet(kvUrl, kvToken, k)));
    const allActivities = pageResults.filter(Boolean).flat().filter(a => a && a.d && a.id);

    const qualitySessions = allActivities
      .filter(a => isQualityForStreams(a))
      .sort((a, b) => b.d.localeCompare(a.d));

    prog = {
      ids:          qualitySessions.map(s => s.id),
      totalQuality: qualitySessions.length,
      nextIndex:    0,
      processed:    0,
      failed:       0,
      builtAt:      Date.now(),
      completedAt:  null,
    };
    await kvSet(kvUrl, kvToken, progressKey, prog);
    return res.status(200).json({ initialized: true, totalQuality: prog.totalQuality, nextIndex: 0, processed: 0, remaining: prog.totalQuality });
  }

  if (prog.completedAt && prog.nextIndex >= prog.totalQuality) {
    return res.status(200).json({ alreadyDone: true, processed: prog.processed, totalQuality: prog.totalQuality, remaining: 0, completedAt: prog.completedAt });
  }

  const batchIds = prog.ids.slice(prog.nextIndex, prog.nextIndex + batchSize);
  if (!batchIds.length) {
    prog.completedAt = Date.now();
    await kvSet(kvUrl, kvToken, progressKey, prog);
    return res.status(200).json({ processed: prog.processed, remaining: 0, completedAt: prog.completedAt });
  }

  const existing = await Promise.all(
    batchIds.map(id => kvGet(kvUrl, kvToken, `mile-splits:${athleteId}:${id}`))
  );

  let thisFetched = 0, thisSkipped = 0, rateLimited = false;

  for (let i = 0; i < batchIds.length; i++) {
    const activityId = batchIds[i];

    if (existing[i]?.splits?.length > 0) {
      thisSkipped++;
      prog.nextIndex++;
      prog.processed++;
      continue;
    }

    let streams;
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=heartrate,time,velocity_smooth,distance,altitude`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (r.status === 429) { rateLimited = true; break; }
      if (!r.ok) { prog.failed++; prog.nextIndex++; continue; }
      streams = await r.json();
    } catch (_) {
      prog.failed++;
      prog.nextIndex++;
      continue;
    }

    const splits    = computeMileSplits(streams);
    const velBlocks = computeVelocityBlocks(streams);
    if (splits?.length > 0) {
      await kvSet(kvUrl, kvToken, `mile-splits:${athleteId}:${activityId}`, {
        activityId, splits, velocityBlocks: velBlocks || null, computedAt: Date.now(),
      });
    }

    thisFetched++;
    prog.nextIndex++;
    prog.processed++;
  }

  const remaining = Math.max(0, prog.totalQuality - prog.nextIndex);
  if (remaining === 0 && !rateLimited) prog.completedAt = Date.now();
  prog.updatedAt = Date.now();
  await kvSet(kvUrl, kvToken, progressKey, prog);

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
}

/* ── GET ?action=debug — lap cache diagnostic ─────────────────────────────── */

async function debugLaps(req, res, athleteId, accessToken, kvUrl, kvToken) {
  const since = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  let all = [];
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${since}&per_page=200`,
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

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function buildHardEffortSummary(classified, pattern) {
  if (!pattern || !pattern.description || pattern.description === 'Insufficient lap data') return null;
  const hardLaps = classified.filter(l => l.classification === 'Interval' || l.classification === 'Hard');
  const hrVals   = hardLaps.map(l => l.hr).filter(Boolean);
  const hrSuffix = hrVals.length
    ? ' · HR ' + Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length) : '';
  return pattern.description + hrSuffix;
}

function isQualityForStreams(a) {
  if (!/run/i.test(a.ty || '')) return false;
  const mi      = a.mi || 0;
  const nm      = (a.nm || '').toLowerCase();
  const namedRace = /marathon|half[\s-]?marathon|\b(race|5k|10k|15k|20k|25k|30k|\d+k)\b/.test(nm);
  return (
    a.wt === 1 || a.wt === 3 ||
    namedRace ||
    (a.pa && a.pa < 8.0) ||
    (a.mhr && a.mhr > 155) ||
    (a.ss && a.ss > 40) ||
    mi >= 10
  ) && mi >= 2;
}
