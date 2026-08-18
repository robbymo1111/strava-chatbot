'use strict';

/**
 * RULE ENGINE — the guardrail.
 *
 * Pure functions. No I/O, no async, no dependencies. Every check returns the
 * boolean AND the numbers behind it so the model explains rather than computes.
 *
 * Per build spec §1: "Every rule check produces a boolean plus the numbers
 * behind it. The model receives both and explains. That makes rule enforcement
 * auditable and stops the bot from hallucinating compliance."
 *
 * Severity:
 *   hard     — never break, even on explicit request (spec §6.2)
 *   soft     — may be broken deliberately, but must be NAMED (spec §6.3)
 *   advisory — informational; model applies judgment
 */

const LONG_RUN_CAP_MI      = 18;
const WEEKLY_HARD_CAP_MI   = 60;
const WEEKLY_NOMINAL_PEAK  = 56;
const STEP_BACK_CAP_MI     = 45;
const RAMP_MULTIPLIER      = 1.10;
const BACK_TO_BACK_LONG_MI = 17;
const QUALITY_SPACING_H    = 72;
const MARATHON_SPACING_D   = 182;          // 6 months
const RACE_WEEK_CAP_MI     = 20;
const SUBT_PCT_MIN         = 20;
const SUBT_PCT_MAX         = 25;

// Calf failure conjunction (§4.1) — the trigger that has broken every build
const CALF_VOLUME_LO_MI    = 55;
const CALF_VOLUME_HI_MI    = 63;
const CALF_LONGRUN_LO_MI   = 19;

/* ── helpers ───────────────────────────────────────────────────────────────── */

function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Math.abs(new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z'));
  return Math.round(ms / 86400000);
}

function r1(n) { return Math.round(n * 10) / 10; }

function result(rule, name, passes, opts = {}) {
  return {
    rule,
    name,
    passes,
    severity: opts.severity || 'soft',
    actual:   opts.actual  != null ? opts.actual  : null,
    limit:    opts.limit   != null ? opts.limit   : null,
    margin:   opts.margin  != null ? opts.margin  : null,
    detail:   opts.detail  || '',
  };
}

/* ── Rule 1 — long run hard cap 18mi ───────────────────────────────────────── */

function ruleLongRunCap(proposed) {
  const mi = proposed.type === 'long' ? (proposed.distanceMi || 0) : 0;
  if (!mi) return result(1, 'Long run cap 18mi', true, { severity: 'hard', limit: LONG_RUN_CAP_MI, detail: 'Not a long run.' });

  const passes = mi <= LONG_RUN_CAP_MI;
  return result(1, 'Long run cap 18mi', passes, {
    severity: 'hard',
    actual: r1(mi),
    limit:  LONG_RUN_CAP_MI,
    margin: r1(LONG_RUN_CAP_MI - mi),
    detail: passes
      ? `${r1(mi)}mi is within the 18mi cap.`
      : `${r1(mi)}mi exceeds the 18mi hard cap by ${r1(mi - LONG_RUN_CAP_MI)}mi. Buy duration with pace (8:45–9:00), not distance. This rule does not bend on request.`,
  });
}

/* ── Rule 2 — weekly cap 60mi with conditions ──────────────────────────────── */

function ruleWeeklyCap(proposed, ctx) {
  const projected = (ctx.currentWeekMiles || 0) + (proposed.distanceMi || 0);
  const longRun   = Math.max(ctx.currentWeekLongRunMi || 0, proposed.type === 'long' ? (proposed.distanceMi || 0) : 0);

  // Step-back enforcement: two consecutive weeks >55 forces this week ≤45
  if ((ctx.weeksAbove55Consecutive || 0) >= 2) {
    const passes = projected <= STEP_BACK_CAP_MI;
    return result(2, 'Weekly cap / step-back', passes, {
      severity: 'soft',
      actual: r1(projected),
      limit:  STEP_BACK_CAP_MI,
      margin: r1(STEP_BACK_CAP_MI - projected),
      detail: passes
        ? `Step-back week required (2 consecutive weeks >55mi). ${r1(projected)}mi is within the ≤45mi step-back cap.`
        : `Step-back week REQUIRED — ${ctx.weeksAbove55Consecutive} consecutive weeks above 55mi. This week must be ≤45mi; projected ${r1(projected)}mi is ${r1(projected - STEP_BACK_CAP_MI)}mi over.`,
    });
  }

  if (projected > WEEKLY_HARD_CAP_MI) {
    return result(2, 'Weekly cap / step-back', false, {
      severity: 'hard',
      actual: r1(projected),
      limit:  WEEKLY_HARD_CAP_MI,
      margin: r1(WEEKLY_HARD_CAP_MI - projected),
      detail: `Projected ${r1(projected)}mi exceeds the 60mi absolute weekly cap by ${r1(projected - WEEKLY_HARD_CAP_MI)}mi.`,
    });
  }

  // 56–60 band requires both conditions
  if (projected > WEEKLY_NOMINAL_PEAK) {
    const longRunOk = longRun <= BACK_TO_BACK_LONG_MI;
    const quotaOk   = (ctx.sixtyMileWeeksThisBlock || 0) === 0;
    const passes    = longRunOk && quotaOk;
    const reasons   = [];
    if (!longRunOk) reasons.push(`this week's long run is ${r1(longRun)}mi (must be ≤17mi)`);
    if (!quotaOk)   reasons.push(`a 60mi week has already been used this block (max 1)`);

    return result(2, 'Weekly cap / step-back', passes, {
      severity: 'soft',
      actual: r1(projected),
      limit:  WEEKLY_NOMINAL_PEAK,
      margin: r1(WEEKLY_NOMINAL_PEAK - projected),
      detail: passes
        ? `${r1(projected)}mi is in the 56–60 band and both conditions are met (long run ≤17mi, first 60mi week of the block).`
        : `${r1(projected)}mi exceeds the 56mi nominal peak and the 60mi allowance conditions are not met: ${reasons.join('; ')}.`,
    });
  }

  return result(2, 'Weekly cap / step-back', true, {
    severity: 'soft',
    actual: r1(projected),
    limit:  WEEKLY_NOMINAL_PEAK,
    margin: r1(WEEKLY_NOMINAL_PEAK - projected),
    detail: `${r1(projected)}mi is within the 56mi nominal peak.`,
  });
}

/* ── Rule 3 — weekly ramp ≤110% of trailing 4-week average ─────────────────── */

function ruleWeeklyRamp(proposed, ctx) {
  const avg = ctx.trailing4wkAvgMiles;
  if (!avg) {
    return result(3, 'Weekly ramp ≤110% of 4wk avg', true, {
      severity: 'advisory',
      detail: 'Trailing 4-week average unavailable — cannot evaluate ramp.',
    });
  }

  const ceiling   = avg * RAMP_MULTIPLIER;
  const projected = (ctx.currentWeekMiles || 0) + (proposed.distanceMi || 0);
  const passes    = projected <= ceiling;
  const pctOver   = ((projected / avg) - 1) * 100;

  return result(3, 'Weekly ramp ≤110% of 4wk avg', passes, {
    severity: 'soft',
    actual: r1(projected),
    limit:  r1(ceiling),
    margin: r1(ceiling - projected),
    detail: passes
      ? `Projected ${r1(projected)}mi vs trailing 4wk avg ${r1(avg)}mi — ${r1(pctOver)}% ramp, within the 10% ceiling of ${r1(ceiling)}mi.`
      : `Projected ${r1(projected)}mi is ${r1(pctOver)}% above the trailing 4-week average of ${r1(avg)}mi. Ceiling is ${r1(ceiling)}mi (+10%). State this explicitly rather than silently adjusting.`,
  });
}

/* ── Rule 4 — no back-to-back long runs above 17mi ─────────────────────────── */

function ruleBackToBackLongRuns(proposed, ctx) {
  if (proposed.type !== 'long' || (proposed.distanceMi || 0) <= BACK_TO_BACK_LONG_MI) {
    return result(4, 'No back-to-back long runs >17mi', true, {
      severity: 'hard',
      limit: BACK_TO_BACK_LONG_MI,
      detail: 'Proposed session is not a long run above 17mi.',
    });
  }

  const priors = (ctx.longRunsLast14d || []).filter(l => (l.distanceMi || 0) > BACK_TO_BACK_LONG_MI);
  const passes = priors.length === 0;

  return result(4, 'No back-to-back long runs >17mi', passes, {
    severity: 'hard',
    actual: r1(proposed.distanceMi),
    limit:  BACK_TO_BACK_LONG_MI,
    margin: priors.length ? -priors.length : 0,
    detail: passes
      ? `No long run above 17mi in the last 14 days.`
      : `Back-to-back violation: proposed ${r1(proposed.distanceMi)}mi follows ${priors.map(p => `${r1(p.distanceMi)}mi on ${p.date}`).join(', ')}. This exact pattern (19.4mi Mar 29 + 18.1mi Apr 5 2026) produced the April calf failure.`,
  });
}

/* ── Rule 6 — race classification ──────────────────────────────────────────── */

function ruleRaceClassification(proposed) {
  if (proposed.type !== 'race') {
    return result(6, 'Race classification', true, { severity: 'advisory', detail: 'Not a race.' });
  }

  const mi = proposed.raceDistanceMi || proposed.distanceMi || 0;
  const isShort = mi <= 6.3; // 10K

  return result(6, 'Race classification', true, {
    severity: 'advisory',
    actual: r1(mi),
    limit:  6.3,
    detail: isShort
      ? `${r1(mi)}mi race (≤10K) counts as a sanctioned quality session and replaces this week's Q2. No taper needed.`
      : `${r1(mi)}mi race is above 10K — requires a taper and counts as a race, not a workout. Do not also schedule Q2 this week.`,
  });
}

/* ── Rule 7 — 72h minimum between quality efforts ──────────────────────────── */

function ruleQualitySpacing(proposed, ctx) {
  const isQuality = proposed.type === 'quality' || proposed.type === 'race';
  if (!isQuality) {
    return result(7, '72h between quality efforts', true, {
      severity: 'hard', limit: QUALITY_SPACING_H, detail: 'Proposed session is not a quality effort.',
    });
  }

  const hrs = ctx.hoursSinceLastQuality;
  if (hrs == null) {
    return result(7, '72h between quality efforts', true, {
      severity: 'advisory', limit: QUALITY_SPACING_H,
      detail: 'Hours since last quality unknown — cannot evaluate.',
    });
  }

  const passes = hrs >= QUALITY_SPACING_H;
  return result(7, '72h between quality efforts', passes, {
    severity: 'hard',
    actual: Math.round(hrs),
    limit:  QUALITY_SPACING_H,
    margin: Math.round(hrs - QUALITY_SPACING_H),
    detail: passes
      ? `${Math.round(hrs)}h since last quality effort — clears the 72h minimum.`
      : `Only ${Math.round(hrs)}h since the last quality effort; 72h minimum. Need ${Math.round(QUALITY_SPACING_H - hrs)}h more. This caps quality at 2 days/week — both sub-2:56 builds ran exactly that. Do not "fix" it.`,
  });
}

/* ── Rule 8 — marathon spacing ≥6 months ───────────────────────────────────── */

function ruleMarathonSpacing(proposed, ctx) {
  const mi = proposed.raceDistanceMi || proposed.distanceMi || 0;
  const isMarathon = proposed.type === 'race' && mi >= 26;
  if (!isMarathon) {
    return result(8, 'Marathon spacing ≥6 months', true, {
      severity: 'hard', limit: MARATHON_SPACING_D, detail: 'Not a marathon.',
    });
  }

  const gap = daysBetween(ctx.lastMarathonDate, proposed.date);
  if (gap == null) {
    return result(8, 'Marathon spacing ≥6 months', true, {
      severity: 'advisory', limit: MARATHON_SPACING_D, detail: 'No prior marathon on record.',
    });
  }

  const passes = gap >= MARATHON_SPACING_D;
  return result(8, 'Marathon spacing ≥6 months', passes, {
    severity: 'hard',
    actual: gap,
    limit:  MARATHON_SPACING_D,
    margin: gap - MARATHON_SPACING_D,
    detail: passes
      ? `${gap} days since the last marathon (${ctx.lastMarathonDate}) — clears the 6-month minimum.`
      : `Only ${gap} days since the last marathon (${ctx.lastMarathonDate}); 6-month (182d) minimum. A marathon inside 14 days of another is an injury with a bib number — this was violated May 17 + May 24 2026.`,
  });
}

/* ── Rule 9 — shoe selection ───────────────────────────────────────────────── */

function ruleShoeSelection(proposed) {
  const shoe = (proposed.shoe || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!shoe) {
    return result(9, 'Shoe selection', true, { severity: 'advisory', detail: 'No shoe specified.' });
  }

  const mi = proposed.raceDistanceMi || proposed.distanceMi || 0;

  if (shoe.includes('AP4')) {
    const passes = proposed.type === 'race' && mi < 8;
    return result(9, 'Shoe selection', passes, {
      severity: 'hard',
      actual: `AP4 on ${proposed.type} ${r1(mi)}mi`,
      limit:  'AP4: races <8mi only',
      detail: passes
        ? `AP4 is permitted — race under 8mi.`
        : `AP4 is restricted to races under 8mi. It caused the April 2026 injury. Use ZF6 (workouts/long runs) or AF3 (race day) — the rocker geometry offloads the calf.`,
    });
  }

  return result(9, 'Shoe selection', true, {
    severity: 'advisory',
    actual: shoe,
    detail: shoe.includes('AF3')
      ? 'AF3 — race day shoe.'
      : shoe.includes('ZF6')
        ? 'ZF6 — correct for workouts and long runs.'
        : `${shoe} — not one of the three tracked shoes (AF3/ZF6/AP4).`,
  });
}

/* ── Taper rule — race week ≤20mi ──────────────────────────────────────────── */

function ruleTaperWeek(proposed, ctx) {
  if (!ctx.isRaceWeek) {
    return result('taper', 'Race week cap 20mi', true, { severity: 'advisory', detail: 'Not race week.' });
  }

  const projected = (ctx.currentWeekMiles || 0) + (proposed.distanceMi || 0);
  const passes    = projected <= RACE_WEEK_CAP_MI;

  return result('taper', 'Race week cap 20mi', passes, {
    severity: 'soft',
    actual: r1(projected),
    limit:  RACE_WEEK_CAP_MI,
    margin: r1(RACE_WEEK_CAP_MI - projected),
    detail: passes
      ? `Race week projected ${r1(projected)}mi — within the 20mi cap. Keep two sub-T touches.`
      : `Race week projected ${r1(projected)}mi exceeds the 20mi hard cap by ${r1(projected - RACE_WEEK_CAP_MI)}mi. Best historical results came at 43–50% of peak volume with a sharp, short taper.`,
  });
}

/* ── Calf conjunction (§4.1) — the failure mode that breaks every build ────── */

function checkCalfConjunction(proposed, ctx) {
  const projectedWeek = (ctx.currentWeekMiles || 0) + (proposed.distanceMi || 0);
  const longRun = Math.max(
    ctx.currentWeekLongRunMi || 0,
    proposed.type === 'long' ? (proposed.distanceMi || 0) : 0
  );

  const volumeInBand  = projectedWeek >= CALF_VOLUME_LO_MI && projectedWeek <= CALF_VOLUME_HI_MI;
  const longRunInBand = longRun >= CALF_LONGRUN_LO_MI;
  const triggered     = volumeInBand && longRunInBand;

  return result('calf', 'Calf failure conjunction', !triggered, {
    severity: 'hard',
    actual: `${r1(projectedWeek)}mi week / ${r1(longRun)}mi long run`,
    limit:  `not (${CALF_VOLUME_LO_MI}–${CALF_VOLUME_HI_MI}mi AND long run ≥${CALF_LONGRUN_LO_MI}mi)`,
    detail: triggered
      ? `CALF CONJUNCTION TRIGGERED: ${r1(projectedWeek)}mi week combined with a ${r1(longRun)}mi long run. This exact combination has produced failure within 1–2 weeks in every build for 6 years. Break the conjunction — drop the long run below 19mi or the week below 55mi.`
      : volumeInBand
        ? `Weekly volume ${r1(projectedWeek)}mi is in the 55–63mi risk band, but the long run (${r1(longRun)}mi) stays under 19mi — conjunction not met.`
        : `Outside the calf conjunction band.`,
  });
}

/* ── Sub-T volume share (method principle, computable) ─────────────────────── */

function checkSubTVolume(proposed, ctx) {
  const weekMin = ctx.weeklyRunMinutes;
  if (!weekMin) {
    return result('subt', 'Sub-T 20–25% of weekly time', true, {
      severity: 'advisory', detail: 'Weekly running minutes unavailable.',
    });
  }

  const subT      = (ctx.subTMinutesThisWeek || 0) + (proposed.subTMinutes || 0);
  const projMin   = weekMin + (proposed.durationMin || 0);
  const pct       = projMin > 0 ? (subT / projMin) * 100 : 0;
  const inBand    = pct >= SUBT_PCT_MIN && pct <= SUBT_PCT_MAX;
  const targetLo  = Math.round(projMin * SUBT_PCT_MIN / 100);
  const targetHi  = Math.round(projMin * SUBT_PCT_MAX / 100);

  return result('subt', 'Sub-T 20–25% of weekly time', inBand, {
    severity: 'advisory',
    actual: `${Math.round(subT)}min (${r1(pct)}%)`,
    limit:  `${targetLo}–${targetHi}min (20–25%)`,
    margin: Math.round(targetLo - subT),
    detail: inBand
      ? `Sub-T at ${Math.round(subT)}min of ${Math.round(projMin)}min weekly running (${r1(pct)}%) — inside the 20–25% target.`
      : pct < SUBT_PCT_MIN
        ? `Sub-T at ${Math.round(subT)}min (${r1(pct)}%) is below the 20–25% target of ${targetLo}–${targetHi}min. Room for ${Math.round(targetLo - subT)}min more.`
        : `Sub-T at ${Math.round(subT)}min (${r1(pct)}%) exceeds the 25% ceiling of ${targetHi}min.`,
  });
}

/* ── Public API ────────────────────────────────────────────────────────────── */

/**
 * Run a proposed session against every deterministic rule.
 *
 * @param {object} proposed
 *   { type: 'long'|'easy'|'quality'|'race'|'cross', distanceMi, durationMin,
 *     subTMinutes, raceDistanceMi, shoe, date }
 * @param {object} ctx
 *   { trailing4wkAvgMiles, currentWeekMiles, currentWeekLongRunMi,
 *     longRunsLast14d:[{date,distanceMi}], hoursSinceLastQuality,
 *     lastMarathonDate, weeksAbove55Consecutive, sixtyMileWeeksThisBlock,
 *     isRaceWeek, weeklyRunMinutes, subTMinutesThisWeek }
 *
 * @returns {{ passes, hardViolations, softViolations, results }}
 */
function checkRules(proposed, ctx) {
  const p = proposed || {};
  const c = ctx || {};

  const results = [
    ruleLongRunCap(p),
    ruleWeeklyCap(p, c),
    ruleWeeklyRamp(p, c),
    ruleBackToBackLongRuns(p, c),
    ruleRaceClassification(p),
    ruleQualitySpacing(p, c),
    ruleMarathonSpacing(p, c),
    ruleShoeSelection(p),
    ruleTaperWeek(p, c),
    checkCalfConjunction(p, c),
    checkSubTVolume(p, c),
  ];

  const failed         = results.filter(r => !r.passes);
  const hardViolations = failed.filter(r => r.severity === 'hard');
  const softViolations = failed.filter(r => r.severity === 'soft');
  const advisories     = failed.filter(r => r.severity === 'advisory');

  return {
    // `passes` means "no rule is broken". Advisory shortfalls (e.g. sub-T volume
    // below target) are surfaced separately — they inform the prescription,
    // they do not make a legal session illegal.
    passes: hardViolations.length === 0 && softViolations.length === 0,
    hardViolations,
    softViolations,
    advisories,
    results,
  };
}

/**
 * Render rule results as a compact block for the prompt.
 * Passing advisory rules are omitted to keep the context terse.
 */
function formatRuleResults(check) {
  if (!check) return '';
  const lines = [];

  for (const r of check.hardViolations) {
    lines.push(`  ❌ HARD — Rule ${r.rule} (${r.name}): ${r.detail}`);
  }
  for (const r of check.softViolations) {
    lines.push(`  ⚠️  SOFT — Rule ${r.rule} (${r.name}): ${r.detail}`);
  }
  for (const r of (check.advisories || [])) {
    lines.push(`  ℹ️  NOTE — ${r.name}: ${r.detail}`);
  }
  if (!lines.length) return '  ✅ All rules pass.';
  return lines.join('\n');
}

module.exports = {
  checkRules,
  formatRuleResults,
  // exported individually for unit testing
  ruleLongRunCap,
  ruleWeeklyCap,
  ruleWeeklyRamp,
  ruleBackToBackLongRuns,
  ruleRaceClassification,
  ruleQualitySpacing,
  ruleMarathonSpacing,
  ruleShoeSelection,
  ruleTaperWeek,
  checkCalfConjunction,
  checkSubTVolume,
  constants: {
    LONG_RUN_CAP_MI, WEEKLY_HARD_CAP_MI, WEEKLY_NOMINAL_PEAK, STEP_BACK_CAP_MI,
    RAMP_MULTIPLIER, BACK_TO_BACK_LONG_MI, QUALITY_SPACING_H, MARATHON_SPACING_D,
    RACE_WEEK_CAP_MI, SUBT_PCT_MIN, SUBT_PCT_MAX,
    CALF_VOLUME_LO_MI, CALF_VOLUME_HI_MI, CALF_LONGRUN_LO_MI,
  },
};
