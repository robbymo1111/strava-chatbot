'use strict';

/**
 * Tool-loop timing check — NOT part of the unit suite (makes a real API call).
 *
 * Run: node tests/turn-timing.js
 *
 * Answers the question that gates Phase 3: does adding a check_rules tool loop
 * risk the 60s Vercel function timeout the way the remote MCP tools did?
 */

const fs   = require('fs');
const path = require('path');

// Load ANTHROPIC_API_KEY from .env.local without printing it
const envPath = path.join(__dirname, '..', '.env.local');
for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!process.env.ANTHROPIC_API_KEY) { console.error('No ANTHROPIC_API_KEY'); process.exit(1); }

const { buildKnowledgeBase } = require('../api/_coach-kb.js');
const M = require('../api/_coach-metrics.js');
const { _internals } = require('../api/chat.js');

// Realistic block state + training history
const blockState = require('../api/_coach-kb.js').DEFAULT_BLOCK_STATE;
const activities = [
  { type: 'Run', id: 1, start_date_local: '2026-07-20', distance: 45 * 1609.34, moving_time: 21600 },
  { type: 'Run', id: 2, start_date_local: '2026-07-27', distance: 48 * 1609.34, moving_time: 23000 },
  { type: 'Run', id: 3, start_date_local: '2026-08-03', distance: 48 * 1609.34, moving_time: 23000 },
  { type: 'Run', id: 4, start_date_local: '2026-08-04', distance: 10 * 1609.34, moving_time: 4200, workout_type: 3, name: '3x12min sub-T' },
  { type: 'Run', id: 5, start_date_local: '2026-08-10', distance: 40 * 1609.34, moving_time: 19200 },
  { type: 'Run', id: 6, start_date_local: '2026-08-16', distance: 14.5 * 1609.34, moving_time: 7500 },
];

const rolling = _internals.buildRuleContext(activities, blockState, 36);
console.log('resolved today:', rolling.today, '| days to race:', rolling.daysToRace);
const systemPrompt =
  buildKnowledgeBase(null) +
  '\n\n' + M.buildContextBlock(rolling, { loadLine: 'load: CTL 45 · ATL 52 · TSB -7 (intervals.icu)' }) +
  `\n## THE check_rules TOOL — MANDATORY BEFORE ANY PRESCRIPTION
Call check_rules with the session you intend to prescribe BEFORE stating it. Never prescribe without calling it.
If a HARD violation returns, do not prescribe that session — state the violation with its numbers and offer the compliant alternative.
Converge in ONE correction. Every result carries maxCompliantDistanceMi — the largest distance clearing EVERY rule, already solved across all of them, with bindingRule and bindingReason naming what sets it. If a distance fails, go straight to that number. Never test intermediate distances.

## PRESCRIPTION OUTPUT SHAPE
Every prescription gives all six: intent · session · paces · HR ceiling · where · bail condition.`;

const CASES = [
  { label: 'legal easy run',        msg: 'What should I run today?' },
  { label: 'illegal 20mi long run', msg: 'I want to do a 20 miler tomorrow. Give me the session.' },
  { label: 'date question',         msg: 'What day is it today, and how many days until Chicago?' },
];

(async () => {
  console.log(`system prompt: ~${Math.round(systemPrompt.length / 3.7)} tokens\n`);

  for (const c of CASES) {
    const t0 = Date.now();
    const reply = await _internals.runCoachTurn({
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      systemPrompt,
      messages: [{ role: 'user', content: c.msg }],
      ruleContext: rolling,
    });
    const ms = Date.now() - t0;

    console.log('─'.repeat(70));
    console.log(`CASE: ${c.label}  —  TOTAL ${ms}ms  (budget 60000ms)`);
    console.log('─'.repeat(70));
    console.log(reply ? reply.replace(/<session-note>[\s\S]*/, '').trim() : '(empty)');
    console.log();
  }
})();
