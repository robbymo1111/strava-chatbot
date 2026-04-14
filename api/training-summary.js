/**
 * Training History — batch lap sync + aggregate summary
 *
 * POST /api/training-summary
 * Body: {
 *   accessToken:   string,
 *   activities:    [{ id, date, name, type, movingTime, distance }],
 *   threshPaceMin: number | null,   // from memory.paces.threshold midpoint
 * }
 * Fetches laps for up to 25 activities per call (Vercel 10s limit), caches in KV,
 * builds a plain-text training profile for Claude, stores it in KV.
 * Returns: { processed, cached, total, summary, done }
 *
 * GET /api/training-summary?accessToken=xxx
 * Returns: { summary: string | null, lastSyncAt: number | null }
 * Fast path used by api/chat.js on every request.
 *
 * Rate limiting: Strava allows 200 req / 15 min. We fetch 5 in parallel per
 * micro-batch with a 200 ms pause between micro-batches — safe for any athlete.
 */
module.exports = async (req, res) => {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  /* ── GET: return cached summary ── */
  if (req.method === 'GET') {
    const accessToken = req.query.accessToken;
    if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

    if (!kvUrl || !kvToken) return res.status(200).json({ summary: null, lastSyncAt: null });

    const athleteId = await getAthleteId(accessToken);
    if (!athleteId)  return res.status(200).json({ summary: null, lastSyncAt: null });

    try {
      const stored = await kvGet(kvUrl, kvToken, `training_summary:${athleteId}`);
      return res.status(200).json({
        summary:    stored?.text      || null,
        lastSyncAt: stored?.updatedAt || null,
      });
    } catch (_) {
      return res.status(200).json({ summary: null, lastSyncAt: null });
    }
  }

  /* ── POST: batch sync ── */
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken, activities = [], threshPaceMin } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const thresh = parseFloat(threshPaceMin) || null;

  if (!kvUrl || !kvToken) {
    return res.status(200).json({ processed: 0, cached: 0, total: activities.length, done: true, summary: null });
  }

  const athleteId = await getAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  // Process up to 25 activities per call
  const batch   = activities.slice(0, 25);
  let processed = 0;
  let cached    = 0;
  let rateLimited = false;

  // ── Process in micro-batches of 5 (parallel within batch, sequential across) ──
  for (let bStart = 0; bStart < batch.length; bStart += 5) {
    const micro = batch.slice(bStart, bStart + 5);

    const results = await Promise.all(micro.map(async (act) => {
      if (!act.id || !act.movingTime || act.movingTime < 300) return { type: 'skip' };

      const cacheKey = `laps:${athleteId}:${act.id}`;

      // Check KV cache first
      try {
        const hit = await kvGet(kvUrl, kvToken, cacheKey);
        if (hit) return { type: 'cached', data: hit };
      } catch (_) {}

      // Fetch from Strava
      try {
        const r = await fetch(
          `https://www.strava.com/api/v3/activities/${act.id}/laps`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (r.status === 429) return { type: 'rate_limited' };
        if (!r.ok) return { type: 'error' };
        const laps = await r.json();
        if (!Array.isArray(laps) || laps.length < 2) return { type: 'skip' };

        const classifiedLaps = classifyLaps(laps, thresh);
        const pattern        = detectPattern(classifiedLaps);
        const lapData = {
          activityId: act.id,
          date:       act.date,
          name:       act.name || act.type || 'Run',
          type:       act.type,
          distMi:     act.distance ? Math.round(act.distance / 1609.34 * 10) / 10 : null,
          laps:       classifiedLaps,
          pattern,
          analyzedAt: Date.now(),
        };

        await kvSet(kvUrl, kvToken, cacheKey, lapData);
        return { type: 'fetched', data: lapData };
      } catch (_) {
        return { type: 'error' };
      }
    }));

    for (const r of results) {
      if (r.type === 'fetched')      processed++;
      else if (r.type === 'cached')  cached++;
      else if (r.type === 'rate_limited') { rateLimited = true; break; }
    }
    if (rateLimited) break;

    // Polite 200 ms pause between micro-batches
    if (bStart + 5 < batch.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  // ── Build aggregate summary from ALL cached analyses ──
  // Scan the most recent 90 days of cached activity analyses
  const allAnalyses = (await Promise.all(
    activities.map(act => act.id
      ? kvGet(kvUrl, kvToken, `laps:${athleteId}:${act.id}`).catch(() => null)
      : Promise.resolve(null)
    )
  )).filter(Boolean);

  const summaryText = buildSummaryText(allAnalyses);
  const done = activities.length <= 25 && !rateLimited;

  if (summaryText) {
    try {
      await kvSet(kvUrl, kvToken, `training_summary:${athleteId}`, {
        text:      summaryText,
        updatedAt: Date.now(),
      });
    } catch (_) {}
  }

  return res.status(200).json({
    processed,
    cached,
    total:       activities.length,
    done,
    rateLimited,
    summary:     summaryText,
  });
};

/* ── Training summary text builder ──────────────────────────────────────── */

/**
 * Produces a plain-text summary of the last 90 days of training patterns.
 * This is injected verbatim into Claude's system prompt.
 */
function buildSummaryText(analyses) {
  if (!analyses || !analyses.length) return null;

  // Only include activities that have a meaningful pattern
  const valid = analyses.filter(a => a.pattern && a.pattern.type !== 'Unknown');
  if (!valid.length) return null;

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const typeCounts   = {};
  const intervalRecs = []; // { date, pace }
  const tempoRecs    = []; // { date, pace }
  const easyByMonth  = {}; // month → [paceMPM]
  const hardByDow    = {}; // dayOfWeek → count

  valid.forEach(a => {
    const type = a.pattern.type;
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    if (a.date) {
      const dow   = new Date(a.date + 'T12:00:00').getDay();
      const month = a.date.slice(0, 7);

      // Track which weekdays quality sessions fall on
      if (type !== 'Easy Steady') {
        hardByDow[dow] = (hardByDow[dow] || 0) + 1;
      }

      // Easy pace trend (aerobic efficiency signal)
      if (type === 'Easy Steady' && a.pattern.stats?.avgPaceMPM) {
        if (!easyByMonth[month]) easyByMonth[month] = [];
        easyByMonth[month].push(a.pattern.stats.avgPaceMPM);
      }
    }

    if (type === 'Intervals' && a.pattern.stats?.avgHardPaceMPM) {
      intervalRecs.push({ date: a.date || '', pace: a.pattern.stats.avgHardPaceMPM });
    }
    if (type === 'Tempo' && a.pattern.stats?.avgPaceMPM) {
      tempoRecs.push({ date: a.date || '', pace: a.pattern.stats.avgPaceMPM });
    }
  });

  const lines = [];

  // Workout type breakdown
  const typeList = Object.entries(typeCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
  lines.push(`Workout breakdown (90 days): ${typeList}`);

  // Interval pace trend
  if (intervalRecs.length >= 2) {
    const sorted = [...intervalRecs].sort((a, b) => a.date.localeCompare(b.date));
    const oldest = sorted[0];
    const newest = sorted[sorted.length - 1];
    const diffSec = Math.round((oldest.pace - newest.pace) * 60);
    const trend   = diffSec > 5 ? `improving ${diffSec}s/mi` : diffSec < -5 ? `slowing ${Math.abs(diffSec)}s/mi` : 'stable';
    lines.push(`Interval pace: ${fmtPace(oldest.pace)} → ${fmtPace(newest.pace)}/mi (${trend})`);
  }

  // Easy run pace trend (aerobic development indicator)
  const easyMonths = Object.entries(easyByMonth).sort(([a], [b]) => a.localeCompare(b));
  if (easyMonths.length >= 2) {
    const avgFirst = avg(easyMonths[0][1]);
    const avgLast  = avg(easyMonths[easyMonths.length - 1][1]);
    const diffSec  = Math.round((avgFirst - avgLast) * 60);
    const trend    = diffSec > 5 ? `${diffSec}s/mi faster (aerobic improvement)` :
                     diffSec < -5 ? `${Math.abs(diffSec)}s/mi slower (possible fatigue)` : 'stable';
    lines.push(`Easy run pace: ${fmtPace(avgFirst)} → ${fmtPace(avgLast)}/mi (${trend})`);
  }

  // Typical quality days
  const sortedDays = Object.entries(hardByDow)
    .filter(([, n]) => n >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([d]) => DAY_NAMES[parseInt(d)]);
  if (sortedDays.length) lines.push(`Typical quality days: ${sortedDays.join(', ')}`);

  // Most recent sessions of key types
  const byDate = [...valid].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const lastInterval = byDate.find(a => a.pattern.type === 'Intervals');
  const lastTempo    = byDate.find(a => a.pattern.type === 'Tempo');

  if (lastInterval) {
    lines.push(`Last interval session: ${lastInterval.date} · ${lastInterval.name} · ${lastInterval.pattern.description}`);
  }
  if (lastTempo) {
    lines.push(`Last tempo run: ${lastTempo.date} · ${lastTempo.name} · ${lastTempo.pattern.description}`);
  }

  return lines.join('\n');
}

/* ── Shared lap analysis ─────────────────────────────────────────────────── */
/* (duplicated from api/laps.js — can't share modules without npm) */

function classifyLaps(laps, threshPaceMin) {
  const thresh     = threshPaceMin || 7.5;
  const classified = [];

  laps.forEach((lap, i) => {
    const distMi  = (lap.distance || 0) / 1609.34;
    const durMin  = ((lap.elapsed_time || lap.moving_time || 0)) / 60;
    const speed   = lap.average_speed;
    const paceMPM = (speed && lap.distance > 50) ? 1609.34 / speed / 60 : null;
    const hr      = lap.average_heartrate ? Math.round(lap.average_heartrate) : null;

    let paceStr = null;
    if (paceMPM) {
      const m = Math.floor(paceMPM);
      const s = Math.round((paceMPM - m) * 60);
      paceStr = `${m}:${String(s).padStart(2, '0')}`;
    }

    let classification = 'Easy';
    if (paceMPM) {
      const pctAbove = (paceMPM - thresh) / thresh;
      const prevCls  = classified.map(c => c.classification);
      const hadHard  = prevCls.some(c => c === 'Interval' || c === 'Hard');

      if      (i === 0 && pctAbove > 0.05)                           classification = 'Warm-up';
      else if (i === laps.length - 1 && pctAbove > 0.05 && hadHard) classification = 'Cool-down';
      else if (pctAbove > 0.15)                                      classification = 'Easy';
      else if (pctAbove > 0.05)                                      classification = 'Moderate';
      else if (pctAbove > -0.05)                                     classification = 'Hard';
      else                                                            classification = 'Interval';
    }

    classified.push({
      lapNum:      i + 1,
      distMi:      Math.round(distMi * 100) / 100,
      durationMin: Math.round(durMin * 10) / 10,
      pace:        paceStr,
      paceMPM:     paceMPM ? Math.round(paceMPM * 1000) / 1000 : null,
      hr,
      classification,
    });
  });

  return classified;
}

function detectPattern(classifiedLaps) {
  const core = classifiedLaps.filter(
    l => l.classification !== 'Warm-up' && l.classification !== 'Cool-down'
  );
  if (core.length < 2) return { type: 'Unknown', description: 'Insufficient lap data', stats: {} };

  const classes   = core.map(l => l.classification);
  const hardCount = classes.filter(c => c === 'Interval' || c === 'Hard').length;
  const easyCount = classes.filter(c => c === 'Easy' || c === 'Moderate').length;
  const paces     = core.map(l => l.paceMPM).filter(Boolean);

  // Intervals
  if (hardCount >= 3 && easyCount >= 2) {
    const isAlt = classes.some((c, i) =>
      i > 0 && (c === 'Interval' || c === 'Hard') &&
      (classes[i - 1] === 'Easy' || classes[i - 1] === 'Moderate')
    );
    if (isAlt) {
      const hl      = core.filter(l => l.classification === 'Interval' || l.classification === 'Hard');
      const avgPace = avg(hl.map(l => l.paceMPM).filter(Boolean));
      const avgDist = avg(hl.map(l => l.distMi));
      const repFt   = Math.round(avgDist * 5280 / 100) * 100;
      return {
        type:        'Intervals',
        description: `${hardCount}×${repFt < 600 ? repFt + 'ft' : Math.round(avgDist * 5280) + 'm'} intervals · avg ${fmtPace(avgPace)}/mi`,
        stats:       { repCount: hardCount, avgHardPaceMPM: r3(avgPace), avgRepDistMi: r3(avgDist) },
      };
    }
  }

  // Tempo
  let maxConsec = 0, cur = 0;
  classes.forEach(c => {
    if (c === 'Hard' || c === 'Interval') { cur++; maxConsec = Math.max(maxConsec, cur); }
    else cur = 0;
  });
  if (maxConsec >= 3) {
    const hl      = core.filter(l => l.classification === 'Hard' || l.classification === 'Interval');
    const totalMin = hl.reduce((s, l) => s + (l.durationMin || 0), 0);
    const avgPace  = avg(hl.map(l => l.paceMPM).filter(Boolean));
    return {
      type:        'Tempo',
      description: `${Math.round(totalMin)}-min tempo · avg ${fmtPace(avgPace)}/mi`,
      stats:       { durationMin: Math.round(totalMin), avgPaceMPM: r3(avgPace) },
    };
  }

  // Progressive
  if (paces.length >= 3 && paces.every((p, i) => i === 0 || p <= paces[i - 1] * 1.01)) {
    const imp = ((paces[0] - paces[paces.length - 1]) / paces[0] * 100).toFixed(1);
    return {
      type:        'Progressive',
      description: `Progressive · ${fmtPace(paces[0])} → ${fmtPace(paces[paces.length - 1])}/mi (${imp}% faster)`,
      stats:       { startPaceMPM: r3(paces[0]), endPaceMPM: r3(paces[paces.length - 1]) },
    };
  }

  // Negative split
  if (core.length >= 4) {
    const half = Math.floor(core.length / 2);
    const a1   = avg(core.slice(0, half).map(l => l.paceMPM).filter(Boolean));
    const a2   = avg(core.slice(half).map(l => l.paceMPM).filter(Boolean));
    if (a1 && a2 && a2 < a1 * 0.985) {
      return {
        type:        'Negative Split',
        description: `Negative split · ${fmtPace(a1)} → ${fmtPace(a2)}/mi`,
        stats:       { firstHalfPaceMPM: r3(a1), secondHalfPaceMPM: r3(a2) },
      };
    }
  }

  // Long run with pace finish
  if (core.length >= 6) {
    const split  = Math.floor(core.length * 2 / 3);
    const body   = core.slice(0, split);
    const finish = core.slice(split);
    if (body.every(l => l.classification === 'Easy' || l.classification === 'Moderate')) {
      const fh = finish.filter(l => l.classification === 'Hard' || l.classification === 'Interval').length;
      if (fh >= 2) {
        return { type: 'Long Run with Pace Work', description: `Easy base · ${fh} hard finish laps`, stats: { hardFinishLaps: fh } };
      }
    }
  }

  // Easy steady
  if (classes.every(c => c === 'Easy' || c === 'Moderate')) {
    const a = avg(paces);
    return { type: 'Easy Steady', description: `Easy steady · avg ${a ? fmtPace(a) : '?:??'}/mi`, stats: { avgPaceMPM: a ? r3(a) : null } };
  }

  return { type: 'Mixed', description: 'Mixed effort run', stats: {} };
}

function fmtPace(mpm) {
  if (!mpm) return '?:??';
  const m = Math.floor(mpm);
  const s = Math.round((mpm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function r3(v)  { return Math.round((v || 0) * 1000) / 1000; }
function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ── KV helpers ─────────────────────────────────────────────────────────────── */

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
