/**
 * GET /api/laps?accessToken=xxx&activityId=yyy[&threshPaceMin=7.25]
 *
 * Returns classified lap data for a single Strava activity.
 * Results are cached indefinitely in Vercel KV (past activities don't change).
 * Falls back gracefully if KV is not configured.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const { accessToken, activityId, threshPaceMin: threshStr } = req.query;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });
  if (!activityId)  return res.status(400).json({ error: 'activityId required' });

  const thresh  = parseFloat(threshStr) || null;
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // ── 1. Resolve athlete ID for the cache key ──
  const athleteId = await getAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  const cacheKey = `laps:${athleteId}:${activityId}`;

  // ── 2. Check KV cache ──
  if (kvUrl && kvToken) {
    try {
      const cached = await kvGet(kvUrl, kvToken, cacheKey);
      if (cached) return res.status(200).json({ ...cached, fromCache: true });
    } catch (_) {}
  }

  // ── 3. Fetch from Strava ──
  let laps;
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/laps`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit reached — retry shortly' });
    if (!r.ok)            return res.status(502).json({ error: 'Could not fetch laps' });
    laps = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'Network error fetching laps' });
  }

  if (!Array.isArray(laps) || laps.length < 2) {
    return res.status(200).json({ laps: [], pattern: null, fromCache: false });
  }

  // ── 4. Classify & detect pattern ──
  const classifiedLaps = classifyLaps(laps, thresh);
  const pattern        = detectPattern(classifiedLaps);

  const result = { activityId, laps: classifiedLaps, pattern, analyzedAt: Date.now() };

  // ── 5. Cache (no expiry — past activities never change) ──
  if (kvUrl && kvToken) {
    try { await kvSet(kvUrl, kvToken, cacheKey, result); } catch (_) {}
  }

  return res.status(200).json({ ...result, fromCache: false });
};

/* ── Lap classification ───────────────────────────────────────────────────── */

/**
 * Classify each lap relative to athlete's threshold pace.
 *
 * Pace zones (% above threshold pace = slower):
 *   > 15% slower  → Easy
 *   5–15% slower  → Moderate
 *   within ±5%    → Hard (threshold/tempo pace)
 *   faster        → Interval
 *
 * Special: first lap if slower → Warm-up
 *          last lap if slower after a hard effort → Cool-down
 */
function classifyLaps(laps, threshPaceMin) {
  const thresh     = threshPaceMin || 7.5; // default 7:30/mi
  const classified = [];

  laps.forEach((lap, i) => {
    const distMi    = (lap.distance || 0) / 1609.34;
    const durMin    = ((lap.elapsed_time || lap.moving_time || 0)) / 60;
    const speed     = lap.average_speed;
    const paceMPM   = (speed && lap.distance > 50) ? 1609.34 / speed / 60 : null;
    const hr        = lap.average_heartrate ? Math.round(lap.average_heartrate) : null;

    let paceStr = null;
    if (paceMPM) {
      const m = Math.floor(paceMPM);
      const s = Math.round((paceMPM - m) * 60);
      paceStr = `${m}:${String(s).padStart(2, '0')}`;
    }

    let classification = 'Easy';
    if (paceMPM) {
      const pctAbove  = (paceMPM - thresh) / thresh; // positive = slower than threshold
      const prevCls   = classified.map(c => c.classification);
      const hadHard   = prevCls.some(c => c === 'Interval' || c === 'Hard');

      if      (i === 0 && pctAbove > 0.05)                              classification = 'Warm-up';
      else if (i === laps.length - 1 && pctAbove > 0.05 && hadHard)    classification = 'Cool-down';
      else if (pctAbove > 0.15)                                         classification = 'Easy';
      else if (pctAbove > 0.05)                                         classification = 'Moderate';
      else if (pctAbove > -0.05)                                        classification = 'Hard';
      else                                                               classification = 'Interval';
    }

    classified.push({
      lapNum:         i + 1,
      distMi:         Math.round(distMi * 100) / 100,
      durationMin:    Math.round(durMin * 10) / 10,
      pace:           paceStr,
      paceMPM:        paceMPM ? Math.round(paceMPM * 1000) / 1000 : null,
      hr,
      classification,
    });
  });

  return classified;
}

/**
 * Detect overall workout structure from classified laps.
 * Returns { type, description, stats }
 */
function detectPattern(classifiedLaps) {
  // Exclude warm-up and cool-down for structural analysis
  const core = classifiedLaps.filter(
    l => l.classification !== 'Warm-up' && l.classification !== 'Cool-down'
  );
  if (core.length < 2) return { type: 'Unknown', description: 'Insufficient lap data', stats: {} };

  const classes   = core.map(l => l.classification);
  const hardCount = classes.filter(c => c === 'Interval' || c === 'Hard').length;
  const easyCount = classes.filter(c => c === 'Easy'     || c === 'Moderate').length;
  const paces     = core.map(l => l.paceMPM).filter(Boolean);

  // ── Intervals: 3+ hard efforts alternating with easy recovery ──
  if (hardCount >= 3 && easyCount >= 2) {
    const isAlternating = classes.some((c, i) =>
      i > 0 &&
      (c === 'Interval' || c === 'Hard') &&
      (classes[i - 1] === 'Easy' || classes[i - 1] === 'Moderate')
    );
    if (isAlternating) {
      const hardLaps  = core.filter(l => l.classification === 'Interval' || l.classification === 'Hard');
      const avgPace   = hardLaps.reduce((s, l) => s + (l.paceMPM || 0), 0) / hardLaps.length;
      const avgDistMi = hardLaps.reduce((s, l) => s + (l.distMi  || 0), 0) / hardLaps.length;
      const repFt     = Math.round(avgDistMi * 5280 / 100) * 100; // nearest 100ft
      return {
        type:        'Intervals',
        description: `${hardCount}×${repFt < 600 ? repFt + 'ft' : Math.round(avgDistMi * 5280) + 'm'} intervals · avg ${fmtPace(avgPace)}/mi`,
        stats:       { repCount: hardCount, avgHardPaceMPM: round3(avgPace), avgRepDistMi: round3(avgDistMi) },
      };
    }
  }

  // ── Tempo: 3+ consecutive hard laps ──
  let maxConsec = 0, cur = 0;
  classes.forEach(c => {
    if (c === 'Hard' || c === 'Interval') { cur++; maxConsec = Math.max(maxConsec, cur); }
    else cur = 0;
  });
  if (maxConsec >= 3) {
    const hardLaps  = core.filter(l => l.classification === 'Hard' || l.classification === 'Interval');
    const totalMin  = hardLaps.reduce((s, l) => s + (l.durationMin || 0), 0);
    const avgPace   = hardLaps.reduce((s, l) => s + (l.paceMPM    || 0), 0) / hardLaps.length;
    return {
      type:        'Tempo',
      description: `${Math.round(totalMin)}-min tempo · avg ${fmtPace(avgPace)}/mi`,
      stats:       { durationMin: Math.round(totalMin), avgPaceMPM: round3(avgPace) },
    };
  }

  // ── Progressive: each lap successively faster (≤1% tolerance) ──
  if (paces.length >= 3) {
    const isProgressive = paces.every((p, i) => i === 0 || p <= paces[i - 1] * 1.01);
    if (isProgressive) {
      const improvement = ((paces[0] - paces[paces.length - 1]) / paces[0] * 100).toFixed(1);
      return {
        type:        'Progressive',
        description: `Progressive · ${fmtPace(paces[0])} → ${fmtPace(paces[paces.length - 1])}/mi (${improvement}% faster)`,
        stats:       { startPaceMPM: round3(paces[0]), endPaceMPM: round3(paces[paces.length - 1]) },
      };
    }
  }

  // ── Negative split: second half at least 1.5% faster ──
  if (core.length >= 4) {
    const half  = Math.floor(core.length / 2);
    const avg1  = avgOf(core.slice(0, half).map(l => l.paceMPM).filter(Boolean));
    const avg2  = avgOf(core.slice(half).map(l => l.paceMPM).filter(Boolean));
    if (avg1 && avg2 && avg2 < avg1 * 0.985) {
      return {
        type:        'Negative Split',
        description: `Negative split · ${fmtPace(avg1)} first half → ${fmtPace(avg2)}/mi second`,
        stats:       { firstHalfPaceMPM: round3(avg1), secondHalfPaceMPM: round3(avg2) },
      };
    }
  }

  // ── Long run with hard finish (final third has hard laps) ──
  if (core.length >= 6) {
    const split    = Math.floor(core.length * 2 / 3);
    const body     = core.slice(0, split);
    const finish   = core.slice(split);
    const bodyEasy = body.every(l => l.classification === 'Easy' || l.classification === 'Moderate');
    const finishHard = finish.filter(l => l.classification === 'Hard' || l.classification === 'Interval').length;
    if (bodyEasy && finishHard >= 2) {
      return {
        type:        'Long Run with Pace Work',
        description: `Easy base · ${finishHard} hard finish laps`,
        stats:       { hardFinishLaps: finishHard },
      };
    }
  }

  // ── Easy steady ──
  if (classes.every(c => c === 'Easy' || c === 'Moderate')) {
    const avg = avgOf(paces);
    return {
      type:        'Easy Steady',
      description: `Easy steady · avg ${avg ? fmtPace(avg) : '?:??'}/mi`,
      stats:       { avgPaceMPM: avg ? round3(avg) : null },
    };
  }

  return { type: 'Mixed', description: 'Mixed effort run', stats: {} };
}

/* ── Utilities ─────────────────────────────────────────────────────────────── */

function fmtPace(mpm) {
  if (!mpm) return '?:??';
  const m = Math.floor(mpm);
  const s = Math.round((mpm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function round3(v) { return Math.round(v * 1000) / 1000; }
function avgOf(arr) {
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
