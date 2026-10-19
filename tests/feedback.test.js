'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const F = require('../api/_coach-feedback.js');

describe('time helpers', () => {
  test('formats and parses round-trip', () => {
    assert.equal(F.fmtTime(10999), '3:03:19');
    assert.equal(F.parseTime('3:03:19'), 10999);
    assert.equal(F.fmtTime(412), '6:52');
    assert.equal(F.parseTime('6:52'), 412);
  });
  test('rejects junk rather than guessing', () => {
    assert.equal(F.parseTime('abc'), null);
    assert.equal(F.parseTime(null), null);
  });
  test('derives marathon pace', () => {
    assert.equal(F.paceOf(3 * 3600, 26.2), '6:52/mi');
  });
});

describe('marathon projection', () => {
  const chicago = { timeSec: F.parseTime('3:03:19'), name: 'Chicago Marathon 2026', date: '2026-10-11' };

  test('projects a cool-weather range off a hot race', () => {
    const p = F.projectMarathon(chicago, { adjustLoPct: 2, adjustHiPct: 4 });
    assert.equal(p.basisTime, '3:03:19');
    // 2-4% faster than 3:03:19
    assert.equal(p.range, '2:55:59–2:59:39');
    assert.equal(p.subThree, true, 'the fast end breaks three hours');
  });

  test('even a 2% conditions gain breaks three — by 21 seconds', () => {
    // 3:03:19 is 10999s. A 2% gain is 10779s = 2:59:39, under 10800.
    const p = F.projectMarathon(chicago, { adjustLoPct: 0, adjustHiPct: 2 });
    assert.equal(F.fmtTime(p.fastSec), '2:59:39');
    assert.equal(p.subThree, true);
  });

  test('a 1% gain does not', () => {
    const p = F.projectMarathon(chicago, { adjustLoPct: 0, adjustHiPct: 1 });
    assert.equal(p.subThree, false, '3:01:29 — conditions alone are not enough at 1%');
  });

  test('returns null without a basis race rather than inventing one', () => {
    assert.equal(F.projectMarathon(null, {}), null);
    assert.equal(F.projectMarathon({ name: 'x' }, {}), null);
  });
});

describe('feedback cards', () => {
  const base = {
    today: { date: '2026-10-20' },           // Tuesday
    loadBudget: { headroomMi: 44, trailing4wkAvgMiles: 42.9, bindingRule: 3, hoursSinceQuality: 696 },
    load: { ctl: 30, atl: 22, tsb: 8, acwr: 0.73 },
    grayZone: [
      { date: '2026-10-01', grayPct: 32.9, flagged: true },
      { date: '2026-10-04', grayPct: 52,   flagged: true },
      { date: '2026-10-10', grayPct: 10,   flagged: false },
    ],
    strength: { sessionsThisWeek: 0, gluteTarget: 2, calfTarget: 3, crossTraining: [] },
    keySessions: [{ date: '2026-11-03', daysAway: 14, type: 'Q2', detail: '10x3min sub-T' }],
  };

  function card(d, key) { return F.buildFeedback(d).find(c => c.key === key); }

  const wp = {
    doneMi: 10, remainMi: 14, baselineMi: 20, movedBy: -6,
    actualPace: 7.0, expectedPace: 8.25, phaseWhy: 'recovering from a marathon 8 days ago',
  };

  test('leads with miles remaining, in plain words', () => {
    const c = card({ ...base, weekPlan: wp }, 'week');
    assert.match(c.body, /About 14 more miles this week/);
    assert.match(c.body, /on top of the 10 you have run/);
    assert.ok(!/headroom|ramp ceiling|TSS/i.test(c.body), 'no jargon');
  });

  test('explains WHY the target moved — the whole point of a load target', () => {
    const c = card({ ...base, weekPlan: wp }, 'week');
    assert.match(c.body, /came down from 20 miles/);
    assert.match(c.body, /running faster than expected \(7:00\/mi against 8:15\/mi\)/);
    assert.match(c.body, /banked the same work in fewer miles/);
  });

  test('a slower week raises the target and says so', () => {
    const slow = { ...wp, remainMi: 26, movedBy: 6, actualPace: 9.5 };
    const c = card({ ...base, weekPlan: slow }, 'week');
    assert.match(c.body, /went up from 20 miles/);
    assert.match(c.body, /easier miles bank less/);
  });

  test('names the phase the week is sized for', () => {
    assert.match(card({ ...base, weekPlan: wp }, 'week').body,
                 /sized for recovering from a marathon 8 days ago/);
  });

  test('a banked week says so rather than demanding more', () => {
    const done = { ...wp, remainMi: 0, doneMi: 32, movedBy: 0 };
    const c = card({ ...base, weekPlan: done }, 'week');
    assert.match(c.body, /banked this week's training load/);
  });

  test('THE RULES OUTRANK THE LOAD TARGET', () => {
    // Load maths asks for 14 more; the ramp rule allows 5. The rule wins.
    const c = card({ ...base, weekPlan: wp,
                     loadBudget: { ...base.loadBudget, headroomMi: 5, bindingRule: 3 } }, 'week');
    assert.match(c.body, /rules cap you at 5 more miles/);
    assert.match(c.body, /take the lower number/);
    assert.equal(c.tone, 'warn');
  });

  test('the calf rule is named when it is what caps the week', () => {
    const c = card({ ...base, weekPlan: wp,
                     loadBudget: { ...base.loadBudget, headroomMi: 5, bindingRule: 'calf' } }, 'week');
    assert.match(c.body, /calf combination that has broken every build/);
  });

  test('without a fitness number it says so instead of inventing a target', () => {
    const c = card(base, 'week');
    assert.match(c.body, /no load target to size the week against/);
    assert.match(c.body, /ceiling, not a goal/);
  });

  test('long gap since quality reads as going flat', () => {
    const c = card(base, 'quality');
    assert.equal(c.tone, 'warn');
    assert.match(c.body, /29 days/);
  });

  test('inside 72 hours it says today should be easy', () => {
    const c = card({ ...base, loadBudget: { ...base.loadBudget, hoursSinceQuality: 40 } }, 'quality');
    assert.equal(c.tone, 'bad');
    assert.match(c.body, /today should be easy/);
  });

  test('translates CTL and TSB into words, not acronyms', () => {
    const c = card(base, 'fitness');
    assert.match(c.body, /fitness is at 30/);
    assert.match(c.body, /fresh/);
    assert.ok(!/CTL|TSB|ACWR/.test(c.body), 'no acronyms in the body');
  });

  test('flags a high acute-to-chronic ratio as injury risk', () => {
    const c = card({ ...base, load: { ctl: 40, atl: 60, tsb: -20, acwr: 1.5 } }, 'fitness');
    assert.match(c.body, /50% above your baseline/);
    assert.equal(c.tone, 'warn');
  });

  test('gray zone names the count, the worst day, and the cost', () => {
    const c = card(base, 'grayzone');
    assert.match(c.body, /2 of your last 3/);
    assert.match(c.body, /2026-10-04 at 52%/);
    assert.match(c.body, /without building any themselves/);
  });

  test('a clean easy-run record is praised, not nagged', () => {
    const clean = { ...base, grayZone: [{ date: '2026-10-10', grayPct: 4, flagged: false }] };
    const c = card(clean, 'grayzone');
    assert.equal(c.tone, 'good');
    assert.match(c.body, /stayed genuinely easy/);
  });

  test('strength gap ties back to the Chicago failure', () => {
    const c = card(base, 'strength');
    assert.equal(c.tone, 'warn');
    assert.match(c.body, /gave out at Chicago/);
    assert.match(c.body, /did not log is invisible/, 'is honest about what it cannot see');
  });

  test('omits cards whose data is missing rather than inventing them', () => {
    const cards = F.buildFeedback({ today: { date: '2026-10-20' } });
    assert.equal(cards.length, 0);
  });

  test('every card has a title, body and valid tone', () => {
    for (const c of F.buildFeedback(base)) {
      assert.ok(c.title && c.body, 'populated');
      assert.ok(['good', 'neutral', 'warn', 'bad'].includes(c.tone), c.key + ' tone: ' + c.tone);
    }
  });
});
