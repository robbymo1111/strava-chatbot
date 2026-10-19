'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const L = require('../api/_coach-load.js');

describe('intensity exponent', () => {
  // Pace in min/mi. Threshold 6:30, easy 8:15.
  const T = 6.5, EASY = 8.25;

  test('k=1 matches running TSS — load per mile is the speed ratio', () => {
    assert.equal(Math.round(L.loadPerMile(EASY, T, 1) * 1000) / 1000, 0.788);
  });

  test('k=3 weights intensity far harder', () => {
    assert.equal(Math.round(L.loadPerMile(EASY, T, 3) * 1000) / 1000, 0.489);
  });

  test('a threshold mile is exactly one unit at any k', () => {
    for (const k of [1, 2, 3]) assert.equal(L.loadPerMile(T, T, k), 1);
  });

  test('faster than threshold is worth more than a unit', () => {
    assert.ok(L.loadPerMile(6.0, T, 1) > 1);
  });

  test('reproduces the published Kaizen example at k=3', () => {
    // 40km @ 5:30/km, then observed 5:00/km → ~30km. In min/mi:
    // 5:30/km = 8.85/mi, 5:00/km = 8.05/mi, 40km = 24.85mi
    const units = 24.85 * L.loadPerMile(8.85, T, 3);
    const revised = L.milesForLoad(units, 8.05, T, 3);
    assert.equal(Math.round(revised / 0.621371), 30, 'revised target lands on 30km');
  });

  test('the same example at k=1 moves far less', () => {
    const units = 24.85 * L.loadPerMile(8.85, T, 1);
    const revised = L.milesForLoad(units, 8.05, T, 1);
    assert.equal(Math.round(revised / 0.621371), 36, 'TSS-consistent maths gives 36km, not 30');
  });

  test('refuses nonsense input rather than returning a number', () => {
    assert.equal(L.loadPerMile(0, T, 1), null);
    assert.equal(L.loadPerMile(EASY, null, 1), null);
    assert.equal(L.milesForLoad(100, 0, T, 1), null);
  });
});

describe('block phase', () => {
  test('marathon recovery overrides everything', () => {
    const p = L.blockPhase({ weeksToRace: 7, daysSinceLastMarathon: 8 });
    assert.equal(p.phase, 'recovery');
    assert.ok(p.factor < 1);
    assert.match(p.why, /8 days ago/);
  });

  test('recovery expires after three weeks', () => {
    assert.equal(L.blockPhase({ weeksToRace: 7, daysSinceLastMarathon: 25 }).phase, 'build');
  });

  test('tapers down into race week', () => {
    assert.equal(L.blockPhase({ weeksToRace: 6 }).phase, 'build');
    assert.equal(L.blockPhase({ weeksToRace: 3 }).phase, 'sharpen');
    assert.equal(L.blockPhase({ weeksToRace: 2 }).phase, 'taper');
    assert.equal(L.blockPhase({ weeksToRace: 1 }).phase, 'race week');
  });

  test('factors fall monotonically through the taper', () => {
    const f = w => L.blockPhase({ weeksToRace: w }).factor;
    assert.ok(f(6) > f(3) && f(3) > f(2) && f(2) > f(1));
  });
});

describe('weekly load target from CTL', () => {
  test('maintaining fitness needs 7 x CTL', () => {
    const t = L.weeklyLoadTarget({ ctl: 30, gainPerWeek: 0, phase: { factor: 1 } });
    assert.equal(t.tss, 210);
    assert.equal(t.maintainTss, 210);
  });

  test('gaining 2 CTL a week needs more', () => {
    const t = L.weeklyLoadTarget({ ctl: 30, gainPerWeek: 2, phase: { factor: 1 } });
    assert.equal(t.tss, 294, '7 x (30 + 12)');
  });

  test('the phase factor scales it', () => {
    const t = L.weeklyLoadTarget({ ctl: 30, gainPerWeek: 0, phase: { factor: 0.45 } });
    assert.equal(t.tss, 95);
  });

  test('returns null without a CTL rather than guessing', () => {
    assert.equal(L.weeklyLoadTarget({ ctl: 0 }), null);
    assert.equal(L.weeklyLoadTarget({}), null);
  });
});

describe('the adaptive week', () => {
  const base = {
    ctl: 30, gainPerWeek: 0, weeksToRace: 7, daysSinceLastMarathon: 8,
    threshPaceMinMi: 6.5, expectedPaceMinMi: 8.25,
  };

  test('an untouched week shows the baseline target', () => {
    const p = L.weeklyPlan({ ...base, doneMi: 0, doneMin: 0 });
    assert.equal(p.doneMi, 0);
    assert.equal(p.revisedMi, p.baselineMi, 'nothing run yet, so nothing has moved');
    assert.equal(p.pctComplete, 0);
    assert.equal(p.phase, 'recovery');
  });

  test('running FASTER than expected lowers the target', () => {
    // 10mi, not 20 — in a recovery week 20mi already banks the whole target,
    // so both would clamp to zero remaining and the comparison says nothing.
    const slow = L.weeklyPlan({ ...base, doneMi: 10, doneMin: 10 * 8.25 });
    const fast = L.weeklyPlan({ ...base, doneMi: 10, doneMin: 10 * 7.0 });
    assert.ok(fast.revisedMi < slow.revisedMi,
      `fast ${fast.revisedMi} should be under slow ${slow.revisedMi}`);
    assert.ok(fast.movedBy < 0, 'target moved down');
  });

  test('running SLOWER than expected raises it', () => {
    const p = L.weeklyPlan({ ...base, doneMi: 10, doneMin: 10 * 9.5 });
    assert.ok(p.movedBy > 0, 'target moved up');
  });

  test('a week run exactly at the expected pace does not move', () => {
    const p = L.weeklyPlan({ ...base, doneMi: 8, doneMin: 8 * 8.25 });
    assert.ok(Math.abs(p.revisedMi - p.baselineMi) < 0.2);
  });

  test('completing the load leaves nothing to run', () => {
    const p = L.weeklyPlan({ ...base, doneMi: 200, doneMin: 200 * 8.25 });
    assert.equal(p.remainMi, 0);
    assert.equal(p.pctComplete, 1);
  });

  test('k=3 makes the target move much more for the same session', () => {
    const k1 = L.weeklyPlan({ ...base, doneMi: 10, doneMin: 10 * 7.0, k: 1 });
    const k3 = L.weeklyPlan({ ...base, doneMi: 10, doneMin: 10 * 7.0, k: 3 });
    assert.ok(Math.abs(k3.movedBy) > Math.abs(k1.movedBy),
      'the dial does what it says');
  });

  test('reports the pace it is pricing against', () => {
    const p = L.weeklyPlan({ ...base, doneMi: 10, doneMin: 70 });
    assert.equal(p.actualPace, 7);
    assert.equal(p.expectedPace, 8.25);
  });

  test('returns null without fitness data rather than inventing a target', () => {
    assert.equal(L.weeklyPlan({ ...base, ctl: null }), null);
  });
});

describe('observed pace from recent weeks', () => {
  test('averages complete weeks and ignores the current one', () => {
    const p = L.observedWeeklyPace([
      { miles: 40, minutes: 340 }, { miles: 30, minutes: 255 },
      { miles: 5, minutes: 30, current: true },
    ]);
    assert.equal(Math.round(p * 100) / 100, 8.5);
  });

  test('null when there is nothing to go on', () => {
    assert.equal(L.observedWeeklyPace([]), null);
    assert.equal(L.observedWeeklyPace([{ miles: 0, minutes: 0 }]), null);
  });
});
