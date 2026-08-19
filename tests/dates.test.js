'use strict';

/**
 * Date correctness tests.
 *
 * Vercel runs in UTC; the athlete is in Brooklyn. Between 20:00 and 23:59 ET
 * the UTC calendar date is already tomorrow. Every one of these tests fails
 * against a UTC-derived "today".
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');
const M = require('../api/_coach-metrics.js');

describe('athlete-local date resolution', () => {

  test('9:30pm Brooklyn is still today, not tomorrow', () => {
    const at = new Date('2026-08-19T01:30:00Z'); // 21:30 ET on Aug 18
    assert.equal(at.toISOString().slice(0, 10), '2026-08-19', 'UTC has already rolled over');
    assert.equal(M.athleteToday('America/New_York', at), '2026-08-18', 'athlete date must not');
  });

  test('11:59pm Brooklyn is still today', () => {
    const at = new Date('2026-08-19T03:59:00Z'); // 23:59 ET on Aug 18
    assert.equal(M.athleteToday('America/New_York', at), '2026-08-18');
  });

  test('12:01am Brooklyn has rolled over', () => {
    const at = new Date('2026-08-19T04:01:00Z'); // 00:01 ET on Aug 19
    assert.equal(M.athleteToday('America/New_York', at), '2026-08-19');
  });

  test('early-morning runs resolve correctly (6am ET)', () => {
    const at = new Date('2026-08-19T10:00:00Z'); // 06:00 ET
    assert.equal(M.athleteToday('America/New_York', at), '2026-08-19');
  });

  test('handles the winter timezone offset too', () => {
    const at = new Date('2026-01-15T02:30:00Z'); // 21:30 EST on Jan 14
    assert.equal(M.athleteToday('America/New_York', at), '2026-01-14');
  });
});

describe('day counting', () => {
  test('daysUntil is signed and inclusive of direction', () => {
    assert.equal(M.daysUntil('2026-08-19', '2026-10-11'), 53);
    assert.equal(M.daysUntil('2026-10-11', '2026-08-19'), -53);
    assert.equal(M.daysUntil('2026-08-19', '2026-08-19'), 0);
  });

  test('spans a DST boundary without drifting', () => {
    // US DST ends Nov 1 2026 — a naive local-midnight diff loses/gains an hour
    assert.equal(M.daysUntil('2026-10-25', '2026-11-08'), 14);
  });

  test('weekday is stable regardless of server timezone', () => {
    assert.match(M.formatLongDate('2026-10-11'), /^Sunday, October 11, 2026$/);
    assert.match(M.formatLongDate('2026-08-19'), /^Wednesday, August 19, 2026$/);
  });
});

describe('race countdown in context', () => {
  const acts = [
    { type: 'Run', start_date_local: '2026-08-17', distance: 8 * 1609.34, moving_time: 3800 },
  ];

  test('reports days to race, not just weeks', () => {
    const c = M.computeRollingContext(acts, { today: '2026-08-19', raceDate: '2026-10-11' });
    assert.equal(c.daysToRace, 53);
    assert.equal(c.weeksToRace, 7.6);
    assert.equal(c.raceDayOfWeek, 'Sunday');
    assert.equal(c.raceDateLong, 'Sunday, October 11, 2026');
  });

  test('race week is the 7 days before, inclusive of race day', () => {
    assert.equal(M.computeRollingContext(acts, { today: '2026-10-05', raceDate: '2026-10-11' }).isRaceWeek, true);
    assert.equal(M.computeRollingContext(acts, { today: '2026-10-11', raceDate: '2026-10-11' }).isRaceWeek, true);
    assert.equal(M.computeRollingContext(acts, { today: '2026-10-03', raceDate: '2026-10-11' }).isRaceWeek, false);
  });

  test('a past race reads as negative, not as an upcoming race', () => {
    const c = M.computeRollingContext(acts, { today: '2026-10-20', raceDate: '2026-10-11' });
    assert.equal(c.daysToRace, -9);
    assert.equal(c.isRaceWeek, false);
  });

  test('context block states the full date and countdown explicitly', () => {
    const c = M.computeRollingContext(acts, { today: '2026-08-19', raceDate: '2026-10-11' });
    const b = M.buildContextBlock(c);
    assert.match(b, /TODAY: Wednesday, August 19, 2026/);
    assert.match(b, /America\/New_York/);
    assert.match(b, /GOAL RACE: Sunday, October 11, 2026 \(2026-10-11\) — in 53 days/);
    assert.match(b, /Never compute a date/);
  });

  test('race day itself reads as RACE DAY', () => {
    const c = M.computeRollingContext(acts, { today: '2026-10-11', raceDate: '2026-10-11' });
    assert.match(M.buildContextBlock(c), /RACE DAY/);
  });
});

describe('key session countdowns', () => {
  const keySessions = [
    { date: '2026-08-22', type: 'race', detail: "Grete's 10K — sets provisional MP" },
    { date: '2026-09-05', type: 'Q1',   detail: '17mi, 45min continuous MP' },
    { date: '2026-08-19', type: 'Q2',   detail: '3x12min sub-T' },
  ];

  test('sorts upcoming sessions nearest-first with day counts', () => {
    const c = M.computeRollingContext([], { today: '2026-08-19', keySessions });
    assert.equal(c.upcomingKeySessions.length, 3);
    assert.equal(c.upcomingKeySessions[0].date, '2026-08-19');
    assert.equal(c.upcomingKeySessions[0].daysAway, 0);
    assert.equal(c.upcomingKeySessions[1].daysAway, 3);
  });

  test('drops sessions already in the past', () => {
    const c = M.computeRollingContext([], { today: '2026-09-01', keySessions });
    assert.equal(c.upcomingKeySessions.length, 1);
    assert.equal(c.upcomingKeySessions[0].date, '2026-09-05');
  });

  test('renders TODAY and tomorrow in words', () => {
    const b = M.buildContextBlock(M.computeRollingContext([], { today: '2026-08-21', keySessions }));
    assert.match(b, /2026-08-22 \(Sat, tomorrow\)/);
  });

  test('week bucketing uses the athlete date — a Sunday-evening run stays in its own week', () => {
    // 21:00 ET Sunday Aug 23 = 01:00 UTC Monday Aug 24. A UTC-derived week
    // boundary would push this run into the following training week.
    const sundayNight = new Date('2026-08-24T01:00:00Z');
    const local = M.athleteToday('America/New_York', sundayNight);
    assert.equal(local, '2026-08-23');
    assert.equal(M.weekStart(local), '2026-08-17', 'belongs to the week starting Mon Aug 17');
    assert.equal(M.weekStart('2026-08-24'), '2026-08-24', 'the UTC reading would start a new week');
  });
});
