'use strict';

/**
 * MCP SERVER — the inversion.
 *
 * Claude chat already has the Strava MCP connector, which gives it activities,
 * streams, laps and zones. This server exposes everything Strava cannot
 * compute: the 14 hard rules, absolute-band gray zone, real CTL/ATL/TSB from
 * Intervals.icu, Oura recovery, the Fellrnr runner heat model, block state,
 * and the weekly load budget.
 *
 * Transport: Streamable HTTP, JSON-RPC 2.0 over POST.
 * Connect from claude.ai → Settings → Connectors → Add custom connector:
 *   https://<deployment>/api/mcp
 *
 * AUTH: a single shared bearer token (MCP_AUTH_TOKEN). This is a personal,
 * single-athlete server, so a bearer secret is proportionate — but it IS a
 * shared secret, not OAuth: anyone holding it can read this training data.
 * Rotate it by changing the env var. Without MCP_AUTH_TOKEN set the server
 * refuses every request rather than defaulting to open.
 */

const { kvGet: libKvGet, kvSet, getAthleteId } = require('./_lib');
const { checkRules, formatRuleResults } = require('./_rules');
const { cascadePaceBands, applyRecalibration } = require('./_coach-plan');
const { DEFAULT_BLOCK_STATE } = require('./_coach-kb');
const {
  computeRollingContext, buildContextBlock, classifyHRSeconds, computeGrayZone,
  analyzeReps, inferSessionType, elapsedMinusMoving, athleteToday, weekStart,
} = require('./_coach-metrics');
const D = require('./_data');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'robby-training-intelligence', version: '1.0.0' };

/* ══════════════════════════════════════════════════════════════════════════════
   TOOL DEFINITIONS
   ══════════════════════════════════════════════════════════════════════════════ */

const TOOLS = [
  {
    name: 'get_training_context',
    description:
      'Current training state as pre-computed facts: today\'s date in the athlete\'s timezone, ' +
      'days to goal race, block week, trailing 4-week average, ramp ceiling, hours since last ' +
      'quality effort, long runs in the last 14 days, sub-T minutes, and active rule flags. ' +
      'Call this before any prescriptive answer. All arithmetic is already done — read it, do not recompute it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'check_session',
    description:
      'Validate a proposed session against all 14 hard rules before prescribing it. Returns per-rule ' +
      '{passes, actual, limit, margin, detail}, plus maxCompliantDistanceMi — the largest distance ' +
      'clearing EVERY rule, already solved across all of them. If a distance fails, go straight to ' +
      'that number. Hard violations must not be prescribed; soft violations must be named with their ' +
      'numbers, never quietly adjusted away.',
    inputSchema: {
      type: 'object',
      properties: {
        type:           { type: 'string', enum: ['easy', 'long', 'quality', 'race', 'cross'] },
        distanceMi:     { type: 'number' },
        durationMin:    { type: 'number' },
        subTMinutes:    { type: 'number', description: 'Work-interval minutes only, excluding warmup/cooldown/recoveries.' },
        raceDistanceMi: { type: 'number' },
        shoe:           { type: 'string', description: 'AF3, ZF6, or AP4.' },
        date:           { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
      },
      required: ['type'],
    },
  },
  {
    name: 'get_readiness',
    description:
      'Today\'s go/no-go read: Oura readiness, HRV vs baseline, resting HR delta, sleep, plus ' +
      'CTL/ATL/TSB and ACWR. Returns a signal count against the 5 recovery criteria and the ' +
      'resulting verdict (0-1 proceed / 2 easier version / 3+ easy or rest).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'analyze_run',
    description:
      'Grade a specific activity on the athlete\'s ABSOLUTE heart-rate bands (easy <136, gray 136-152, ' +
      'MP 152-160, sub-T 155-162, threshold 163-170). Strava\'s own zones are maxHR-relative and this ' +
      'athlete\'s max HR is unresolved (169 observed vs 181 assumed), so those zones are unreliable here. ' +
      'Returns gray-zone percentage, band distribution, rep-by-rep HR with drift, recovery clearance, ' +
      'and elapsed-vs-moving time.',
    inputSchema: {
      type: 'object',
      properties: {
        activityId: { type: 'string', description: 'Strava activity id.' },
      },
      required: ['activityId'],
    },
  },
  {
    name: 'get_heat_adjustment',
    description:
      'Runner-specific heat stress from the Fellrnr thermal model. Standard heat indexes assume a ' +
      'walker at 3mph/180W; a runner at 8:00/mi produces ~737W, so the standard "feels like" badly ' +
      'understates it. Returns perceived temperature at easy and tempo pace, percentage of maximum ' +
      'evaporative cooling in use, per-zone pace adjustments, and a terminal time when conditions ' +
      'exceed cooling capacity.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_load_budget',
    description:
      'This week\'s training load budget: the ceiling set by the binding rule, miles spent, miles ' +
      'remaining, sub-T minutes against the 20-25% weekly target, and a warning when the remaining ' +
      'shape would trip the calf conjunction (55-63mi week combined with a 19-21mi long run). ' +
      'Prescribes load, not sessions — how it is spent is the athlete\'s call.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_block_state',
    description:
      'The current training block: goal race and date, target time, marathon pace, every pace band ' +
      'cascaded from it, scheduled key sessions, and open questions.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'recalibrate_from_race',
    description:
      'Apply a tune-up race result to the plan. Looks the time up in the block\'s recalibration table, ' +
      'sets the new marathon pace, and cascades every dependent band (sub-T, threshold, VO2, easy, long ' +
      'run). Use dryRun to preview the change before committing it — prefer previewing and confirming ' +
      'over silently rewriting the plan.',
    inputSchema: {
      type: 'object',
      properties: {
        time:     { type: 'string', description: 'Finish time, e.g. "63:00" or "1:03:00".' },
        raceName: { type: 'string' },
        raceDate: { type: 'string', description: 'YYYY-MM-DD' },
        dryRun:   { type: 'boolean', description: 'Preview without saving. Default true.' },
      },
      required: ['time'],
    },
  },
];

/* ══════════════════════════════════════════════════════════════════════════════
   HTTP / JSON-RPC
   ══════════════════════════════════════════════════════════════════════════════ */

module.exports = async (req, res) => {
  // CORS for the connector handshake
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, MCP-Protocol-Version');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    console.error('[mcp] MCP_AUTH_TOKEN not configured — refusing all requests');
    return res.status(500).json(rpcError(null, -32603, 'Server auth not configured'));
  }
  const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!timingSafeEqual(presented, expected)) {
    return res.status(401).json(rpcError(null, -32001, 'Unauthorized'));
  }

  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, server: SERVER_INFO, tools: TOOLS.length });
  }
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const body = req.body || {};
  const batch = Array.isArray(body) ? body : [body];
  const responses = [];

  for (const msg of batch) {
    const r = await handleRpc(msg);
    if (r) responses.push(r);
  }

  // Notifications only — nothing to return
  if (!responses.length) return res.status(202).end();
  return res.status(200).json(Array.isArray(body) ? responses : responses[0]);
};

async function handleRpc(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  try {
    switch (method) {
      case 'initialize': {
        const asked = params?.protocolVersion;
        const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        return rpcResult(id, {
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions:
            'Training intelligence for Robby Morris that the Strava connector cannot compute. ' +
            'Call get_training_context before any prescriptive answer and check_session before ' +
            'finalizing any prescription. Numbers returned by these tools are authoritative — ' +
            'explain them, never recompute them.',
        });
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null;

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: TOOLS });

      case 'tools/call': {
        const name = params?.name;
        const args = params?.arguments || {};
        const tool = TOOLS.find(t => t.name === name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);

        const t0 = Date.now();
        const text = await callTool(name, args);
        console.log(`[mcp] ${name} — ${Date.now() - t0}ms`);
        return rpcResult(id, { content: [{ type: 'text', text }], isError: false });
      }

      case 'resources/list':  return rpcResult(id, { resources: [] });
      case 'prompts/list':    return rpcResult(id, { prompts: [] });

      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  } catch (e) {
    console.error('[mcp] handler error:', method, e.message);
    if (isNotification) return null;
    return rpcError(id, -32603, `Internal error: ${e.message}`);
  }
}

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message) { return { jsonrpc: '2.0', id, error: { code, message } }; }

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ══════════════════════════════════════════════════════════════════════════════
   STRAVA ACCESS — tokens come from KV, refreshed on demand
   ══════════════════════════════════════════════════════════════════════════════ */

const ATHLETE_ID = process.env.STRAVA_ATHLETE_ID || '12922571';

async function getAccessToken() {
  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  const tokens = await libKvGet(kvUrl, kvToken, `athlete:${ATHLETE_ID}:tokens`);
  if (!tokens?.accessToken) throw new Error('No stored Strava tokens — sign in to the app once to seed them.');

  const now = Math.floor(Date.now() / 1000);
  if (tokens.expiresAt > now + 120) return tokens.accessToken;

  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     process.env.STRAVA_CLIENT_ID,
      client_secret: process.env.STRAVA_CLIENT_SECRET,
      refresh_token: tokens.refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!r.ok) throw new Error('Strava token refresh failed');
  const d = await r.json();
  await kvSet(kvUrl, kvToken, `athlete:${ATHLETE_ID}:tokens`, {
    accessToken: d.access_token, refreshToken: d.refresh_token, expiresAt: d.expires_at,
  });
  return d.access_token;
}

async function fetchActivities(accessToken, perPage = 60) {
  const r = await fetch(
    `https://www.strava.com/api/v3/athlete/activities?per_page=${perPage}&page=1`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (!r.ok) throw new Error(`Strava activities fetch failed: ${r.status}`);
  const acts = await r.json();
  acts.sort((a, b) =>
    new Date(b.start_date_local || b.start_date) - new Date(a.start_date_local || a.start_date));
  return acts;
}

/** Everything the rule/context tools need, assembled once. */
async function loadState() {
  const accessToken = await getAccessToken();
  const [activities, blockState, subT, intervals] = await Promise.all([
    fetchActivities(accessToken),
    D.getBlockStateFromKV(accessToken),
    Promise.resolve(null),
    D.fetchIntervalsWellnessForChat(),
  ]);
  const bs = blockState || DEFAULT_BLOCK_STATE;
  const subTMin = await D.getSubTMinutesThisWeek(accessToken, activities).catch(() => null);

  const rolling = computeRollingContext(activities, {
    raceDate:            bs.race_date,
    blockStartDate:      bs.block_start_date,
    longRunCapMi:        bs.long_run_cap || 18,
    keySessions:         bs.key_sessions,
    timezone:            bs.timezone,
    subTMinutesThisWeek: subTMin,
  });
  // Athlete rule overrides travel with the context so every rule check sees
  // them. An override downgrades a rule to advisory and records why — it does
  // not remove the check.
  rolling.ruleOverrides = bs.rule_overrides || {};
  rolling.longRunCapMi  = bs.long_run_cap || 18;

  return { accessToken, activities, blockState: bs, rolling, intervals };
}

/* ══════════════════════════════════════════════════════════════════════════════
   TOOL IMPLEMENTATIONS
   ══════════════════════════════════════════════════════════════════════════════ */

async function callTool(name, args) {
  switch (name) {
    case 'get_training_context':  return toolTrainingContext();
    case 'check_session':         return toolCheckSession(args);
    case 'get_readiness':         return toolReadiness();
    case 'analyze_run':           return toolAnalyzeRun(args);
    case 'get_heat_adjustment':   return toolHeat();
    case 'get_load_budget':       return toolLoadBudget();
    case 'get_block_state':       return toolBlockState();
    case 'recalibrate_from_race': return toolRecalibrate(args);
    default: return `Unknown tool: ${name}`;
  }
}

async function toolTrainingContext() {
  const { rolling, intervals } = await loadState();
  const loadLine = intervals?.available
    ? `load: CTL ${intervals.ctl} · ATL ${intervals.atl} · TSB ${intervals.tsb} (intervals.icu, ${intervals.dataDate})`
    : null;
  return buildContextBlock(rolling, { loadLine });
}

async function toolCheckSession(args) {
  const { rolling } = await loadState();
  const proposed = { ...args, date: args.date || rolling.today };
  const check = checkRules(proposed, rolling);

  const lines = [
    `Proposed: ${proposed.type}${proposed.distanceMi ? ` ${proposed.distanceMi}mi` : ''} on ${proposed.date}`,
    `PASSES: ${check.passes}`,
    '',
    formatRuleResults(check),
  ];
  if (check.maxCompliantDistanceMi != null) {
    lines.push('');
    lines.push(`maxCompliantDistanceMi: ${check.maxCompliantDistanceMi}`);
    lines.push(`bindingRule: ${check.bindingRule} — ${check.bindingReason}`);
  }
  if (check.hardViolations.length) {
    lines.push('');
    lines.push('HARD violations must not be prescribed. State the numbers and offer the compliant alternative.');
  }
  if (check.overridden?.length) {
    lines.push('');
    lines.push(`${check.overridden.length} rule(s) waived by the athlete — shown above. They are not blocking, but they still apply as risk.`);
  }
  return lines.join('\n');
}

async function toolReadiness() {
  const { accessToken, rolling, intervals } = await loadState();
  const oura = await D.getOuraDataFromKV(accessToken);

  const L = [`READINESS — ${rolling.todayLong}`, ''];

  if (!oura?.available) {
    L.push('Oura: no data cached for today.');
  } else {
    const s7 = oura.sleep7d || [], h7 = oura.hrv7d || [];
    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    const hrvVals = s7.map(d => d.avgHrv).filter(v => v != null);
    const hrvBase = avg(hrvVals);
    const hrvToday = s7.length ? s7[s7.length - 1]?.avgHrv : null;
    const hrvPct = (hrvBase && hrvToday != null)
      ? Math.round((hrvToday - hrvBase) / hrvBase * 1000) / 10 : null;

    const rhrVals = s7.map(d => d.restingHr).filter(v => v != null);
    const rhrBase = avg(rhrVals);
    const rhrToday = s7.length ? s7[s7.length - 1]?.restingHr : null;
    const rhrDelta = (rhrBase && rhrToday != null) ? Math.round((rhrToday - rhrBase) * 10) / 10 : null;

    let consecutivePoor = 0;
    const r7 = oura.readiness7d || [];
    for (let i = r7.length - 1; i >= 0; i--) {
      if ((r7[i].score ?? 100) < 55) consecutivePoor++; else break;
    }

    const tsb = intervals?.available ? intervals.tsb : null;
    const readiness = oura.todayReadiness;

    const signals = [
      ['HRV >15% below 7-day baseline', hrvPct != null && hrvPct < -15, `${hrvPct ?? '?'}%`],
      ['Readiness <55',                 readiness != null && readiness < 55, `${readiness ?? '?'}`],
      ['Resting HR >7bpm above baseline', rhrDelta != null && rhrDelta > 7, `${rhrDelta ?? '?'}bpm`],
      ['3+ consecutive poor nights',    consecutivePoor >= 3, `${consecutivePoor}`],
      ['TSB <-25 AND readiness <60',    tsb != null && tsb < -25 && readiness != null && readiness < 60, `TSB ${tsb ?? '?'}`],
    ];
    const count = signals.filter(s => s[1]).length;

    L.push(`Oura readiness: ${readiness ?? '?'}/100 · HRV ${hrvPct != null ? (hrvPct >= 0 ? '+' : '') + hrvPct + '%' : '?'} vs 7d baseline · RHR ${rhrDelta != null ? (rhrDelta >= 0 ? '+' : '') + rhrDelta : '?'}bpm`);
    L.push('');
    L.push('Recovery signals:');
    for (const [label, fired, val] of signals) L.push(`  ${fired ? '⚠️ ' : '   '}${label} — ${val}`);
    L.push('');
    L.push(`Signal count: ${count} → ${count <= 1 ? 'proceed as planned' : count === 2 ? 'easier version' : 'easy effort or rest'}`);
  }

  if (intervals?.available) {
    const acwr = intervals.ctl > 0 ? (intervals.atl / intervals.ctl).toFixed(2) : '?';
    L.push('');
    L.push(`Load: CTL ${intervals.ctl} · ATL ${intervals.atl} · TSB ${intervals.tsb} · ACWR ${acwr}` +
           (intervals.rampRate != null ? ` · ramp ${intervals.rampRate > 0 ? '+' : ''}${intervals.rampRate}/wk` : ''));
  }
  return L.join('\n');
}

async function toolAnalyzeRun(args) {
  const accessToken = await getAccessToken();
  const id = String(args.activityId).trim();

  const [actRes, lapsRes, streamRes] = await Promise.all([
    fetch(`https://www.strava.com/api/v3/activities/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } }),
    fetch(`https://www.strava.com/api/v3/activities/${id}/laps`, { headers: { Authorization: `Bearer ${accessToken}` } }),
    fetch(`https://www.strava.com/api/v3/activities/${id}/streams?keys=heartrate,time,velocity_smooth&key_by_type=true`,
          { headers: { Authorization: `Bearer ${accessToken}` } }),
  ]);
  if (!actRes.ok) return `Could not fetch activity ${id} (${actRes.status}).`;

  const activity = await actRes.json();
  const laps     = lapsRes.ok ? await lapsRes.json() : [];
  const streams  = streamRes.ok ? await streamRes.json() : {};
  const hr       = streams.heartrate?.data || [];

  const sessionType = inferSessionType(activity);
  const L = [
    `${activity.name || 'Activity'} — ${(activity.start_date_local || '').slice(0, 10)}`,
    `${(activity.distance / 1609.34).toFixed(2)}mi · ${Math.round(activity.moving_time / 60)}min · inferred type: ${sessionType}`,
    '',
  ];

  const stopped = elapsedMinusMoving(activity);
  if (stopped?.significant) {
    L.push(`Elapsed ${stopped.elapsedStr} vs moving ${stopped.movingStr} — ${stopped.stoppedStr} stopped.`);
    L.push('');
  }

  if (!hr.length) {
    L.push('No heart-rate stream — band analysis unavailable.');
  } else {
    const gz = computeGrayZone(hr, sessionType);
    const z  = classifyHRSeconds(hr);
    L.push(`GRAY ZONE: ${gz.grayPct}% at HR 136–152 · ${gz.easyPct}% under 136 · flagged=${gz.flagged}`);
    L.push(`  ${gz.detail}`);
    L.push('');
    L.push(`Absolute bands: easy ${z.pcts.easy}% · gray ${z.pcts.gray}% · MP ${z.pcts.mp}% · sub-T ${z.pcts.subt}% · threshold ${z.pcts.threshold}% · VO2 ${z.pcts.vo2}%`);
    L.push(`avg HR ${z.avgHR} · peak ${z.peakHR}`);
  }

  if (Array.isArray(laps) && laps.length >= 2) {
    const { classifyLaps } = require('./_lib');
    const classified = classifyLaps(laps, 6.5);
    const work = classified.filter(l => l.classification === 'Interval' || l.classification === 'Hard');
    if (work.length >= 2) {
      const reps = work.map(l => ({ avgHR: l.hr, maxHR: l.maxHR, paceMinMi: l.paceMPM }));
      const recov = classified.filter(l => l.classification === 'Easy' || l.classification === 'Moderate')
                              .map(l => ({ minHR: l.hr }));
      const ra = analyzeReps(reps, recov);
      L.push('');
      L.push(`REPS: ${ra.repCount} · HRs ${ra.repHRs.join('/')} · drift ${ra.driftBpm > 0 ? '+' : ''}${ra.driftBpm}bpm · in band ${ra.inBandCount}/${ra.repHRs.length}`);
      if (ra.recoveryClearance) {
        L.push(`Recoveries clearing <140: ${ra.recoveryClearance.cleared}/${ra.recoveryClearance.total} (${ra.recoveryClearance.minHRs.join('/')})`);
      }
      L.push(ra.verdict);
      L.push('');
      work.forEach((l, i) => L.push(`  Rep ${i + 1}: ${l.distMi}mi @ ${l.pace || '?'}/mi${l.hr ? ` · HR ${l.hr}` : ''}`));
    }
  }
  return L.join('\n');
}

async function toolHeat() {
  const accessToken = await getAccessToken();
  const w = await D.getWeatherForChat(accessToken);
  if (!w?.available) {
    return 'No cached weather. Open the app once to refresh it, or conditions are stale (>60min).';
  }
  const hm = w.heatModel || {};
  const ez = hm.easyPace, tp = hm.tempoPace;
  const L = [
    `Ambient ${w.temp}°F · dewpoint ${w.dewpoint}°F · wind ${w.wind ?? '?'}mph · ${w.condition || '?'}`,
    '',
  ];
  if (ez) {
    L.push(`Runner perceived temp @ easy pace:  ~${ez.perceivedF}°F (${ez.sweatPctOfMax}% of max evaporative cooling)`);
    if (tp) L.push(`Runner perceived temp @ tempo pace: ~${tp.perceivedF}°F (${tp.sweatPctOfMax}% of max)`);
    L.push(`[Standard walker-calibrated "feels like" would read ${w.feelsLike ?? w.temp}°F — it understates runner heat stress]`);
    L.push('');
    L.push(`Pace adjustment: easy ${ez.isHROnly ? 'HR-only, pace invalid' : `+${ez.paceAdjSec}s/mi`}` +
           (tp ? ` · tempo ${tp.isHROnly ? 'HR-only, pace invalid' : `+${tp.paceAdjSec}s/mi`}` : ''));
    if (ez.isDangerous && ez.terminalMinutes) {
      L.push(`⚠️ At easy pace, core temp reaches dangerous levels in ~${ez.terminalMinutes}min.`);
    } else if (tp?.terminalMinutes && tp.terminalMinutes < 60) {
      L.push(`⚠️ Tempo pace unsustainable — heat accumulates to dangerous levels in ~${tp.terminalMinutes}min.`);
    }
  }
  L.push('');
  L.push(`Category: ${(w.coaching?.category || '?').toUpperCase()}`);
  if (w.coaching?.recommendation)  L.push(w.coaching.recommendation);
  if (w.coaching?.bestWindowToday) L.push(`Best window today: ${w.coaching.bestWindowToday}`);
  return L.join('\n');
}

async function toolLoadBudget() {
  const { rolling } = await loadState();

  // The binding ceiling for ADDING miles this week, solved across the rules
  const probe = checkRules({ type: 'easy', distanceMi: 0, date: rolling.today }, rolling);
  const ceiling   = probe.maxCompliantDistanceMi;
  const spent     = rolling.currentWeekMiles;
  const remaining = ceiling != null ? Math.max(Math.round((ceiling) * 10) / 10, 0) : null;

  const L = [
    `LOAD BUDGET — week of ${weekStart(rolling.today)}`,
    '',
    `Spent:      ${spent}mi · ${rolling.currentWeekMinutes}min · ${rolling.currentWeekQuality} quality session(s)`,
    `Ramp ceiling: ${rolling.rampCeilingMi}mi (110% of the ${rolling.trailing4wkAvgMiles}mi trailing 4-week average)`,
    `Remaining headroom: ${remaining != null ? remaining + 'mi' : 'unbounded'}` +
      (probe.bindingRule ? ` — set by ${probe.bindingRule === 'calf' ? 'the calf conjunction' : 'Rule ' + probe.bindingRule} (${probe.bindingReason})` : ''),
    '',
    `Sub-T: ${rolling.subTMinutesThisWeek != null
      ? `${rolling.subTMinutesThisWeek}min (${rolling.subTPctOfWeeklyTime}% of weekly time) — target 20–25%`
      : 'UNKNOWN — no lap data cached for this week\'s quality sessions'}`,
    `Hours since last quality: ${rolling.hoursSinceLastQuality ?? '?'} (72h minimum between quality efforts)`,
  ];

  // Calf conjunction early warning
  const projectedLong = rolling.maxLongRunLast14d;
  if (spent >= 50 && spent <= 63) {
    L.push('');
    L.push(`⚠️ Weekly volume ${spent}mi is approaching the 55–63mi calf band. Keep the long run under 19mi — ` +
           `that conjunction has produced failure within 1–2 weeks in every build for six years.`);
  }
  if (rolling.weeksAbove55Consecutive >= 2) {
    L.push('');
    L.push(`⚠️ ${rolling.weeksAbove55Consecutive} consecutive weeks above 55mi — a step-back week ≤45mi is required.`);
  }

  L.push('');
  L.push('This is a load budget, not a prescription. How it is spent is the athlete\'s call — ' +
         'the constraints above are what must hold.');
  return L.join('\n');
}

async function toolBlockState() {
  const accessToken = await getAccessToken();
  const bs = (await D.getBlockStateFromKV(accessToken)) || DEFAULT_BLOCK_STATE;
  const paces = cascadePaceBands(bs.mp_provisional);
  const today = athleteToday(bs.timezone);

  const L = [
    `BLOCK: ${bs.block}`,
    `Goal race: ${bs.race_date} · target ${bs.target}`,
    `Marathon pace: ${bs.mp_provisional}/mi (confirmed by: ${bs.mp_confirmed_by})`,
    `Long run cap: ${bs.long_run_cap}mi · peak week: ${bs.peak_week}mi`,
    '',
    'Pace bands (all cascade from MP):',
  ];
  if (paces) {
    for (const [k, label] of [['easy','Easy'],['longRun','Long run'],['grayZone','GRAY ZONE'],
                              ['subTLong','Sub-T long reps'],['subTShort','Sub-T short reps'],
                              ['threshold','Threshold'],['vo2','5K / VO2']]) {
      L.push(`  ${label.padEnd(18)} ${paces[k].text}/mi   HR ${paces[k].hr}`);
    }
  }
  if (bs.key_sessions?.length) {
    L.push('');
    L.push('Key sessions:');
    for (const k of bs.key_sessions) {
      const past = k.date < today ? ' (past)' : '';
      L.push(`  ${k.date} — ${k.type}: ${k.detail}${past}`);
    }
  }
  if (bs.open_questions?.length) {
    L.push('');
    L.push('Open questions:');
    bs.open_questions.forEach(q => L.push(`  - ${q}`));
  }
  return L.join('\n');
}

async function toolRecalibrate(args) {
  const accessToken = await getAccessToken();
  const kvUrl = process.env.KV_REST_API_URL, kvToken = process.env.KV_REST_API_TOKEN;
  const athleteId = await getAthleteId(accessToken);
  const key = `coach:${athleteId}:block-state`;
  const current = (await libKvGet(kvUrl, kvToken, key)) || DEFAULT_BLOCK_STATE;

  const out = applyRecalibration(current, {
    raceName: args.raceName, raceDate: args.raceDate, time: args.time,
  });
  if (!out) return `Could not recalibrate from "${args.time}".`;

  const dryRun = args.dryRun !== false; // default to preview
  if (!dryRun) await kvSet(kvUrl, kvToken, key, out.blockState);

  return [
    dryRun ? 'PREVIEW — not saved. Call again with dryRun: false to apply.' : 'APPLIED.',
    '',
    ...out.changes,
  ].join('\n');
}

module.exports._internals = { TOOLS, handleRpc, callTool };
