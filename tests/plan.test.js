'use strict';

/**
 * Plan state and recalibration cascade tests (build spec §4.4).
 *
 * "Recalibration cascades. If Bronx 10 sets MP to 6:34, every MP session in
 *  the stored plan updates, and the sub-T bands shift with it."
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const P = require('../api/_coach-plan.js');
const { DEFAULT_BLOCK_STATE, buildKnowledgeBase } = require('../api/_coach-kb.js');

describe('time parsing', () => {
  test('mm:ss and h:mm:ss', () => {
    assert.equal(P.parseTimeToSeconds('6:40'), 400);
    assert.equal(P.parseTimeToSeconds('63:00'), 3780);
    assert.equal(P.parseTimeToSeconds('1:04:30'), 3870);
    assert.equal(P.parseTimeToSeconds(400), 400);
  });

  test('rejects malformed input rather than guessing', () => {
    assert.equal(P.parseTimeToSeconds('abc'), null);
    assert.equal(P.parseTimeToSeconds(''), null);
    assert.equal(P.parseTimeToSeconds(null), null);
    assert.equal(P.parseTimeToSeconds('6:-3'), null);
  });

  test('pace formatting rounds without producing :60', () => {
    assert.equal(P.formatSecondsAsPace(400), '6:40');
    assert.equal(P.formatSecondsAsPace(399.6), '6:40');
    assert.equal(P.formatSecondsAsPace(419.7), '7:00');
    assert.equal(P.formatSecondsAsTime(10230), '2:50:30');
  });
});

describe('pace band cascade', () => {
  test('reproduces the knowledge base §2 table at MP 6:40', () => {
    const b = P.cascadePaceBands('6:40');
    assert.equal(b.easy.text,      '7:45–8:20');
    assert.equal(b.longRun.text,   '8:45–9:00');
    assert.equal(b.grayZone.text,  '7:00–7:45');
    assert.equal(b.mpText,         '6:40');
    assert.equal(b.subTLong.text,  '6:28–6:40');
    assert.equal(b.subTShort.text, '6:18–6:35');
    assert.equal(b.threshold.text, '6:15–6:25');
    assert.equal(b.vo2.text,       '6:05–6:10');
  });

  test('every band shifts when MP shifts', () => {
    const b = P.cascadePaceBands('6:34');
    assert.equal(b.mpText, '6:34');
    assert.equal(b.subTLong.text,  '6:22–6:34');
    assert.equal(b.threshold.text, '6:09–6:19');
    // faster MP means faster everything, including easy
    assert.ok(b.easy.loSec < P.cascadePaceBands('6:40').easy.loSec);
  });

  test('HR bands do NOT cascade — they are physiological, not pace-derived', () => {
    const a = P.cascadePaceBands('6:40');
    const b = P.cascadePaceBands('6:48');
    assert.equal(a.subTLong.hr, b.subTLong.hr);
    assert.equal(a.mp.hr, '152–160');
  });

  test('rejects implausible MP rather than emitting nonsense', () => {
    assert.equal(P.cascadePaceBands('2:00'), null);
    assert.equal(P.cascadePaceBands('20:00'), null);
    assert.equal(P.cascadePaceBands('nope'), null);
  });
});

describe('Bronx 10 recalibration table', () => {
  const table = DEFAULT_BLOCK_STATE.recalibration;

  test('sub-63:00 sets MP 6:34 / marathon 2:52', () => {
    const r = P.recalibrateFromResult('62:30', table);
    assert.equal(r.mp, '6:34');
    assert.equal(r.marathon, '2:52');
  });

  test('63:00 exactly takes the 6:34 row (inclusive upper bound)', () => {
    assert.equal(P.recalibrateFromResult('63:00', table).mp, '6:34');
  });

  test('64:00 sets MP 6:38', () => {
    assert.equal(P.recalibrateFromResult('64:00', table).mp, '6:38');
  });

  test('65:30 sets MP 6:42', () => {
    assert.equal(P.recalibrateFromResult('65:30', table).mp, '6:42');
  });

  test('anything past 66:30 falls to the catch-all 6:48', () => {
    assert.equal(P.recalibrateFromResult('67:00', table).mp, '6:48');
    assert.equal(P.recalibrateFromResult('72:00', table).mp, '6:48');
  });
});

describe('applying a recalibration to block state', () => {
  const result = { raceName: 'Bronx 10 Mile', raceDate: '2026-09-19', time: '62:45', distanceMi: 10 };

  test('cascades MP and reports every changed band', () => {
    const out = P.applyRecalibration(DEFAULT_BLOCK_STATE, result);
    assert.equal(out.blockState.mp_provisional, '6:34');
    assert.equal(out.blockState.target, '2:52 (6:34/mi)');
    assert.match(out.changes[0], /moves MP 6:40 → 6:34/);
    assert.ok(out.changes.some(c => /Sub-T long reps: 6:28–6:40 → 6:22–6:34/.test(c)));
    assert.ok(out.changes.some(c => /Threshold: 6:15–6:25 → 6:09–6:19/.test(c)));
  });

  test('records what confirmed the change', () => {
    const out = P.applyRecalibration(DEFAULT_BLOCK_STATE, result);
    assert.match(out.blockState.mp_confirmed_by, /Bronx 10 Mile 2026-09-19/);
    assert.equal(out.blockState.last_recalibration.previousMP, '6:40');
    assert.equal(out.blockState.last_recalibration.newMP, '6:34');
    assert.equal(out.blockState.last_recalibration.time, '1:02:45');
  });

  test('never mutates the input block state', () => {
    const before = JSON.stringify(DEFAULT_BLOCK_STATE);
    P.applyRecalibration(DEFAULT_BLOCK_STATE, result);
    assert.equal(JSON.stringify(DEFAULT_BLOCK_STATE), before);
  });

  test('a result confirming the current MP reports no change', () => {
    const out = P.applyRecalibration(DEFAULT_BLOCK_STATE, { ...result, time: '66:00' });
    assert.equal(out.blockState.mp_provisional, '6:42');
    // 6:42 differs from 6:40, so this one does change; confirm the no-change path
    const same = P.applyRecalibration({ ...DEFAULT_BLOCK_STATE, mp_provisional: '6:34' }, result);
    assert.match(same.changes[0], /confirms MP at 6:34\/mi — no change/);
    assert.equal(same.changes.length, 1, 'no band lines when nothing moved');
  });

  test('returns null on missing input rather than throwing', () => {
    assert.equal(P.applyRecalibration(null, result), null);
    assert.equal(P.applyRecalibration(DEFAULT_BLOCK_STATE, {}), null);
  });
});

describe('knowledge base reflects the cascade', () => {
  test('§2 zone table renders from the current MP', () => {
    const kb = buildKnowledgeBase({ ...DEFAULT_BLOCK_STATE, mp_provisional: '6:34' });
    assert.match(kb, /Marathon pace \(MP\) \| 6:34/);
    assert.match(kb, /Sub-T long reps \(10–15min\) \| 6:22–6:34/);
    assert.ok(!kb.includes('| 6:28–6:40 |'), 'stale 6:40-derived band must be gone');
  });

  test('table and block state never disagree after a recalibration', () => {
    const out = P.applyRecalibration(DEFAULT_BLOCK_STATE, {
      raceName: 'Bronx 10 Mile', raceDate: '2026-09-19', time: '62:45',
    });
    const kb = buildKnowledgeBase(out.blockState);
    assert.match(kb, /Marathon pace \(MP\) \| 6:34/);            // §2
    assert.match(kb, /mp_provisional: "6:34"/);                   // §9
  });

  test('falls back to the default table when MP is unusable', () => {
    const kb = buildKnowledgeBase({ mp_provisional: 'garbage' });
    assert.match(kb, /Marathon pace \(MP\) \| 6:40/);
  });
});
