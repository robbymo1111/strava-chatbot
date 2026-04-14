/**
 * Training History — batch lap sync + aggregate summary
 *
 * POST /api/training-summary
 * Body: {
 *   accessToken:   string,
 *   activities:    [{ id, date, name, type, movingTime, distance, workoutType }],
 *   threshPaceMin: number | null,
 * }
 * Fetches laps for quality runs (pace ≤ 8:30/mi or labeled workout/long),
 * prioritised by: workout_type 3 → pace < 8:00 → dist > 10mi → workout_type 2.
 * Extracts hard efforts (laps > 10% faster than activity avg), detects pace
 * variance, and stores an enhanced analysis in KV. Builds a plain-text training
 * profile for Claude and stores it in KV.
 *
 * GET /api/training-summary?accessToken=xxx
 * Returns: { summary: string | null, lastSyncAt: number | null }
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

  // ── Filter to quality runs, then prioritise ──
  const qualified = activities
    .filter(shouldFetchLaps)
    .sort((a, b) => priorityScore(a) - priorityScore(b));

  const batch     = qualified.slice(0, 25);
  let processed   = 0;
  let cached      = 0;
  let rateLimited = false;

  // ── Process in micro-batches of 5 (parallel within batch, sequential across) ──
  for (let bStart = 0; bStart < batch.length; bStart += 5) {
    const micro = batch.slice(bStart, bStart + 5);

    const results = await Promise.all(micro.map(async (act) => {
      const cacheKey = `laps:${athleteId}:${act.id}`;

      // Check KV cache — skip if already has hard effort analysis
      try {
        const hit = await kvGet(kvUrl, kvToken, cacheKey);
        if (hit && hit.hardEffortSummary !== undefined) return { type: 'cached', data: hit };
        // Fall through to re-fetch if cache entry predates hard-effort analysis
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

        const actAvgPaceMPM = actPaceMPM(act);
        const classifiedLaps = classifyLaps(laps, thresh);
        const pattern        = detectPattern(classifiedLaps);
        const paceVariance   = computePaceVariance(classifiedLaps);
        const hardEfforts    = extractHardEfforts(classifiedLaps, actAvgPaceMPM);

        const lapData = {
          activityId:        act.id,
          date:              act.date,
          name:              act.name || act.type || 'Run',
          type:              act.type,
          distMi:            act.distance ? Math.round(act.distance / 1609.34 * 10) / 10 : null,
          laps:              classifiedLaps,
          pattern,
          paceVariance,
          hardEffortSummary: hardEfforts ? hardEfforts.summary : null,
          hardEfforts,
          analyzedAt:        Date.now(),
        };

        await kvSet(kvUrl, kvToken, cacheKey, lapData);
        return { type: 'fetched', data: lapData };
      } catch (_) {
        return { type: 'error' };
      }
    }));

    for (const r of results) {
      if (r.type === 'fetched')           processed++;
      else if (r.type === 'cached')       cached++;
      else if (r.type === 'rate_limited') { rateLimited = true; break; }
    }
    if (rateLimited) break;

    if (bStart + 5 < batch.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  // ── Build aggregate summary from ALL cached analyses ──
  const allAnalyses = (await Promise.all(
    activities.map(act => act.id
      ? kvGet(kvUrl, kvToken, `laps:${athleteId}:${act.id}`).catch(() => null)
      : Promise.resolve(null)
    )
  )).filter(Boolean);

  const summaryText = buildSummaryText(allAnalyses);
  const done = qualified.length <= 25 && !rateLimited;

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

/* ── Activity filtering & prioritisation ─────────────────────────────────── */

/**
 * Only fetch laps for runs that are likely to have meaningful lap structure:
 * labeled workouts/long runs, or any run with avg pace ≤ 8:30/mi.
 */
function shouldFetchLaps(act) {
  if (!act.id || !act.movingTime || act.movingTime < 300) return false;
  const wt = act.workoutType || 0;
  if (wt === 2 || wt === 3) return true; // labeled long run or workout
  if (!act.distance) return false;
  const paceMPM = actPaceMPM(act);
  return paceMPM > 0 && paceMPM <= 8.5; // 8:30/mi cutoff
}

/**
 * Lower score = higher priority.
 * workout_type 3 → pace < 8:00 → dist > 10mi → workout_type 2 → everything else
 */
function priorityScore(act) {
  const wt     = act.workoutType || 0;
  const pace   = actPaceMPM(act);
  const distMi = act.distance ? act.distance / 1609.34 : 0;
  if (wt === 3)        return 0;
  if (pace < 8.0)      return 1;
  if (distMi > 10)     return 2;
  if (wt === 2)        return 3;
  return 4;
}

/** Avg pace in min/mile from the activity payload (movingTime + distance). */
function actPaceMPM(act) {
  if (!act.distance || !act.movingTime) return 0;
  return (act.movingTime / 60) / (act.distance / 1609.34);
}

/* ── Pace variance ───────────────────────────────────────────────────────── */

/**
 * Compute fastest/slowest pace ratio across all non-trivial laps.
 * ratio > 1.15 → workout structure detected.
 */
function computePaceVariance(classifiedLaps) {
  const paces = classifiedLaps.map(l => l.paceMPM).filter(Boolean);
  if (paces.length < 2) return null;
  const fastest = Math.min(...paces);
  const slowest = Math.max(...paces);
  const ratio   = slowest / fastest;
  return {
    fastest:   r3(fastest),
    slowest:   r3(slowest),
    ratio:     r3(ratio),
    isWorkout: ratio > 1.15,
  };
}

/* ── Hard effort extraction ──────────────────────────────────────────────── */

/**
 * Find laps that are >10% faster than activity average pace, group
 * consecutive hard laps as "reps" and interleaved slow laps as "recovery",
 * and build a compact descriptive summary.
 *
 * @param {Array}  classifiedLaps  - output of classifyLaps()
 * @param {number} actAvgPaceMPM   - activity average pace in min/mile
 */
function extractHardEfforts(classifiedLaps, actAvgPaceMPM) {
  if (!actAvgPaceMPM || actAvgPaceMPM <= 0 || !classifiedLaps || classifiedLaps.length < 2) {
    return null;
  }

  const hardThreshold = actAvgPaceMPM * 0.9; // 10% faster than avg

  // Label each lap hard vs recovery
  const labeled = classifiedLaps.map(l => ({
    ...l,
    isHard: l.paceMPM ? l.paceMPM < hardThreshold : false,
  }));

  // Group consecutive same-kind laps
  const groups = [];
  labeled.forEach(l => {
    const kind = l.isHard ? 'hard' : 'easy';
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) {
      last.laps.push(l);
    } else {
      groups.push({ kind, laps: [l] });
    }
  });

  const hardGroups = groups.filter(g => g.kind === 'hard');
  if (!hardGroups.length) return null;

  // Compute per-rep stats
  const reps = hardGroups.map(g => {
    const paces   = g.laps.map(l => l.paceMPM).filter(Boolean);
    const avgPace = paces.length ? paces.reduce((a, b) => a + b, 0) / paces.length : null;
    const distMi  = g.laps.reduce((s, l) => s + (l.distMi || 0), 0);
    return { avgPaceMPM: avgPace, distMi };
  });

  const avgHardPace = (() => {
    const v = reps.map(r => r.avgPaceMPM).filter(Boolean);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  })();

  const avgRepDist = (() => {
    const v = reps.map(r => r.distMi).filter(d => d > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  })();

  // Recovery: interstitial easy groups only (exclude leading/trailing)
  const hasLeadingEasy  = groups[0]?.kind === 'easy';
  const hasTrailingEasy = groups[groups.length - 1]?.kind === 'easy';
  const recovGroups = groups.filter((g, i) => {
    if (g.kind !== 'easy') return false;
    if (hasLeadingEasy  && i === 0)                return false;
    if (hasTrailingEasy && i === groups.length - 1) return false;
    return true;
  });

  const avgRecovPace = (() => {
    const allLaps = recovGroups.flatMap(g => g.laps).filter(l => l.paceMPM);
    return allLaps.length
      ? allLaps.reduce((s, l) => s + l.paceMPM, 0) / allLaps.length
      : null;
  })();

  // Build summary string
  const repCount = hardGroups.length;
  let distStr = '';
  if (avgRepDist) {
    const ft = Math.round(avgRepDist * 5280 / 100) * 100;
    distStr = ft >= 880 ? `${Math.round(avgRepDist * 5280)}m` : `${ft}ft`;
  }

  let summary = repCount > 1
    ? `${repCount}×${distStr || 'rep'}`.trim()
    : `${distStr || 'hard effort'}`;

  if (avgHardPace) summary += ` @ ${fmtPace(avgHardPace)}/mi`;
  if (avgRecovPace) summary += ` · recovery ${fmtPace(avgRecovPace)}/mi`;

  return {
    repCount,
    avgHardPaceMPM:     avgHardPace ? r3(avgHardPace) : null,
    avgRepDistMi:       avgRepDist  ? r3(avgRepDist)  : null,
    avgRecoveryPaceMPM: avgRecovPace ? r3(avgRecovPace) : null,
    summary,
  };
}

/* ── Training summary text builder ──────────────────────────────────────── */

function buildSummaryText(analyses) {
  if (!analyses || !analyses.length) return null;

  const valid = analyses.filter(a => a.pattern && a.pattern.type !== 'Unknown');
  if (!valid.length) return null;

  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const typeCounts   = {};
  const intervalRecs = [];
  const tempoRecs    = [];
  const easyByMonth  = {};
  const hardByDow    = {};

  valid.forEach(a => {
    const type = a.pattern.type;
    typeCounts[type] = (typeCounts[type] || 0) + 1;

    if (a.date) {
      const dow   = new Date(a.date + 'T12:00:00').getDay();
      const month = a.date.slice(0, 7);

      if (type !== 'Easy Steady') {
        hardByDow[dow] = (hardByDow[dow] || 0) + 1;
      }

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

  const typeList = Object.entries(typeCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
  lines.push(`Workout breakdown (90 days): ${typeList}`);

  if (intervalRecs.length >= 2) {
    const sorted  = [...intervalRecs].sort((a, b) => a.date.localeCompare(b.date));
    const oldest  = sorted[0];
    const newest  = sorted[sorted.length - 1];
    const diffSec = Math.round((oldest.pace - newest.pace) * 60);
    const trend   = diffSec > 5 ? `improving ${diffSec}s/mi` : diffSec < -5 ? `slowing ${Math.abs(diffSec)}s/mi` : 'stable';
    lines.push(`Interval pace trend: ${fmtPace(oldest.pace)} → ${fmtPace(newest.pace)}/mi (${trend})`);
  }

  const easyMonths = Object.entries(easyByMonth).sort(([a], [b]) => a.localeCompare(b));
  if (easyMonths.length >= 2) {
    const avgFirst = avg(easyMonths[0][1]);
    const avgLast  = avg(easyMonths[easyMonths.length - 1][1]);
    const diffSec  = Math.round((avgFirst - avgLast) * 60);
    const trend    = diffSec > 5 ? `${diffSec}s/mi faster (aerobic improvement)` :
                     diffSec < -5 ? `${Math.abs(diffSec)}s/mi slower (possible fatigue)` : 'stable';
    lines.push(`Easy run pace trend: ${fmtPace(avgFirst)} → ${fmtPace(avgLast)}/mi (${trend})`);
  }

  const sortedDays = Object.entries(hardByDow)
    .filter(([, n]) => n >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3)
    .map(([d]) => DAY_NAMES[parseInt(d)]);
  if (sortedDays.length) lines.push(`Typical quality days: ${sortedDays.join(', ')}`);

  // Most recent sessions with hard effort details
  const byDate      = [...valid].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const lastInterval = byDate.find(a => a.pattern.type === 'Intervals');
  const lastTempo    = byDate.find(a => a.pattern.type === 'Tempo');

  if (lastInterval) {
    const detail = lastInterval.hardEffortSummary || lastInterval.pattern.description;
    lines.push(`Last interval session: ${lastInterval.date} · "${lastInterval.name}" · ${detail}`);
  }
  if (lastTempo) {
    const detail = lastTempo.hardEffortSummary || lastTempo.pattern.description;
    lines.push(`Last tempo run: ${lastTempo.date} · "${lastTempo.name}" · ${detail}`);
  }

  // Recent workouts with hard effort summaries (last 5)
  const recentHard = byDate
    .filter(a => a.hardEffortSummary && a.pattern.type !== 'Easy Steady')
    .slice(0, 5);
  if (recentHard.length) {
    const hardLines = recentHard.map(a =>
      `  ${a.date} "${a.name}" (${a.distMi ? a.distMi + 'mi' : '?mi'}): ${a.hardEffortSummary}`
    );
    lines.push(`Recent quality sessions:\n${hardLines.join('\n')}`);
  }

  return lines.join('\n');
}

/* ── Shared lap analysis ─────────────────────────────────────────────────── */

function classifyLaps(laps, threshPaceMin) {
  const thresh     = threshPaceMin || 7.5;
  const classified = [];

  laps.forEach((lap, i) => {
    const distMi  = (lap.distance || 0) / 1609.34;
    const durMin  = ((lap.elapsed_time || lap.moving_time || 0)) / 60;
    const speed   = lap.average_speed;
    const paceMPM = (speed && lap.distance > 50) ? 1609.34 / speed / 60 : null;
    const hr      = lap.average_heartrate ? Math.round(lap.average_heartrate) : null;
    const maxHR   = lap.max_heartrate     ? Math.round(lap.max_heartrate)     : null;
    const elevFt  = lap.total_elevation_gain ? Math.round(lap.total_elevation_gain * 3.28084) : null;

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
      hr, maxHR, elevFt,
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
    const hl       = core.filter(l => l.classification === 'Hard' || l.classification === 'Interval');
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
