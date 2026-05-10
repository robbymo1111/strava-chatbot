/**
 * _lib.js — shared utilities for all API serverless functions.
 *
 * Files starting with _ are excluded from Vercel's route detection.
 * Every module that needs these helpers should: const lib = require('./_lib');
 *
 * Exports:
 *   isRun, fmtPace, getHRZones
 *   classifyRun, classifyActivities
 *   calculateTSS, calculateTrainingLoad
 *   getWeeklyBalance
 *   classifyLaps, detectPattern
 *   getAthleteId, kvGet, kvSet, kvPipeline
 */

'use strict';

/* ── Activity type check ──────────────────────────────────────────────────── */

/** Returns true if the Strava activity is any kind of run. */
function isRun(activity) {
  return /run/i.test(activity.type || '');
}

/* ── Pace formatter ───────────────────────────────────────────────────────── */

/** Formats a decimal minutes-per-mile value as "M:SS". Returns "?:??" for falsy input. */
function fmtPace(mpm) {
  if (!mpm) return '?:??';
  const m = Math.floor(mpm);
  const s = Math.round((mpm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ── HR zone boundaries (Swain et al. 1994) ──────────────────────────────── */

/**
 * Derives HR zone boundaries from athlete's max HR.
 * Returns null if maxHR is absent or implausible (< 100 or > 230).
 */
function getHRZones(maxHR) {
  if (!maxHR || maxHR < 100 || maxHR > 230) return null;
  return {
    recovery: maxHR * 0.63,  // below this → Recovery
    easy:     maxHR * 0.77,  // below this → Easy
    tempo:    maxHR * 0.85,  // below this → Tempo
    thresh:   maxHR * 0.87,  // below this → high-end Tempo / threshold
  };
}

/* ── Run classification ───────────────────────────────────────────────────── */

/**
 * Classifies a single Strava activity into a training category.
 *
 * Priority order:
 *   1. Strava workout_type flag (Race / Long Run / Workout)
 *   2. Speed variance (high ratio → Workout)
 *   3. Duration / distance rules
 *   4. VDOT threshold pace zones (when threshPaceMin is provided)
 *   5. Personalized HR zones (when hrZones is provided)
 *   6. Generic HR or pace fallback
 *
 * @param {object}      activity      - Strava activity object
 * @param {number|null} threshPaceMin - Athlete's threshold pace (min/mile), from VDOT
 * @param {object|null} hrZones       - HR zone boundaries from getHRZones()
 * @returns {string|null}
 */
function classifyRun(activity, threshPaceMin, hrZones) {
  if (!isRun(activity)) return null;

  const durationMin = (activity.moving_time || 0) / 60;
  const distMi      = (activity.distance    || 0) / 1609.34;
  const avgSpeed    = activity.average_speed;
  const avgPaceMPM  = avgSpeed ? 1609.34 / avgSpeed / 60 : null;
  const avgHR       = activity.average_heartrate;
  const speedRatio  = (activity.max_speed && avgSpeed > 0) ? activity.max_speed / avgSpeed : 1;
  const wt          = activity.workout_type;

  // Strava-tagged types take priority
  if (wt === 1) return 'Race';
  if (wt === 2) return 'Long Run';
  if (wt === 3) return 'Workout';

  // High speed variance = structured workout
  if (speedRatio > 1.9) return 'Workout';

  // Duration / distance heuristics
  if (durationMin >= 90) return 'Long Run';
  if (durationMin <= 35 && distMi <= 4) return 'Recovery Run';

  // VDOT threshold pace zones
  // Easy ≈ 106–118% of threshold pace; Tempo ≈ 97–106%
  if (threshPaceMin && avgPaceMPM) {
    if (avgPaceMPM > threshPaceMin * 1.18) return 'Recovery Run';
    if (avgPaceMPM > threshPaceMin * 1.06) return 'Easy Run';
    if (avgPaceMPM >= threshPaceMin * 0.97) return 'Tempo Run';
    return 'Workout';
  }

  // Personalized HR zones
  if (avgHR && hrZones) {
    if (avgHR < hrZones.recovery) return 'Recovery Run';
    if (avgHR < hrZones.easy)     return 'Easy Run';
    if (avgHR < hrZones.tempo)    return 'Tempo Run';
    return 'Workout';
  }

  // Generic HR thresholds
  if (avgHR) {
    if (avgHR < 135) return 'Recovery Run';
    if (avgHR < 150) return 'Easy Run';
    if (avgHR < 168) return 'Tempo Run';
    return 'Workout';
  }

  // Generic pace fallback
  if (avgPaceMPM) {
    if (avgPaceMPM > 12.0) return 'Recovery Run';
    if (avgPaceMPM >  9.5) return 'Easy Run';
    if (avgPaceMPM >  7.5) return 'Tempo Run';
    return 'Workout';
  }

  return 'Easy Run';
}

/** Mutates activities array, adding _classification to each item. */
function classifyActivities(activities, threshPaceMin, hrZones) {
  activities.forEach(a => { a._classification = classifyRun(a, threshPaceMin, hrZones); });
}

/* ── Training Stress Score ────────────────────────────────────────────────── */

/**
 * Estimates TSS (Coggan) for a single activity.
 *
 * IF (Intensity Factor) is derived in priority order:
 *   1. HR: avgHR / thresholdHR, where threshHR = personMaxHR × 0.87 (or actMaxHR × 0.90)
 *   2. Pace (runs only): threshPaceMin / avgPaceMPM
 *   3. Classification-based fallback constant
 *
 * TSS = duration_h × IF² × 100
 *
 * @param {object}      activity      - Strava activity
 * @param {number|null} threshPaceMin - Athlete's threshold pace (min/mile)
 * @param {number|null} personMaxHR   - Athlete's known max HR
 */
function calculateTSS(activity, threshPaceMin, personMaxHR) {
  const durationH = (activity.moving_time || 0) / 3600;
  if (durationH < 5 / 60) return 0;

  const avgHR    = activity.average_heartrate;
  const actMaxHR = activity.max_heartrate;
  const type     = (activity.type || '').toLowerCase();
  const cls      = activity._classification;

  let IF = 0.65; // default easy-run intensity

  if (avgHR) {
    // Prefer athlete's known maxHR × 0.87 (lactate threshold)
    const threshHR = personMaxHR
      ? personMaxHR * 0.87
      : (actMaxHR ? actMaxHR * 0.90 : avgHR * 1.1);
    IF = avgHR / threshHR;
  } else if (activity.average_speed && /run/i.test(type)) {
    const avgPaceMPM = 1609.34 / activity.average_speed / 60;
    IF = (threshPaceMin || 7.5) / avgPaceMPM;
  } else {
    // Classification-based constants
    const byClass = {
      'Recovery Run': 0.55, 'Easy Run': 0.65, 'Long Run': 0.65,
      'Tempo Run': 0.85,    'Workout': 0.95,  'Race': 1.0,
    };
    if (byClass[cls])                           IF = byClass[cls];
    else if (/ride|cycling/i.test(type))        IF = 0.70;
    else if (/swim/i.test(type))                IF = 0.75;
    else if (/weight|strength/i.test(type))     IF = 0.55;
  }

  IF = Math.min(Math.max(IF, 0.4), 1.15);
  return durationH * IF * IF * 100;
}

/**
 * Calculates ATL / CTL / TSB over a 90-day window using exponential weighted averages (Coggan PMC).
 * Time constants: CTL=42d, ATL=7d. Walking 90 days lets the EWA warm up accurately.
 *
 * CTL (chronic training load / fitness):  42-day EWA time constant
 * ATL (acute training load / fatigue):    7-day EWA time constant
 * TSB (training stress balance / form):   CTL − ATL
 *
 * @returns {{ ctl, atl, tsb, history: Array<{date, tss, ctl, atl, tsb}> }}
 */
function calculateTrainingLoad(activities, threshPaceMin, personMaxHR) {
  // Aggregate daily TSS
  const dailyTSS = {};
  activities.forEach(a => {
    const d = new Date(a.start_date_local || a.start_date).toISOString().split('T')[0];
    dailyTSS[d] = (dailyTSS[d] || 0) + calculateTSS(a, threshPaceMin, personMaxHR);
  });

  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const history = [];
  let ctl = 0, atl = 0;

  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    const tss = dailyTSS[key] || 0;
    ctl = ctl + (tss - ctl) / 42;
    atl = atl + (tss - atl) / 7;
    history.push({
      date: key,
      tss:  Math.round(tss),
      ctl:  Math.round(ctl * 10) / 10,
      atl:  Math.round(atl * 10) / 10,
      tsb:  Math.round((ctl - atl) * 10) / 10,
    });
  }

  const cur = history[history.length - 1];
  return { ctl: cur.ctl, atl: cur.atl, tsb: cur.tsb, history };
}

/* ── Weekly training balance ─────────────────────────────────────────────── */

/**
 * Summarises the past 7 days of runs by category and generates coaching warnings
 * about intensity distribution (targeted at endurance runners).
 */
function getWeeklyBalance(activities) {
  const cutoff  = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekRuns = activities.filter(a =>
    isRun(a) && new Date(a.start_date_local || a.start_date).getTime() > cutoff
  );

  const counts = {};
  weekRuns.forEach(a => {
    const cat = a._classification || 'Easy Run';
    counts[cat] = (counts[cat] || 0) + 1;
  });

  const easy     = counts['Easy Run']     || 0;
  const long     = counts['Long Run']     || 0;
  const tempo    = counts['Tempo Run']    || 0;
  const workout  = counts['Workout']      || 0;
  const recovery = counts['Recovery Run'] || 0;
  const race     = counts['Race']         || 0;
  const total    = weekRuns.length;
  const quality  = tempo + workout + race;

  const warnings = [];
  if (total >= 3) {
    if (quality > 2)
      warnings.push('High intensity load — more easy days would aid recovery');
    if (long === 0)
      warnings.push('No long run this week — long runs build your aerobic base');
    if (quality === 0 && total >= 4)
      warnings.push('All easy miles — consider adding one quality session');
    if (recovery > Math.ceil(total / 2) && total > 2)
      warnings.push('High recovery run count — possible accumulated fatigue');
  }

  return { total, quality, easy, long, tempo, workout, recovery, race, warnings };
}

/* ── Lap classification (used by laps.js and training-summary.js) ────────── */

/**
 * Classifies each lap relative to the athlete's threshold pace.
 *
 * Pace zones (% above/below threshold):
 *   > 15% slower  → Easy
 *   5–15% slower  → Moderate
 *   within ±5%    → Hard (threshold / tempo)
 *   faster        → Interval
 *
 * Special first/last lap rules:
 *   First lap (if slower than thresh) → Warm-up
 *   Last lap (if slower + preceded by hard effort) → Cool-down
 *
 * @param {Array}       laps          - Raw Strava lap objects
 * @param {number|null} threshPaceMin - Athlete's threshold pace (min/mile); defaults to 7.5
 * @returns {Array} Classified lap objects
 */
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
      else                                                           classification = 'Interval';
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

/**
 * Detects the overall workout structure from classified lap data.
 * Returns { type, description, stats }.
 *
 * Patterns detected: Intervals, Tempo, Progressive, Negative Split,
 *                    Long Run with Pace Work, Easy Steady, Mixed.
 */
function detectPattern(classifiedLaps) {
  const core = classifiedLaps.filter(
    l => l.classification !== 'Warm-up' && l.classification !== 'Cool-down'
  );
  if (core.length < 2) return { type: 'Unknown', description: 'Insufficient lap data', stats: {} };

  const classes   = core.map(l => l.classification);
  const hardCount = classes.filter(c => c === 'Interval' || c === 'Hard').length;
  const easyCount = classes.filter(c => c === 'Easy'     || c === 'Moderate').length;
  const paces     = core.map(l => l.paceMPM).filter(Boolean);

  // Intervals: 3+ hard efforts alternating with easy recovery
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
      const repFt     = Math.round(avgDistMi * 5280 / 100) * 100;
      return {
        type:        'Intervals',
        description: `${hardCount}×${repFt < 600 ? repFt + 'ft' : Math.round(avgDistMi * 5280) + 'm'} intervals · avg ${fmtPace(avgPace)}/mi`,
        stats:       { repCount: hardCount, avgHardPaceMPM: _r3(avgPace), avgRepDistMi: _r3(avgDistMi) },
      };
    }
  }

  // Tempo: 3+ consecutive hard laps
  let maxConsec = 0, cur = 0;
  classes.forEach(c => {
    if (c === 'Hard' || c === 'Interval') { cur++; maxConsec = Math.max(maxConsec, cur); }
    else cur = 0;
  });
  if (maxConsec >= 3) {
    const hardLaps = core.filter(l => l.classification === 'Hard' || l.classification === 'Interval');
    const totalMin = hardLaps.reduce((s, l) => s + (l.durationMin || 0), 0);
    const avgPace  = hardLaps.reduce((s, l) => s + (l.paceMPM    || 0), 0) / hardLaps.length;
    return {
      type:        'Tempo',
      description: `${Math.round(totalMin)}-min tempo · avg ${fmtPace(avgPace)}/mi`,
      stats:       { durationMin: Math.round(totalMin), avgPaceMPM: _r3(avgPace) },
    };
  }

  // Progressive: each lap successively faster (≤ 1% tolerance)
  if (paces.length >= 3) {
    const isProgressive = paces.every((p, i) => i === 0 || p <= paces[i - 1] * 1.01);
    if (isProgressive) {
      const improvement = ((paces[0] - paces[paces.length - 1]) / paces[0] * 100).toFixed(1);
      return {
        type:        'Progressive',
        description: `Progressive · ${fmtPace(paces[0])} → ${fmtPace(paces[paces.length - 1])}/mi (${improvement}% faster)`,
        stats:       { startPaceMPM: _r3(paces[0]), endPaceMPM: _r3(paces[paces.length - 1]) },
      };
    }
  }

  // Negative split: second half at least 1.5% faster
  if (core.length >= 4) {
    const half  = Math.floor(core.length / 2);
    const avg1  = _avg(core.slice(0, half).map(l => l.paceMPM).filter(Boolean));
    const avg2  = _avg(core.slice(half).map(l => l.paceMPM).filter(Boolean));
    if (avg1 && avg2 && avg2 < avg1 * 0.985) {
      return {
        type:        'Negative Split',
        description: `Negative split · ${fmtPace(avg1)} first half → ${fmtPace(avg2)}/mi second`,
        stats:       { firstHalfPaceMPM: _r3(avg1), secondHalfPaceMPM: _r3(avg2) },
      };
    }
  }

  // Long run with hard finish (final third has hard laps)
  if (core.length >= 6) {
    const split      = Math.floor(core.length * 2 / 3);
    const body       = core.slice(0, split);
    const finish     = core.slice(split);
    const bodyEasy   = body.every(l => l.classification === 'Easy' || l.classification === 'Moderate');
    const finishHard = finish.filter(l => l.classification === 'Hard' || l.classification === 'Interval').length;
    if (bodyEasy && finishHard >= 2) {
      return {
        type:        'Long Run with Pace Work',
        description: `Easy base · ${finishHard} hard finish laps`,
        stats:       { hardFinishLaps: finishHard },
      };
    }
  }

  // Easy steady
  if (classes.every(c => c === 'Easy' || c === 'Moderate')) {
    const avg = _avg(paces);
    return {
      type:        'Easy Steady',
      description: `Easy steady · avg ${avg ? fmtPace(avg) : '?:??'}/mi`,
      stats:       { avgPaceMPM: avg ? _r3(avg) : null },
    };
  }

  return { type: 'Mixed', description: 'Mixed effort run', stats: {} };
}

/* ── Strava / KV helpers ─────────────────────────────────────────────────── */

/**
 * Resolves the Strava athlete ID from an access token.
 * Returns null (not throws) on any failure, so callers can degrade gracefully.
 */
async function getAthleteId(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const a = await r.json();
    return a.id ? String(a.id) : null;
  } catch (_) { return null; }
}

/** Reads a single key from Upstash Redis REST API. Returns parsed value or null. */
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

/** Writes a single key/value to Upstash Redis REST API via pipeline. */
async function kvSet(url, token, key, value) {
  try {
    await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['SET', key, JSON.stringify(value)]]),
    });
  } catch (_) {}
}

/**
 * Executes a batch of Redis commands via Upstash pipeline in a single HTTP call.
 * @param {Array<Array>} commands  - e.g. [['GET','key1'], ['GET','key2']]
 * @returns {Array<{result}>}      - One result object per command
 */
async function kvPipeline(url, token, commands) {
  try {
    const r    = await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(commands),
    });
    return await r.json();
  } catch (_) { return commands.map(() => ({ result: null })); }
}

/* ── Private helpers ─────────────────────────────────────────────────────── */

function _r3(v) { return Math.round(v * 1000) / 1000; }
function _avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ── Mile split computation from Strava streams ───────────────────────────── */

/**
 * Compute per-mile splits from Strava activity streams.
 *
 * Input: keyed streams object — { distance, heartrate, velocity_smooth, altitude }
 *   each stream: { data: number[], series_type: 'time'|'distance', ... }
 *   With series_type='time': data[i] is the value at second i.
 *   distance.data[i] = cumulative meters at second i.
 *
 * Output: array of { mile, pace, gap, hr, elevFt } or null.
 */
function computeMileSplits(streams) {
  // Accept either a keyed object or an array of stream objects (API returns both)
  if (Array.isArray(streams)) {
    const obj = {};
    streams.forEach(s => { if (s && s.type) obj[s.type] = s; });
    streams = obj;
  }

  const distData = streams?.distance?.data;
  const hrData   = streams?.heartrate?.data;
  const altData  = streams?.altitude?.data;

  if (!distData || distData.length < 10) return null;

  const MILE_M    = 1609.34;
  const totalDist = distData[distData.length - 1];
  if (totalDist < MILE_M * 0.5) return null;

  const milesCount = Math.floor(totalDist / MILE_M + 0.05); // 26.2 → 26

  // Binary search: first index where distData[i] >= target
  function findIdx(target) {
    let lo = 0, hi = distData.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (distData[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  // Peak HR for effort classification
  let actPeakHR = null;
  if (hrData) {
    const valid = hrData.filter(h => h > 40 && h < 230);
    if (valid.length) actPeakHR = valid.reduce((m, h) => h > m ? h : m, 0);
  }

  const splits = [];

  for (let mile = 1; mile <= milesCount; mile++) {
    const startDist = (mile - 1) * MILE_M;
    const endDist   = Math.min(mile * MILE_M, totalDist);

    const startIdx = findIdx(startDist);
    const endIdx   = findIdx(endDist);
    if (endIdx <= startIdx) continue;

    const segDist = distData[endIdx] - distData[startIdx];
    const segSec  = endIdx - startIdx; // seconds (one data point per second)
    if (segDist < 50 || segSec < 5) continue;

    const paceMinPerMile = (segSec / 60) / (segDist / MILE_M);

    let avgHR = null;
    if (hrData && hrData.length > endIdx) {
      const slice = hrData.slice(startIdx, endIdx + 1).filter(h => h > 40 && h < 230);
      if (slice.length > 5) avgHR = Math.round(slice.reduce((a, b) => a + b, 0) / slice.length);
    }

    let elevChangeFt = null;
    if (altData && altData.length > endIdx) {
      elevChangeFt = Math.round((altData[endIdx] - altData[startIdx]) * 3.28084);
    }

    // Grade-adjusted pace (Minetti model approx)
    let gapMinPerMile = paceMinPerMile;
    if (elevChangeFt !== null && segDist > 0) {
      const gradePct  = ((elevChangeFt / 3.28084) / segDist) * 100;
      const gapFactor = 1 + gradePct * 0.033;
      if (gapFactor > 0.3 && gapFactor < 3.0) gapMinPerMile = paceMinPerMile / gapFactor;
    }

    // Effort classification: easy <76%, moderate 76–88%, hard ≥88% of activity peak HR
    let effort = null;
    if (avgHR && actPeakHR) {
      const ratio = avgHR / actPeakHR;
      effort = ratio >= 0.88 ? 'hard' : ratio >= 0.76 ? 'moderate' : 'easy';
    }

    splits.push({
      mile,
      pace:   fmtPace(paceMinPerMile),
      gap:    fmtPace(gapMinPerMile),
      hr:     avgHR,
      elevFt: elevChangeFt,
      effort,
    });
  }

  return splits.length > 0 ? splits : null;
}

/**
 * Detect effort/recovery blocks from velocity stream for interval workouts.
 * Uses 20-sample rolling average, then classifies samples above/below the
 * 55th-percentile velocity threshold. Returns null for steady-state runs
 * (CV < 15%) or when fewer than 2 effort blocks are found.
 *
 * @param {object|Array} streams  Strava streams (keyed object or raw array)
 * @returns {Array|null}  Array of { kind, startTime, durationS, distMi, pace, avgHR, maxHR }
 */
function computeVelocityBlocks(streams) {
  if (Array.isArray(streams)) {
    const obj = {};
    streams.forEach(s => { if (s && s.type) obj[s.type] = s; });
    streams = obj;
  }

  const rawVel = streams?.velocity_smooth?.data || [];
  const hrData = streams?.heartrate?.data       || [];
  const tData  = streams?.time?.data            || [];
  const dData  = streams?.distance?.data        || [];

  if (rawVel.length < 120) return null;

  const n    = rawVel.length;
  const tArr = tData.length === n ? tData : Array.from({ length: n }, (_, i) => i);
  const dArr = dData.length === n ? dData : null;

  // 20-sample rolling average to smooth GPS noise
  const vel = new Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - 19);
    let sum = 0, cnt = 0;
    for (let j = lo; j <= i; j++) {
      if (rawVel[j] > 0.3) { sum += rawVel[j]; cnt++; }
    }
    vel[i] = cnt ? sum / cnt : 0;
  }

  const active = vel.filter(v => v > 0.5);
  if (active.length < 60) return null;

  const velMean = active.reduce((a, b) => a + b, 0) / active.length;
  const velStd  = Math.sqrt(active.reduce((s, v) => s + (v - velMean) ** 2, 0) / active.length);
  if (velStd / velMean < 0.15) return null; // steady-state — no interval structure

  // Threshold: 55th percentile of active velocity
  const sorted    = [...active].sort((a, b) => a - b);
  const threshold = sorted[Math.floor(sorted.length * 0.55)];

  // Run-length encode into raw segments
  const segs    = [];
  let curKind   = vel[0] >= threshold ? 'effort' : 'recovery';
  let curStart  = 0;

  for (let i = 1; i <= n; i++) {
    const kind = i < n ? (vel[i] >= threshold ? 'effort' : 'recovery') : null;
    if (kind !== curKind) {
      segs.push({ kind: curKind, s: curStart, e: i - 1 });
      curStart = i;
      curKind  = kind;
    }
  }

  // Merge brief recovery gaps (≤12s) sandwiched between effort segments
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < segs.length - 1; i++) {
      if (segs[i - 1].kind === 'effort' &&
          segs[i].kind     === 'recovery' &&
          segs[i + 1].kind === 'effort' &&
          tArr[segs[i].e] - tArr[segs[i].s] <= 12) {
        segs.splice(i - 1, 3, { kind: 'effort', s: segs[i - 1].s, e: segs[i + 1].e });
        changed = true;
        break;
      }
    }
  }

  // Build output blocks, dropping very short segments
  const blocks = [];
  for (const seg of segs) {
    const durS = tArr[seg.e] - tArr[seg.s];
    if (seg.kind === 'effort'   && durS < 60) continue;
    if (seg.kind === 'recovery' && durS < 15) continue;

    const segVel = rawVel.slice(seg.s, seg.e + 1).filter(v => v > 0.3);
    const avgVel = segVel.length ? segVel.reduce((a, b) => a + b, 0) / segVel.length : 0;
    const paceMPM = avgVel > 0.3 ? 1609.34 / avgVel / 60 : null;

    let avgHR = null, maxHRVal = null;
    if (hrData.length > seg.e) {
      const segHR = hrData.slice(seg.s, seg.e + 1).filter(h => h > 40 && h < 230);
      if (segHR.length) {
        avgHR    = Math.round(segHR.reduce((a, b) => a + b, 0) / segHR.length);
        maxHRVal = segHR.reduce((m, h) => h > m ? h : m, 0);
      }
    }

    let distMi = null;
    if (dArr && dArr.length > seg.e) {
      distMi = Math.round((dArr[seg.e] - dArr[seg.s]) / 1609.34 * 100) / 100;
    }

    blocks.push({
      kind:      seg.kind,
      startTime: tArr[seg.s],
      durationS: Math.round(durS),
      distMi,
      pace:  paceMPM ? fmtPace(paceMPM) : null,
      avgHR,
      maxHR: maxHRVal,
    });
  }

  const effortCount = blocks.filter(b => b.kind === 'effort').length;
  return effortCount >= 2 ? blocks : null;
}

/* ── Exports ─────────────────────────────────────────────────────────────── */

module.exports = {
  isRun,
  fmtPace,
  getHRZones,
  classifyRun,
  classifyActivities,
  calculateTSS,
  calculateTrainingLoad,
  getWeeklyBalance,
  classifyLaps,
  detectPattern,
  getAthleteId,
  kvGet,
  kvSet,
  kvPipeline,
  computeMileSplits,
  computeVelocityBlocks,
};
