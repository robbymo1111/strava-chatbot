'use strict';

/**
 * Metrics layer tests.
 * Run: node --test tests/metrics.test.js
 *
 * Spec §9 validation cases:
 *   Aug 6 2026, 8:19/mi @ HR 129  → properly easy, ~0% gray zone
 *   Aug 4 2026, 3x12min           → clean sub-T, reps 148/155/161, NOT flagged too hot
 *   Sugarloaf 2026                → 3:38:59 elapsed, not 3:23:15 moving
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const M = require('../api/_coach-metrics.js');

/** Build a synthetic HR stream: [{hr, seconds}] → flat array */
function stream(segments) {
  const out = [];
  for (const s of segments) for (let i = 0; i < s.seconds; i++) out.push(s.hr);
  return out;
}

/* ── Spec §9 validation set ────────────────────────────────────────────────── */

describe('build spec §9 — known-answer validation cases', () => {

  test('Aug 6 2026 — 8:19/mi @ HR 129 reads as properly easy, ~0% gray', () => {
    // 60min steady at HR 127-131, nothing above 136
    const hr = stream([
      { hr: 118, seconds: 300 },  // warmup drift up
      { hr: 127, seconds: 1200 },
      { hr: 129, seconds: 1500 },
      { hr: 131, seconds: 600 },
    ]);

    const gz = M.computeGrayZone(hr, 'easy');
    assert.equal(gz.grayPct, 0, 'no time should land in the 136-152 gray band');
    assert.equal(gz.easyPct, 100);
    assert.equal(gz.flagged, false);
    assert.equal(gz.easyDisciplineOk, true, '>90% under HR 136');
    assert.match(gz.detail, /Properly easy/);
  });

  test('Aug 4 2026 — 3x12min sub-T with reps 148/155/161 is clean, NOT flagged hot', () => {
    const reps = [
      { label: 'Rep 1', avgHR: 148, durationSec: 720, paceMinMi: 6.55 },
      { label: 'Rep 2', avgHR: 155, durationSec: 720, paceMinMi: 6.53 },
      { label: 'Rep 3', avgHR: 161, durationSec: 720, paceMinMi: 6.57 },
    ];
    const recoveries = [{ minHR: 132 }, { minHR: 136 }];

    const a = M.analyzeReps(reps, recoveries);
    assert.equal(a.repCount, 3);
    assert.deepEqual(a.repHRs, [148, 155, 161]);
    assert.equal(a.droveAboveBand, false, '161 is inside the 155-162 band — not too hot');
    assert.equal(a.driftBpm, 13);
    assert.match(a.verdict, /Pace is primary/, 'must not flag the 148 opener as an error');
    assert.equal(a.recoveryClearance.cleared, 2);
    assert.equal(a.recoveryClearance.allCleared, true, 'both recoveries dropped below 140');
  });

  test('Aug 4 session as a whole is NOT gray-zone flagged (quality intent)', () => {
    // A sub-T session necessarily passes through 136-152 on warmup and recoveries.
    const hr = stream([
      { hr: 120, seconds: 600 },   // warmup
      { hr: 148, seconds: 720 },   // rep 1  → lands in the gray band by HR
      { hr: 135, seconds: 120 },   // recovery
      { hr: 155, seconds: 720 },   // rep 2
      { hr: 138, seconds: 120 },   // recovery
      { hr: 161, seconds: 720 },   // rep 3
      { hr: 125, seconds: 480 },   // cooldown
    ]);

    const asQuality = M.computeGrayZone(hr, 'subt');
    assert.equal(asQuality.flagged, false, 'gray zone is an easy-run error, not a workout error');
    assert.match(asQuality.detail, /Not a gray-zone error/);

    // The identical stream WOULD be flagged if the intent had been easy.
    const asEasy = M.computeGrayZone(hr, 'easy');
    assert.equal(asEasy.flagged, true);
  });

  test('Sugarloaf 2026 — reports elapsed 3:38:59, not moving 3:23:15', () => {
    const sugarloaf = { moving_time: 12195, elapsed_time: 13139 }; // 3:23:15 / 3:38:59
    const e = M.elapsedMinusMoving(sugarloaf);

    assert.equal(e.movingStr,  '3:23:15');
    assert.equal(e.elapsedStr, '3:38:59');
    assert.equal(e.stoppedStr, '15:44', '15:44 of stopped clock');
    assert.equal(e.significant, true);
  });
});

/* ── Absolute HR bands ─────────────────────────────────────────────────────── */

describe('absolute HR band classification', () => {
  test('bins seconds into the KB bands, not maxHR-relative zones', () => {
    const hr = stream([
      { hr: 130, seconds: 100 },  // easy
      { hr: 145, seconds: 100 },  // gray
      { hr: 153, seconds: 100 },  // mp
      { hr: 158, seconds: 100 },  // subt
      { hr: 165, seconds: 100 },  // threshold
      { hr: 172, seconds: 100 },  // vo2
    ]);
    const z = M.classifyHRSeconds(hr);

    assert.equal(z.seconds.easy, 100);
    assert.equal(z.seconds.gray, 100);
    assert.equal(z.seconds.mp, 100);
    assert.equal(z.seconds.subt, 100);
    assert.equal(z.seconds.threshold, 100);
    assert.equal(z.seconds.vo2, 100);
    assert.equal(z.totalSec, 600);
    assert.equal(z.peakHR, 172);
  });

  test('136 is the gray-zone floor and 152 the ceiling', () => {
    assert.equal(M.classifyHRSeconds(stream([{ hr: 135, seconds: 60 }])).seconds.easy, 60);
    assert.equal(M.classifyHRSeconds(stream([{ hr: 136, seconds: 60 }])).seconds.gray, 60);
    assert.equal(M.classifyHRSeconds(stream([{ hr: 151, seconds: 60 }])).seconds.gray, 60);
    assert.equal(M.classifyHRSeconds(stream([{ hr: 152, seconds: 60 }])).seconds.mp,   60);
  });

  test('filters implausible HR samples', () => {
    const z = M.classifyHRSeconds(stream([
      { hr: 0,   seconds: 50 },
      { hr: 250, seconds: 50 },
      { hr: 130, seconds: 100 },
    ]));
    assert.equal(z.totalSec, 100, 'only the valid samples count');
  });

  test('returns null on insufficient data rather than guessing', () => {
    assert.equal(M.classifyHRSeconds([]), null);
    assert.equal(M.classifyHRSeconds([130, 131]), null);
    assert.equal(M.classifyHRSeconds(null), null);
  });
});

/* ── Rep analysis ──────────────────────────────────────────────────────────── */

describe('rep analysis', () => {
  test('flags drift above the band on the final rep', () => {
    const a = M.analyzeReps([
      { avgHR: 156 }, { avgHR: 160 }, { avgHR: 166 },
    ], []);
    assert.equal(a.droveAboveBand, true);
    assert.match(a.verdict, /drifted above/);
    assert.match(a.verdict, /if pace was on target/, 'must not assume a pacing error');
  });

  test('recovery clearance counts drops below 140', () => {
    const a = M.analyzeReps(
      [{ avgHR: 158 }, { avgHR: 159 }],
      [{ minHR: 138 }, { minHR: 144 }]
    );
    assert.equal(a.recoveryClearance.cleared, 1);
    assert.equal(a.recoveryClearance.allCleared, false);
  });

  test('all reps in band gives a clean verdict', () => {
    const a = M.analyzeReps([{ avgHR: 157 }, { avgHR: 158 }, { avgHR: 160 }], []);
    assert.equal(a.allInBand, true);
    assert.match(a.verdict, /Clean execution/);
  });
});

/* ── Session type inference ────────────────────────────────────────────────── */

describe('session type inference', () => {
  test('workout_type takes priority', () => {
    assert.equal(M.inferSessionType({ type: 'Run', workout_type: 1, distance: 42195 }), 'race');
    assert.equal(M.inferSessionType({ type: 'Run', workout_type: 2, distance: 24000 }), 'long');
    assert.equal(M.inferSessionType({ type: 'Run', workout_type: 3, distance: 16000 }), 'subt');
  });

  test('reads workout structure out of the name', () => {
    assert.equal(M.inferSessionType({ type: 'Run', name: '3x12min sub-T', distance: 16000 }), 'subt');
    assert.equal(M.inferSessionType({ type: 'Run', name: '2x40 @ MP', distance: 25750 }), 'mp_long');
  });

  test('distance alone promotes to long', () => {
    assert.equal(M.inferSessionType({ type: 'Run', name: 'morning', distance: 22000 }), 'long');
    assert.equal(M.inferSessionType({ type: 'Run', name: 'morning', distance: 12000 }), 'easy');
  });

  test('non-runs are cross-training', () => {
    assert.equal(M.inferSessionType({ type: 'Ride', distance: 40000 }), 'cross');
  });
});

/* ── Rolling context ───────────────────────────────────────────────────────── */

describe('rolling context', () => {
  // today = Tue Aug 18 2026 → current week starts Mon Aug 17.
  // The four complete prior weeks are Jul 20, Jul 27, Aug 3, Aug 10.
  // 45 + 48 + 48 + 40 = 181 → 45.25 avg. Current week 20mi.
  const acts = [
    { type: 'Run', start_date_local: '2026-07-20', distance: 45 * 1609.34, moving_time: 21600 }, // wk -4
    { type: 'Run', start_date_local: '2026-07-27', distance: 48 * 1609.34, moving_time: 23000 }, // wk -3
    { type: 'Run', start_date_local: '2026-08-03', distance: 48 * 1609.34, moving_time: 23000 }, // wk -2
    { type: 'Run', start_date_local: '2026-08-04', distance: 0.01, moving_time: 60, workout_type: 3, name: '3x12min' },
    { type: 'Run', start_date_local: '2026-08-10', distance: 40 * 1609.34, moving_time: 19200 }, // wk -1
    { type: 'Run', start_date_local: '2026-08-17', distance: 20 * 1609.34, moving_time: 9600 },  // current
  ];

  test('trailing 4-week average uses complete prior weeks only', () => {
    const c = M.computeRollingContext(acts, { today: '2026-08-18' });
    assert.equal(c.trailing4wkAvgMiles, 45.3, '(45+48+48.01+40)/4');
    assert.equal(c.currentWeekMiles, 20, 'current week is excluded from its own average');
  });

  test('ramp ceiling is 110% of the trailing average', () => {
    const c = M.computeRollingContext(acts, { today: '2026-08-18' });
    assert.equal(c.rampCeilingMi, 49.8);
  });

  test('hours since last quality is computed from workout_type', () => {
    const c = M.computeRollingContext(acts, { today: '2026-08-18' });
    assert.equal(c.lastQualityDate, '2026-08-04');
    assert.equal(c.hoursSinceLastQuality, 14 * 24);
  });

  test('weeks to race and race week detection', () => {
    // 54 days to Chicago — matches the spec §5 example ("7.7 weeks to Chicago")
    const c = M.computeRollingContext(acts, { today: '2026-08-18', raceDate: '2026-10-11' });
    assert.equal(c.weeksToRace, 7.7);
    assert.equal(c.isRaceWeek, false);

    const rw = M.computeRollingContext(acts, { today: '2026-10-06', raceDate: '2026-10-11' });
    assert.equal(rw.isRaceWeek, true);
  });

  test('consecutive weeks above 55mi drive the step-back flag', () => {
    // Must be the two weeks immediately prior — Aug 10 and Aug 3.
    const heavy = [
      { type: 'Run', start_date_local: '2026-08-10', distance: 58 * 1609.34, moving_time: 27000 },
      { type: 'Run', start_date_local: '2026-08-03', distance: 57 * 1609.34, moving_time: 27000 },
    ];
    const c = M.computeRollingContext(heavy, { today: '2026-08-18' });
    assert.equal(c.weeksAbove55Consecutive, 2);
  });

  test('an intervening light week breaks the >55mi streak', () => {
    // Aug 10 is a 0mi week — the streak does not carry through it.
    const gapped = [
      { type: 'Run', start_date_local: '2026-08-03', distance: 58 * 1609.34, moving_time: 27000 },
      { type: 'Run', start_date_local: '2026-07-27', distance: 57 * 1609.34, moving_time: 27000 },
    ];
    const c = M.computeRollingContext(gapped, { today: '2026-08-18' });
    assert.equal(c.weeksAbove55Consecutive, 0);
  });

  test('sub-T minutes are null, never fabricated, when lap data is absent', () => {
    const c = M.computeRollingContext(acts, { today: '2026-08-18' });
    assert.equal(c.subTMinutesThisWeek, null);
    assert.equal(c.subTPctOfWeeklyTime, null);
  });

  test('sub-T minutes flow through when the caller supplies them', () => {
    const c = M.computeRollingContext(acts, { today: '2026-08-18', subTMinutesThisWeek: 36 });
    assert.equal(c.subTMinutesThisWeek, 36);
    assert.equal(c.subTPctOfWeeklyTime, 22.5, '36min of 160min weekly');
  });

  test('long runs in the last 14 days are surfaced for Rule 4', () => {
    const lr = [
      { type: 'Run', start_date_local: '2026-08-16', distance: 14.5 * 1609.34, moving_time: 7500 },
      { type: 'Run', start_date_local: '2026-08-09', distance: 17.5 * 1609.34, moving_time: 9000 },
      { type: 'Run', start_date_local: '2026-07-01', distance: 19 * 1609.34, moving_time: 10000 },
    ];
    const c = M.computeRollingContext(lr, { today: '2026-08-18' });
    assert.equal(c.longRunsLast14d.length, 2, 'July 1 is outside the window');
    assert.equal(c.maxLongRunLast14d, 17.5);
    assert.equal(c.longRunsLast14d[0].date, '2026-08-16', 'newest first');
  });

  test('week boundaries are Monday-start', () => {
    assert.equal(M.weekStart('2026-08-18'), '2026-08-17', 'Tue → Mon');
    assert.equal(M.weekStart('2026-08-17'), '2026-08-17', 'Mon → itself');
    assert.equal(M.weekStart('2026-08-23'), '2026-08-17', 'Sun → prior Mon');
  });
});

/* ── Context block ─────────────────────────────────────────────────────────── */

describe('context block rendering', () => {
  test('renders the spec §5 shape with real numbers', () => {
    const rolling = M.computeRollingContext([
      { type: 'Run', start_date_local: '2026-08-16', distance: 14.5 * 1609.34, moving_time: 7500 },
      { type: 'Run', start_date_local: '2026-08-03', distance: 48 * 1609.34, moving_time: 23000 },
    ], { today: '2026-08-18', raceDate: '2026-10-11' });

    const block = M.buildContextBlock(rolling);
    assert.match(block, /TODAY: Tuesday, August 18, 2026/);
    assert.match(block, /in 54 days = 7\.7 weeks/);
    assert.match(block, /trailing_4wk_avg:/);
    assert.match(block, /ramp_ceiling:/);
    assert.match(block, /do not recalculate/, 'must instruct the model not to redo the math');
  });

  test('states UNKNOWN for sub-T rather than inventing a number', () => {
    const rolling = M.computeRollingContext([], { today: '2026-08-18' });
    assert.match(M.buildContextBlock(rolling), /subt_this_week: UNKNOWN/);
  });

  test('surfaces Rule 4 as an active flag when a 17mi+ long run is recent', () => {
    const rolling = M.computeRollingContext([
      { type: 'Run', start_date_local: '2026-08-16', distance: 17.5 * 1609.34, moving_time: 9000 },
    ], { today: '2026-08-18' });
    assert.match(M.buildContextBlock(rolling), /Rule 4 active/);
  });
});
