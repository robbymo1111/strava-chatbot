'use strict';

/**
 * Smoke tests for the shared data layer.
 *
 * These exist because of a real bug: extracting these readers out of chat.js
 * left `_cachedAthleteId` undeclared. Under 'use strict' the bare reference
 * threw a ReferenceError, a surrounding try/catch swallowed it, and every KV
 * read keyed on athlete id silently returned null — so the app served the
 * DEFAULT block state while looking completely healthy.
 *
 * The guard is behavioural, not static: each reader is actually invoked
 * against a stubbed fetch and must not throw a ReferenceError. Regex-parsing
 * the source for undeclared identifiers was tried first and was worse than
 * useless — the string-stripping pass silently ate a third of the file.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const D = require('../api/_data.js');

const READERS = [
  'getAthleteIdOnce', 'getBlockStateFromKV', 'getOuraDataFromKV',
  'getWeatherForChat', 'getThresholdDriftFromKV', 'getConversationContext',
  'getTrainingSummaryFromKV', 'getHistoryAnalysisFromKV',
];

let realFetch, realEnv;

beforeEach(() => {
  realFetch = global.fetch;
  realEnv = { url: process.env.KV_REST_API_URL, tok: process.env.KV_REST_API_TOKEN };
  process.env.KV_REST_API_URL   = 'https://kv.invalid';
  process.env.KV_REST_API_TOKEN = 'stub';
  // Every call resolves to a plausible-but-empty payload
  global.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 12922571, result: null }),
  });
});

afterEach(() => {
  global.fetch = realFetch;
  process.env.KV_REST_API_URL   = realEnv.url;
  process.env.KV_REST_API_TOKEN = realEnv.tok;
});

describe('_data.js', () => {
  test('exports every reader the MCP server depends on', () => {
    for (const fn of [...READERS, 'getSubTMinutesThisWeek', 'fetchIntervalsWellnessForChat', 'kvGet']) {
      assert.equal(typeof D[fn], 'function', `${fn} must be exported`);
    }
  });

  test('no reader throws a ReferenceError when invoked', async () => {
    // This is the exact failure mode of the extraction bug: an identifier left
    // behind in the source file it came from.
    for (const name of READERS) {
      await assert.doesNotReject(
        () => Promise.resolve(D[name]('stub-access-token')),
        (err) => {
          if (err instanceof ReferenceError) {
            return new Error(`${name} threw ReferenceError: ${err.message} — a module-level declaration is missing`);
          }
          return false; // other rejections are fine here; we only police ReferenceError
        },
        `${name} must not throw ReferenceError`
      );
    }
  });

  test('getAthleteIdOnce resolves an id and caches it', async () => {
    const first = await D.getAthleteIdOnce('stub-access-token');
    assert.equal(first, '12922571');

    // Second call must not re-fetch
    let calls = 0;
    global.fetch = async () => { calls++; return { ok: true, json: async () => ({ id: 999 }) }; };
    const second = await D.getAthleteIdOnce('stub-access-token');
    assert.equal(second, '12922571', 'cached value is reused');
    assert.equal(calls, 0, 'no second /athlete request');
  });

  test('readers degrade to null on a failed fetch rather than throwing', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    for (const name of ['getBlockStateFromKV', 'getOuraDataFromKV', 'getWeatherForChat']) {
      const v = await D[name]('stub-access-token');
      assert.equal(v, null, `${name} should return null, not throw`);
    }
  });

  test('getSubTMinutesThisWeek returns a real zero when there are no quality sessions', async () => {
    const v = await D.getSubTMinutesThisWeek('stub-access-token', [
      { type: 'Run', id: 1, start_date_local: new Date().toISOString(), distance: 8000, moving_time: 2400 },
    ]);
    assert.equal(v, 0, 'no quality sessions is a genuine 0, not unknown');
  });
});
