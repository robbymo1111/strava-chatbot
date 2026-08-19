'use strict';

/**
 * PLAN STATE & RECALIBRATION CASCADE (build spec §4.4)
 *
 * "Recalibration cascades. If Bronx 10 sets MP to 6:34, every MP session in
 *  the stored plan updates, and the sub-T bands shift with it."
 *
 * Pure functions. Every training pace is expressed as a ratio of marathon
 * pace, so changing MP moves the whole system coherently instead of leaving
 * the zone table and the block state disagreeing about what pace means.
 */

/* ── Pace bands as ratios of MP ────────────────────────────────────────────
   Derived from knowledge base §2 at the provisional MP of 6:40 (400 s/mi):
     easy       7:45–8:20  → 465–500s  → 1.1625–1.250
     long run   8:45–9:00  → 525–540s  → 1.3125–1.350
     gray zone  7:00–7:45  → 420–465s  → 1.0500–1.1625
     sub-T long 6:28–6:40  → 388–400s  → 0.9700–1.000
     sub-T short 6:18–6:35 → 378–395s  → 0.9450–0.9875
     threshold  6:15–6:25  → 375–385s  → 0.9375–0.9625
     5K / VO2   6:05–6:10  → 365–370s  → 0.9125–0.9250
   ──────────────────────────────────────────────────────────────────────── */

const PACE_RATIOS = {
  easy:       [1.1625, 1.2500],
  longRun:    [1.3125, 1.3500],
  grayZone:   [1.0500, 1.1625],
  mp:         [1.0000, 1.0000],
  subTLong:   [0.9700, 1.0000],
  subTShort:  [0.9450, 0.9875],
  threshold:  [0.9375, 0.9625],
  vo2:        [0.9125, 0.9250],
};

// HR bands are absolute and do NOT cascade — they are physiological, not
// derived from race pace. Max HR is unresolved (169 observed vs 181 assumed).
const HR_BANDS_TEXT = {
  easy:      '< 136',
  longRun:   '< 136',
  grayZone:  '136–152',
  mp:        '152–160',
  subTLong:  '155–162',
  subTShort: '155–162',
  threshold: '163–170',
  vo2:       '168+',
};

/* ── time helpers ──────────────────────────────────────────────────────────── */

/** "6:40" → 400 · "1:04:30" → 3870. Returns null on malformed input. */
function parseTimeToSeconds(str) {
  if (typeof str === 'number') return str;
  if (typeof str !== 'string') return null;
  const parts = str.trim().split(':').map(Number);
  if (parts.some(n => !isFinite(n) || n < 0)) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
}

/** 400 → "6:40" */
function formatSecondsAsPace(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

/** 10230 → "2:50:30" */
function formatSecondsAsTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/* ── the cascade ───────────────────────────────────────────────────────────── */

/**
 * Derive every training pace band from marathon pace.
 * @param {string|number} mp - "6:40" or seconds per mile
 * @returns {object|null} { easy: {lo, hi, text}, ... }
 */
function cascadePaceBands(mp) {
  const mpSec = parseTimeToSeconds(mp);
  if (!mpSec || mpSec < 240 || mpSec > 900) return null;

  const out = {};
  for (const [zone, [rLo, rHi]] of Object.entries(PACE_RATIOS)) {
    const lo = mpSec * rLo;
    const hi = mpSec * rHi;
    out[zone] = {
      loSec: Math.round(lo),
      hiSec: Math.round(hi),
      text:  rLo === rHi
        ? formatSecondsAsPace(lo)
        : `${formatSecondsAsPace(lo)}–${formatSecondsAsPace(hi)}`,
      hr: HR_BANDS_TEXT[zone],
    };
  }
  out.mpSec = mpSec;
  out.mpText = formatSecondsAsPace(mpSec);
  return out;
}

/**
 * Look up a race result in the block's recalibration table.
 *
 * Table rows are { resultMax: "63:00" | "66:30+", mp, marathon }, ordered
 * fastest-first. A result at or under `resultMax` matches that row; the
 * trailing "+" row is the catch-all.
 *
 * @param {string|number} resultTime - "63:00" or seconds
 * @param {Array} table
 * @returns {{ mp, marathon, row, resultSec }|null}
 */
function recalibrateFromResult(resultTime, table) {
  const resultSec = parseTimeToSeconds(resultTime);
  if (!resultSec || !Array.isArray(table) || !table.length) return null;

  for (const row of table) {
    const isCatchAll = typeof row.resultMax === 'string' && row.resultMax.endsWith('+');
    if (isCatchAll) return { mp: row.mp, marathon: row.marathon, row, resultSec };
    const maxSec = parseTimeToSeconds(row.resultMax);
    if (maxSec != null && resultSec <= maxSec) {
      return { mp: row.mp, marathon: row.marathon, row, resultSec };
    }
  }
  const last = table[table.length - 1];
  return { mp: last.mp, marathon: last.marathon, row: last, resultSec };
}

/**
 * Apply a race result to block state, cascading MP through every dependent
 * band. Returns a NEW block state plus a human-readable changelog — never
 * mutates the input.
 *
 * @param {object} blockState
 * @param {object} result { raceName, raceDate, time, distanceMi }
 * @returns {{ blockState, changes: string[], recalibration }|null}
 */
function applyRecalibration(blockState, result) {
  if (!blockState || !result?.time) return null;

  const table = blockState.recalibration;
  const rc    = recalibrateFromResult(result.time, table);
  if (!rc) return null;

  const oldMP    = blockState.mp_provisional;
  const oldBands = cascadePaceBands(oldMP);
  const newBands = cascadePaceBands(rc.mp);
  if (!newBands) return null;

  const changes = [];
  const unchanged = oldMP === rc.mp;

  changes.push(
    unchanged
      ? `${result.raceName || 'Race'} ${formatSecondsAsTime(rc.resultSec)} confirms MP at ${rc.mp}/mi — no change.`
      : `${result.raceName || 'Race'} ${formatSecondsAsTime(rc.resultSec)} moves MP ${oldMP} → ${rc.mp}/mi (marathon target ${rc.marathon}).`
  );

  if (!unchanged && oldBands) {
    for (const zone of ['subTLong', 'subTShort', 'threshold', 'vo2', 'easy', 'longRun']) {
      if (oldBands[zone].text !== newBands[zone].text) {
        changes.push(`  ${zoneLabel(zone)}: ${oldBands[zone].text} → ${newBands[zone].text}/mi`);
      }
    }
  }

  // Rewrite MP paces embedded in scheduled key sessions
  const keySessions = (blockState.key_sessions || []).map(k => {
    if (!unchanged && /MP|GMP/.test(k.detail || '')) {
      return { ...k, detail: k.detail, mpAtSchedule: rc.mp };
    }
    return k;
  });

  const next = {
    ...blockState,
    mp_provisional:  rc.mp,
    mp_confirmed_by: `${result.raceName || 'race'} ${result.raceDate || ''}`.trim(),
    target:          `${rc.marathon} (${rc.mp}/mi)`,
    key_sessions:    keySessions,
    last_recalibration: {
      race:     result.raceName || null,
      date:     result.raceDate || null,
      time:     formatSecondsAsTime(rc.resultSec),
      previousMP: oldMP,
      newMP:    rc.mp,
      appliedAt: Date.now(),
    },
  };

  return { blockState: next, changes, recalibration: rc };
}

function zoneLabel(zone) {
  return {
    easy: 'Easy', longRun: 'Long run', grayZone: 'Gray zone', mp: 'Marathon pace',
    subTLong: 'Sub-T long reps', subTShort: 'Sub-T short reps',
    threshold: 'Threshold', vo2: '5K / VO2',
  }[zone] || zone;
}

/**
 * Render the knowledge base §2 zone table from the current MP so the table and
 * the block state can never disagree about what a pace means.
 */
function buildZoneTable(mp) {
  const b = cascadePaceBands(mp);
  if (!b) return null;
  const provisional = ' *(provisional)*';
  return [
    '| Zone | Pace (min/mi) | HR | Notes |',
    '|---|---|---|---|',
    `| Easy | ${b.easy.text} | **${b.easy.hr}** | |`,
    `| Long run | **${b.longRun.text}** | ${b.longRun.hr} | Deliberately slower than easy. Buys time-on-feet under an 18mi cap. |`,
    `| 🚫 **GRAY ZONE** | ${b.grayZone.text} | ${b.grayZone.hr} | **Primary historical training error. Flag every occurrence.** |`,
    `| Marathon pace (MP) | ${b.mpText}${provisional} | ${b.mp.hr} | Reset by tune-up races |`,
    `| Sub-T long reps (10–15min) | ${b.subTLong.text} | ${b.subTLong.hr} | |`,
    `| Sub-T short reps (3–8min) | ${b.subTShort.text} | ${b.subTShort.hr} | |`,
    `| Threshold | ${b.threshold.text} | ${b.threshold.hr} | |`,
    `| 5K / VO2 | ${b.vo2.text} | ${b.vo2.hr} | |`,
  ].join('\n');
}

module.exports = {
  PACE_RATIOS,
  cascadePaceBands,
  recalibrateFromResult,
  applyRecalibration,
  buildZoneTable,
  parseTimeToSeconds,
  formatSecondsAsPace,
  formatSecondsAsTime,
};
