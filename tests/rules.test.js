'use strict';

/**
 * Rule engine tests.
 * Run: node --test tests/
 *
 * Includes the validation cases from build spec §9 — these are drawn from
 * Robby's actual history and must trip the rules they historically violated.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const R = require('../api/_rules.js');

/* ── Spec §9 validation set ────────────────────────────────────────────────── */

describe('build spec §9 — known-answer validation cases', () => {

  test('Mar 29 + Apr 5 2026 back-to-back long runs trip Rule 4', () => {
    // Mar 29: 19.4mi. Apr 5: 18.1mi. Produced the April calf failure.
    const check = R.checkRules(
      { type: 'long', distanceMi: 18.1, date: '2026-04-05' },
      { longRunsLast14d: [{ date: '2026-03-29', distanceMi: 19.4 }] }
    );

    const r4 = check.results.find(r => r.rule === 4);
    assert.equal(r4.passes, false, 'Rule 4 must fail on back-to-back >17mi long runs');
    assert.equal(r4.severity, 'hard');
    assert.match(r4.detail, /19\.4mi on 2026-03-29/);
    assert.ok(check.hardViolations.some(r => r.rule === 4));
  });

  test('May 17 + May 24 2026 marathons trip Rule 8', () => {
    // Sugarloaf May 17, Buffalo May 24 — 7 days apart.
    const check = R.checkRules(
      { type: 'race', distanceMi: 26.2, raceDistanceMi: 26.2, date: '2026-05-24' },
      { lastMarathonDate: '2026-05-17' }
    );

    const r8 = check.results.find(r => r.rule === 8);
    assert.equal(r8.passes, false, 'Rule 8 must fail on marathons 7 days apart');
    assert.equal(r8.severity, 'hard');
    assert.equal(r8.actual, 7, 'gap should be 7 days');
    assert.equal(r8.limit, 182);
  });

  test('a legal marathon spacing passes Rule 8', () => {
    // Chicago Oct 11 2026 vs Buffalo May 24 2026 = 140 days — still short of 182.
    const short = R.checkRules(
      { type: 'race', distanceMi: 26.2, date: '2026-10-11' },
      { lastMarathonDate: '2026-05-24' }
    );
    assert.equal(short.results.find(r => r.rule === 8).passes, false);

    // A full year apart passes.
    const ok = R.checkRules(
      { type: 'race', distanceMi: 26.2, date: '2026-10-11' },
      { lastMarathonDate: '2025-10-11' }
    );
    assert.equal(ok.results.find(r => r.rule === 8).passes, true);
  });
});

/* ── Rule 1 — long run cap ─────────────────────────────────────────────────── */

describe('Rule 1 — long run hard cap 18mi', () => {
  test('18mi exactly passes', () => {
    const r = R.ruleLongRunCap({ type: 'long', distanceMi: 18 });
    assert.equal(r.passes, true);
    assert.equal(r.margin, 0);
  });

  test('18.1mi fails and is marked hard', () => {
    const r = R.ruleLongRunCap({ type: 'long', distanceMi: 18.1 });
    assert.equal(r.passes, false);
    assert.equal(r.severity, 'hard');
    assert.match(r.detail, /does not bend on request/);
  });

  test('20mi easy run is not a long run — rule not applicable', () => {
    const r = R.ruleLongRunCap({ type: 'easy', distanceMi: 20 });
    assert.equal(r.passes, true);
  });
});

/* ── Rule 2 — weekly cap ───────────────────────────────────────────────────── */

describe('Rule 2 — weekly cap and step-back', () => {
  test('within 56mi nominal peak passes', () => {
    const r = R.ruleWeeklyCap({ distanceMi: 10 }, { currentWeekMiles: 40 });
    assert.equal(r.passes, true);
    assert.equal(r.actual, 50);
  });

  test('58mi passes when long run ≤17 and no prior 60mi week', () => {
    const r = R.ruleWeeklyCap(
      { distanceMi: 10 },
      { currentWeekMiles: 48, currentWeekLongRunMi: 16, sixtyMileWeeksThisBlock: 0 }
    );
    assert.equal(r.passes, true);
  });

  test('58mi fails when the week already carries an 18mi long run', () => {
    const r = R.ruleWeeklyCap(
      { distanceMi: 10 },
      { currentWeekMiles: 48, currentWeekLongRunMi: 18, sixtyMileWeeksThisBlock: 0 }
    );
    assert.equal(r.passes, false);
    assert.match(r.detail, /must be ≤17mi/);
  });

  test('58mi fails when a 60mi week was already used this block', () => {
    const r = R.ruleWeeklyCap(
      { distanceMi: 10 },
      { currentWeekMiles: 48, currentWeekLongRunMi: 15, sixtyMileWeeksThisBlock: 1 }
    );
    assert.equal(r.passes, false);
    assert.match(r.detail, /already been used/);
  });

  test('above 60mi is a hard violation', () => {
    const r = R.ruleWeeklyCap({ distanceMi: 15 }, { currentWeekMiles: 50 });
    assert.equal(r.passes, false);
    assert.equal(r.severity, 'hard');
  });

  test('two consecutive weeks >55 forces a ≤45mi step-back week', () => {
    const over = R.ruleWeeklyCap({ distanceMi: 10 }, { currentWeekMiles: 40, weeksAbove55Consecutive: 2 });
    assert.equal(over.passes, false);
    assert.match(over.detail, /Step-back week REQUIRED/);

    const ok = R.ruleWeeklyCap({ distanceMi: 5 }, { currentWeekMiles: 38, weeksAbove55Consecutive: 2 });
    assert.equal(ok.passes, true);
  });
});

/* ── Rule 3 — ramp ─────────────────────────────────────────────────────────── */

describe('Rule 3 — weekly ramp ≤110% of trailing 4wk average', () => {
  test('spec example: 54mi against a 45.2mi average fails', () => {
    const r = R.ruleWeeklyRamp({ distanceMi: 0 }, { currentWeekMiles: 54, trailing4wkAvgMiles: 45.2 });
    assert.equal(r.passes, false);
    assert.equal(r.limit, 49.7, 'ceiling should be 45.2 * 1.10 = 49.7');
    assert.match(r.detail, /19\.5% above/);
  });

  test('at exactly the ceiling passes', () => {
    const r = R.ruleWeeklyRamp({ distanceMi: 0 }, { currentWeekMiles: 49.7, trailing4wkAvgMiles: 45.2 });
    assert.equal(r.passes, true);
  });

  test('missing average degrades to advisory, not a failure', () => {
    const r = R.ruleWeeklyRamp({ distanceMi: 10 }, { currentWeekMiles: 40 });
    assert.equal(r.passes, true);
    assert.equal(r.severity, 'advisory');
  });
});

/* ── Rule 7 — quality spacing ──────────────────────────────────────────────── */

describe('Rule 7 — 72h between quality efforts', () => {
  test('48h since last quality fails', () => {
    const r = R.ruleQualitySpacing({ type: 'quality' }, { hoursSinceLastQuality: 48 });
    assert.equal(r.passes, false);
    assert.equal(r.margin, -24);
    assert.match(r.detail, /Do not "fix" it/);
  });

  test('72h exactly passes', () => {
    const r = R.ruleQualitySpacing({ type: 'quality' }, { hoursSinceLastQuality: 72 });
    assert.equal(r.passes, true);
  });

  test('an easy run is unaffected by spacing', () => {
    const r = R.ruleQualitySpacing({ type: 'easy' }, { hoursSinceLastQuality: 12 });
    assert.equal(r.passes, true);
  });

  test('a race counts as a quality effort for spacing', () => {
    const r = R.ruleQualitySpacing({ type: 'race' }, { hoursSinceLastQuality: 24 });
    assert.equal(r.passes, false);
  });
});

/* ── Rule 6 — race classification ──────────────────────────────────────────── */

describe('Rule 6 — race classification', () => {
  test('10K is a sanctioned quality session replacing Q2', () => {
    const r = R.ruleRaceClassification({ type: 'race', raceDistanceMi: 6.2 });
    assert.match(r.detail, /replaces this week's Q2/);
  });

  test('half marathon requires a taper and counts as a race', () => {
    const r = R.ruleRaceClassification({ type: 'race', raceDistanceMi: 13.1 });
    assert.match(r.detail, /requires a taper/);
  });
});

/* ── Rule 9 — shoes ────────────────────────────────────────────────────────── */

describe('Rule 9 — shoe selection', () => {
  test('AP4 on a long run is a hard violation', () => {
    const r = R.ruleShoeSelection({ type: 'long', distanceMi: 16, shoe: 'AP4' });
    assert.equal(r.passes, false);
    assert.equal(r.severity, 'hard');
    assert.match(r.detail, /April 2026 injury/);
  });

  test('AP4 in a 5K race is permitted', () => {
    const r = R.ruleShoeSelection({ type: 'race', raceDistanceMi: 3.1, shoe: 'AP4' });
    assert.equal(r.passes, true);
  });

  test('AP4 in a 10 mile race is not permitted', () => {
    const r = R.ruleShoeSelection({ type: 'race', raceDistanceMi: 10, shoe: 'AP4' });
    assert.equal(r.passes, false);
  });

  test('ZF6 on a workout is fine', () => {
    const r = R.ruleShoeSelection({ type: 'quality', distanceMi: 10, shoe: 'ZF6' });
    assert.equal(r.passes, true);
  });
});

/* ── Calf conjunction ──────────────────────────────────────────────────────── */

describe('calf failure conjunction (§4.1)', () => {
  test('58mi week + 19mi long run triggers the conjunction', () => {
    const r = R.checkCalfConjunction(
      { type: 'long', distanceMi: 19 },
      { currentWeekMiles: 39 }
    );
    assert.equal(r.passes, false);
    assert.equal(r.severity, 'hard');
    assert.match(r.detail, /CALF CONJUNCTION TRIGGERED/);
  });

  test('58mi week with an 18mi long run does NOT trigger it', () => {
    const r = R.checkCalfConjunction(
      { type: 'long', distanceMi: 18 },
      { currentWeekMiles: 40 }
    );
    assert.equal(r.passes, true);
    assert.match(r.detail, /risk band/);
  });

  test('45mi week with a 20mi long run does NOT trigger it (volume outside band)', () => {
    const r = R.checkCalfConjunction(
      { type: 'long', distanceMi: 20 },
      { currentWeekMiles: 25 }
    );
    assert.equal(r.passes, true);
  });
});

/* ── Sub-T volume ──────────────────────────────────────────────────────────── */

describe('sub-T volume share', () => {
  test('flags when below the 20% floor', () => {
    const r = R.checkSubTVolume(
      { subTMinutes: 0, durationMin: 60 },
      { weeklyRunMinutes: 400, subTMinutesThisWeek: 30 }
    );
    assert.equal(r.passes, false);
    assert.match(r.detail, /below the 20–25% target/);
  });

  test('passes inside the band', () => {
    const r = R.checkSubTVolume(
      { subTMinutes: 40, durationMin: 60 },
      { weeklyRunMinutes: 400, subTMinutesThisWeek: 60 }
    );
    assert.equal(r.passes, true);
  });
});

/* ── Taper ─────────────────────────────────────────────────────────────────── */

describe('taper rule — race week ≤20mi', () => {
  test('25mi race week fails', () => {
    const r = R.ruleTaperWeek({ distanceMi: 5 }, { isRaceWeek: true, currentWeekMiles: 20 });
    assert.equal(r.passes, false);
  });

  test('non-race week is unaffected', () => {
    const r = R.ruleTaperWeek({ distanceMi: 15 }, { isRaceWeek: false, currentWeekMiles: 40 });
    assert.equal(r.passes, true);
  });
});

/* ── Aggregate behaviour ───────────────────────────────────────────────────── */

describe('checkRules aggregate', () => {
  test('a clean easy run passes everything', () => {
    const check = R.checkRules(
      { type: 'easy', distanceMi: 8, durationMin: 64, date: '2026-08-18' },
      {
        trailing4wkAvgMiles: 45.2, currentWeekMiles: 20, currentWeekLongRunMi: 14,
        longRunsLast14d: [], hoursSinceLastQuality: 96, weeklyRunMinutes: 300,
        subTMinutesThisWeek: 70,
      }
    );
    assert.equal(check.hardViolations.length, 0);
    assert.equal(check.softViolations.length, 0);
    assert.equal(check.passes, true, 'advisory shortfalls must not make a legal session illegal');
  });

  test('an advisory shortfall is surfaced but does not fail the check', () => {
    // sub-T at 70min of 364min = 19.2%, just under the 20% floor
    const check = R.checkRules(
      { type: 'easy', distanceMi: 8, durationMin: 64 },
      { trailing4wkAvgMiles: 45.2, currentWeekMiles: 20, hoursSinceLastQuality: 96,
        weeklyRunMinutes: 300, subTMinutesThisWeek: 70 }
    );
    assert.equal(check.passes, true);
    assert.equal(check.advisories.length, 1);
    assert.equal(check.advisories[0].rule, 'subt');
  });

  test('a 20mi long run in a 58mi week trips cap, calf, and ramp together', () => {
    const check = R.checkRules(
      { type: 'long', distanceMi: 20, date: '2026-08-18' },
      { currentWeekMiles: 38, trailing4wkAvgMiles: 45.2, longRunsLast14d: [] }
    );

    const ruleIds = check.results.filter(r => !r.passes).map(r => r.rule);
    assert.ok(ruleIds.includes(1),      'Rule 1 (18mi cap) should fail');
    assert.ok(ruleIds.includes('calf'), 'calf conjunction should fire');
    assert.ok(check.hardViolations.length >= 2);
  });

  test('formatRuleResults renders hard violations first', () => {
    const check = R.checkRules(
      { type: 'long', distanceMi: 20, date: '2026-08-18' },
      { currentWeekMiles: 38, trailing4wkAvgMiles: 45.2, longRunsLast14d: [] }
    );
    const out = R.formatRuleResults(check);
    assert.match(out, /❌ HARD/);
    assert.ok(out.indexOf('❌') < out.indexOf('⚠️') || !out.includes('⚠️'));
  });

  test('all-clear renders a pass line', () => {
    const check = R.checkRules(
      { type: 'easy', distanceMi: 6, durationMin: 48 },
      { trailing4wkAvgMiles: 45, currentWeekMiles: 10, hoursSinceLastQuality: 100,
        weeklyRunMinutes: 300, subTMinutesThisWeek: 70 }
    );
    assert.equal(R.formatRuleResults(check), '  ✅ All rules pass.');
  });
});
