/**
 * GET  /api/history-lap-fetch?accessToken=xxx
 *   Returns current lap-fetch progress for the athlete.
 *
 * POST /api/history-lap-fetch
 *   Body: { accessToken, batchSize?: number (default 5), reset?: boolean }
 *
 *   One-time background job: fetches lap data for every historical quality
 *   session (avg pace < 8:00/mi, ≥ 3mi) going back to the athlete's earliest
 *   recorded activity.
 *
 *   Progress is tracked at  history:{athleteId}:lap-fetch-progress
 *   Laps are stored at      laps:{athleteId}:{activityId}   (v:2 format,
 *   same schema as api/laps.js so chat.js can read them without changes).
 *
 *   Design:
 *   - First call builds the quality-session ID list from KV history pages and
 *     returns immediately (no Strava calls). Subsequent calls fetch batchSize
 *     sessions, skip ones already in KV, and update progress.
 *   - Safe to call repeatedly from the frontend — idempotent and resumable.
 *   - Never re-fetches a session that already has a v:2 cache entry.
 */
const { getAthleteId, kvGet, kvSet, classifyLaps, detectPattern, computeMileSplits, computeVelocityBlocks } = require('./_lib');

module.exports = async (req, res) => {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ error: 'KV not configured' });

  const accessToken = req.method === 'GET'
    ? req.query.accessToken
    : (req.body || {}).accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const athleteId = await getAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  const progressKey = `history:${athleteId}:lap-fetch-progress`;

  /* ── GET: return current progress only ── */
  if (req.method === 'GET') {
    if (req.query.action === 'streams') {
      const prog = await kvGet(kvUrl, kvToken, `history:${athleteId}:stream-fetch-progress`);
      if (!prog) return res.status(200).json({ started: false, totalQuality: 0 });
      return res.status(200).json({ started: true, ...prog });
    }
    const prog = await kvGet(kvUrl, kvToken, progressKey);
    if (!prog) return res.status(200).json({ started: false, totalQuality: 0 });
    return res.status(200).json({ started: true, ...prog });
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { batchSize = 5, reset = false, action = 'laps' } = req.body || {};

  if (action === 'streams') {
    return await runStreamsBatch(req, res, athleteId, accessToken, kvUrl, kvToken, batchSize, reset);
  }

  /* ── Read history meta — must be a completed sync ── */
  const meta = await kvGet(kvUrl, kvToken, `history:${athleteId}:meta`);
  if (!meta || !meta.complete) {
    return res.status(200).json({
      error:    'History sync not complete — open the Insights tab first to start the full history sync',
      notReady: true,
    });
  }

  /* ── Read or build progress object ── */
  let prog = reset ? null : await kvGet(kvUrl, kvToken, progressKey);

  // v:1 used oldest→newest order; v:2 flipped to newest→oldest so recent race
  // blocks get lap data first. Force rebuild when old version is detected.
  if (prog && prog.v < 2) prog = null;

  if (!prog || !prog.ids || prog.ids.length === 0 || reset) {
    /* First call (or reset): read all history pages and build the quality-session list */
    const pageKeys = [];
    for (let i = 0; i < meta.pages; i++) pageKeys.push(`history:${athleteId}:page:${i}`);

    const pageResults = await Promise.all(pageKeys.map(k => kvGet(kvUrl, kvToken, k)));
    const allActivities = pageResults.filter(Boolean).flat().filter(a => a && a.d && a.id);

    /* Quality session definition: run that is a labeled workout/race, faster than
       8:00/mi, a long run ≥12mi (may have integrated quality), or elevated effort */
    const qualitySessions = allActivities
      .filter(a => {
        if (!/run/i.test(a.ty || '')) return false;
        const labeled  = a.wt === 1 || a.wt === 3;          // Strava workout or race
        const fastPace = a.pa && a.pa < 8.0 && (a.mi || 0) >= 3;
        const longRun  = (a.mi || 0) >= 12;                 // check for integrated quality
        const effort   = (a.mhr && a.mhr > 155) || (a.ss && a.ss > 40);
        return labeled || fastPace || longRun || effort;
      })
      .sort((a, b) => b.d.localeCompare(a.d)); // newest → oldest: recent race blocks get data first

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

    /* Store immediately — caller gets this back on next call */
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

  /* ── Process next batch ── */
  const batchIds = prog.ids.slice(prog.nextIndex, prog.nextIndex + batchSize);
  if (!batchIds.length) {
    prog.completedAt = Date.now();
    await kvSet(kvUrl, kvToken, progressKey, prog);
    return res.status(200).json({
      processed:    prog.processed,
      totalQuality: prog.totalQuality,
      remaining:    0,
      completedAt:  prog.completedAt,
    });
  }

  /* Check KV in parallel to skip already-cached sessions */
  const existingEntries = await Promise.all(
    batchIds.map(id => kvGet(kvUrl, kvToken, `laps:${athleteId}:${id}`))
  );

  let thisFetched = 0;
  let thisSkipped = 0;
  let rateLimited = false;

  for (let i = 0; i < batchIds.length; i++) {
    const activityId = batchIds[i];

    /* Already have a v:2 cache entry — count it and move on */
    if (existingEntries[i] && existingEntries[i].v === 2) {
      thisSkipped++;
      prog.nextIndex++;
      prog.processed++;
      continue;
    }

    /* Fetch raw laps from Strava */
    let rawLaps;
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/laps`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );

      if (r.status === 429) {
        rateLimited = true;
        break; // stop the batch — save progress as-is
      }

      if (!r.ok) {
        prog.failed++;
        prog.nextIndex++;
        continue;
      }

      rawLaps = await r.json();
    } catch (_) {
      prog.failed++;
      prog.nextIndex++;
      continue;
    }

    /* Classify and detect workout pattern */
    let result;
    if (!Array.isArray(rawLaps) || rawLaps.length < 2) {
      result = {
        v:                2,
        activityId,
        laps:             [],
        pattern:          null,
        hardEffortSummary: null,
        source:           'history-lap-fetch',
        analyzedAt:       Date.now(),
      };
    } else {
      const classified = classifyLaps(rawLaps, 7.5);
      const pattern    = detectPattern(classified);
      result = {
        v:                2,
        activityId,
        laps:             classified,
        pattern,
        hardEffortSummary: buildHardEffortSummary(classified, pattern),
        source:           'history-lap-fetch',
        analyzedAt:       Date.now(),
      };
    }

    await kvSet(kvUrl, kvToken, `laps:${athleteId}:${activityId}`, result);
    thisFetched++;
    prog.nextIndex++;
    prog.processed++;
  }

  const remaining = Math.max(0, prog.totalQuality - prog.nextIndex);
  if (remaining === 0 && !rateLimited) {
    prog.completedAt = Date.now();
  }
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
};

/* ── Streams batch handler ────────────────────────────────────────────────── */

/**
 * POST {action:'streams'}: fetch Strava streams for quality activities,
 * compute per-mile splits, and cache at mile-splits:{athleteId}:{activityId}.
 *
 * Quality: any run that is a race (wt=1), workout (wt=3), faster than 8:00/mi,
 * max HR > 160, suffer score > 50, or >= 10mi (long runs benefit from splits too).
 */
async function runStreamsBatch(req, res, athleteId, accessToken, kvUrl, kvToken, batchSize, reset) {
  const progressKey = `history:${athleteId}:stream-fetch-progress`;

  const meta = await kvGet(kvUrl, kvToken, `history:${athleteId}:meta`);
  if (!meta || !meta.complete) {
    return res.status(200).json({
      error: 'History sync not complete — open the Insights tab first',
      notReady: true,
    });
  }

  let prog = reset ? null : await kvGet(kvUrl, kvToken, progressKey);

  if (!prog || !prog.ids || !prog.ids.length || reset) {
    const pageKeys = [];
    for (let i = 0; i < meta.pages; i++) pageKeys.push(`history:${athleteId}:page:${i}`);
    const pageResults = await Promise.all(pageKeys.map(k => kvGet(kvUrl, kvToken, k)));
    const allActivities = pageResults.filter(Boolean).flat().filter(a => a && a.d && a.id);

    const qualitySessions = allActivities
      .filter(a => isQualityForStreams(a))
      .sort((a, b) => b.d.localeCompare(a.d)); // newest first

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
    return res.status(200).json({
      initialized:  true,
      totalQuality: prog.totalQuality,
      nextIndex:    0,
      processed:    0,
      remaining:    prog.totalQuality,
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
    return res.status(200).json({ processed: prog.processed, remaining: 0, completedAt: prog.completedAt });
  }

  // Skip activities that already have mile splits cached
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

    const splits       = computeMileSplits(streams);
    const velBlocks    = computeVelocityBlocks(streams);
    if (splits?.length > 0) {
      await kvSet(kvUrl, kvToken, `mile-splits:${athleteId}:${activityId}`, {
        activityId,
        splits,
        velocityBlocks: velBlocks || null,
        computedAt:     Date.now(),
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

function isQualityForStreams(a) {
  if (!/run/i.test(a.ty || '')) return false;
  const mi        = a.mi || 0;
  const nm        = (a.nm || '').toLowerCase();
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

/* ── Helpers ──────────────────────────────────────────────────────────────── */

/**
 * Build a human-readable workout summary for the coach's context.
 * Combines the pattern description with avg HR from hard laps.
 */
function buildHardEffortSummary(classified, pattern) {
  if (!pattern || !pattern.description || pattern.description === 'Insufficient lap data') return null;

  const hardLaps = classified.filter(
    l => l.classification === 'Interval' || l.classification === 'Hard'
  );
  const hrVals  = hardLaps.map(l => l.hr).filter(Boolean);
  const hrSuffix = hrVals.length
    ? ' · HR ' + Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length)
    : '';

  return pattern.description + hrSuffix;
}
