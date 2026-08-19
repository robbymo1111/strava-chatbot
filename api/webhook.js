'use strict';

/**
 * Strava Webhook Handler
 *
 * GET  /api/webhook?hub.mode=subscribe&hub.challenge=xxx&hub.verify_token=yyy
 *      Strava one-time verification handshake.
 *
 * GET  /api/webhook?action=pending&accessToken=xxx
 *      Returns and clears the pending auto-analysis for this athlete.
 *      Called by the app on load to surface post-run analyses.
 *
 * POST /api/webhook  { object_type:'activity', aspect_type:'create', owner_id, object_id }
 *      Strava activity-created event. Responds 200 immediately, then:
 *        1. Waits 15 s for Strava to finish processing
 *        2. Fetches activity + laps
 *        3. Generates a 3-line coaching summary via Claude
 *        4. Saves as pending coach message in KV
 *
 * Required env vars
 *   STRAVA_WEBHOOK_SECRET
 *   STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET
 *   ANTHROPIC_API_KEY
 *   KV_REST_API_URL / KV_REST_API_TOKEN
 */

const { kvGet, kvSet, fmtPace, computeMileSplits, classifyLaps } = require('./_lib');
const { analyzeHRStream } = require('./_stream-analysis');
const { classifyHRSeconds, computeGrayZone, inferSessionType,
        elapsedMinusMoving, athleteToday, analyzeReps } = require('./_coach-metrics');
const { buildKnowledgeBase } = require('./_coach-kb');

module.exports = async (req, res) => {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  /* ── GET ──────────────────────────────────────────────────────────────── */
  if (req.method === 'GET') {
    const { action, accessToken } = req.query;
    const mode      = req.query['hub.mode'];
    const challenge = req.query['hub.challenge'];
    const verifyTok = req.query['hub.verify_token'];

    // Strava webhook verification handshake
    if (mode === 'subscribe') {
      if (verifyTok !== process.env.STRAVA_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.status(200).json({ 'hub.challenge': challenge });
    }

    // Pending auto-analysis — one-shot: read once then delete
    if (action === 'pending') {
      if (!accessToken) return res.status(400).json({ error: 'accessToken required' });
      const athleteId = await resolveAthleteId(accessToken);
      if (!athleteId) return res.status(200).json({ analysis: null });

      const key  = `auto-analysis:${athleteId}:pending`;
      const data = await kvGet(kvUrl, kvToken, key);
      if (data) {
        await kvPipelineDel(kvUrl, kvToken, key);
      }
      return res.status(200).json({ analysis: data || null });
    }

    return res.status(200).json({ ok: true });
  }

  /* ── POST ─────────────────────────────────────────────────────────────── */
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const body = req.body || {};

  // Strava activity created event
  if (body.object_type === 'activity' && body.aspect_type === 'create') {
    const athleteId  = String(body.owner_id);
    const activityId = body.object_id;

    // Respond immediately — Strava requires < 5 s
    res.status(200).json({ received: true });

    // Function stays alive (Vercel waits for the returned Promise)
    await processNewRun(athleteId, activityId, kvUrl, kvToken)
      .catch(err => console.error('[webhook] processNewRun error:', err.message));
    return;
  }

  // All other Strava events (updates, deletes) — acknowledge
  return res.status(200).json({ received: true });
};

/* ── Post-run processing ──────────────────────────────────────────────────── */

async function processNewRun(athleteId, activityId, kvUrl, kvToken) {
  console.log('[webhook] processNewRun start — activity', activityId, 'athlete', athleteId);

  // Deduplication
  const dedupKey = `auto-analysis:dedup:${activityId}`;
  const already  = await kvGet(kvUrl, kvToken, dedupKey);
  if (already) { console.log('[webhook] Duplicate event, skipping', activityId); return; }
  await kvSetEx(kvUrl, kvToken, dedupKey, { at: Date.now() }, 86400);

  // Load stored tokens
  const tokens = await kvGet(kvUrl, kvToken, `athlete:${athleteId}:tokens`);
  if (!tokens?.accessToken) {
    console.log('[webhook] No stored tokens for athlete', athleteId);
    return;
  }

  // Refresh if needed
  const accessToken = await getValidToken(tokens, athleteId, kvUrl, kvToken);
  if (!accessToken) { console.log('[webhook] Token refresh failed for athlete', athleteId); return; }

  // Wait for Strava to fully process the activity
  await sleep(15000);

  // Fetch activity + laps in parallel
  const [actRes, lapsRes] = await Promise.all([
    fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetch(`https://www.strava.com/api/v3/activities/${activityId}/laps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  ]);

  if (!actRes.ok) { console.log('[webhook] Activity fetch failed:', actRes.status); return; }

  const activity = await actRes.json();
  const laps     = lapsRes.ok ? (await lapsRes.json()) : [];

  const isRun = /run/i.test(activity.type || '');

  // Fetch HR streams for all quality activities (runs, rides, spin classes, etc.)
  if (isQualityActivity(activity)) {
    try {
      const streamsRes = await fetch(
        `https://www.strava.com/api/v3/activities/${activityId}/streams` +
        `?keys=heartrate,time,velocity_smooth,distance,altitude&key_by_type=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (streamsRes.ok) {
        const raw = await streamsRes.json();
        const streams = {
          heartrate:       raw.heartrate?.data       || [],
          time:            raw.time?.data             || [],
          velocity_smooth: raw.velocity_smooth?.data  || [],
          distance:        raw.distance?.data         || [],
        };

        // Store stream analysis for all activity types
        const maxHR = null; // webhook has no athlete maxHR — analysis falls back to observed peak
        const analysis = analyzeHRStream(streams, activity.max_heartrate || null, activity.type || '');
        if (analysis) {
          // Absolute KB bands alongside the maxHR-relative zones. Max HR is
          // unresolved (169 observed vs 181 assumed), so relative zones shift
          // under an unknown — the absolute bands are what grading uses.
          const sessionType = inferSessionType(activity);
          const absBands    = classifyHRSeconds(streams.heartrate);
          const grayZone    = computeGrayZone(streams.heartrate, sessionType);

          await kvSet(kvUrl, kvToken, `streams:${athleteId}:${activityId}`, {
            ...analysis,
            activityId:   String(activityId),
            activityName: activity.name || '',
            activityType: activity.type || '',
            sessionType,
            absoluteBands: absBands ? { seconds: absBands.seconds, pcts: absBands.pcts } : null,
            grayZone,
            stopped: elapsedMinusMoving(activity),
          });
        }

        // For runs: also compute per-mile splits
        if (isRun) {
          // Reconstruct keyed-object format expected by computeMileSplits
          const forSplits = {
            distance:        { data: streams.distance },
            heartrate:       { data: streams.heartrate },
            altitude:        { data: raw.altitude?.data || [] },
            velocity_smooth: { data: streams.velocity_smooth },
          };
          const splits = computeMileSplits(forSplits);
          if (splits?.length > 0) {
            await kvSet(kvUrl, kvToken, `mile-splits:${athleteId}:${activityId}`, {
              activityId, splits, computedAt: Date.now(),
            });
          }
        }
      }
    } catch (e) {
      console.error('[webhook] Stream fetch error:', e.message);
    }
  }

  // Only generate coaching analysis for runs and high-effort non-runs
  if (!isRun && !isQualityActivity(activity)) return;

  // Build prompt content
  const actSummary = buildActivitySummary(activity, laps);
  const [trainSum, ouraSum, blockState, convLog, streamMetrics] = await Promise.all([
    kvGet(kvUrl, kvToken, `training_summary:${athleteId}`),
    kvGet(kvUrl, kvToken, `oura:${athleteId}:summary:v2:${isoDate()}`),
    kvGet(kvUrl, kvToken, `coach:${athleteId}:block-state`),
    kvGet(kvUrl, kvToken, `memory:${athleteId}:conversations`),
    kvGet(kvUrl, kvToken, `streams:${athleteId}:${activityId}`),
  ]);
  const context = buildContext(trainSum, ouraSum);

  // What was this session SUPPOSED to be? Grading compares to intent, not to
  // an absolute standard (spec §4.2) — a session cut short for the right
  // reason is a completed session, not a failure.
  const intent = resolveIntent(activity, blockState, convLog);

  // Objective grading facts, computed not inferred
  const grading = buildGradingFacts(activity, laps, streamMetrics);

  // Generate coaching analysis
  const analysis = await generateAnalysis(actSummary, context, grading, intent, blockState);
  if (!analysis) return;

  const distMi     = activity.distance ? (activity.distance / 1609.34).toFixed(1) : null;
  const durMin     = activity.moving_time ? Math.round(activity.moving_time / 60) : null;
  const typeLabel  = (activity.type || 'Activity').replace(/([a-z])([A-Z])/g, '$1 $2');
  const notifTitle = distMi
    ? `${typeLabel} analyzed — ${distMi}mi`
    : `${typeLabel} analyzed — ${durMin || '?'}min`;

  // Save as pending in-app message
  await kvSet(kvUrl, kvToken, `auto-analysis:${athleteId}:pending`, {
    title: notifTitle, message: analysis, activityId, createdAt: Date.now(),
  });

  console.log('[webhook] processNewRun complete for activity', activityId);
}

/* ── Grading support ──────────────────────────────────────────────────────── */

/**
 * Work out what the session was supposed to be.
 * Sources, in priority order: a key session scheduled for today in block
 * state, then the most recent conversation decisions, then the activity name.
 * Returns null when intent is genuinely unknown — the grader then says so
 * rather than inventing a target to grade against.
 */
function resolveIntent(activity, blockState, convLog) {
  const date = (activity.start_date_local || activity.start_date || '').slice(0, 10);

  const keyed = (blockState?.key_sessions || []).find(k => k.date === date);
  if (keyed) return { source: 'planned key session', text: `${keyed.type}: ${keyed.detail}` };

  if (Array.isArray(convLog) && convLog.length) {
    const recent = convLog[convLog.length - 1];
    const decisions = recent?.decisions;
    if (Array.isArray(decisions) && decisions.length) {
      return { source: `coaching decision on ${recent.date}`, text: decisions.join('; ') };
    }
  }

  const name = activity.name || '';
  if (/\d+\s*x\s*\d+|@\s*mp|sub-?t|tempo|threshold|\bmp\b/i.test(name)) {
    return { source: 'activity title', text: name };
  }
  return null;
}

/**
 * Assemble the objective grading facts from stored stream metrics and laps.
 * Everything here is computed — the model reads and explains, it does not
 * recompute (spec §1).
 */
function buildGradingFacts(activity, laps, streamMetrics) {
  const L = [];
  const sessionType = inferSessionType(activity);
  L.push(`session_type_inferred: ${sessionType}`);

  const stopped = elapsedMinusMoving(activity);
  if (stopped?.significant) {
    L.push(`elapsed ${stopped.elapsedStr} vs moving ${stopped.movingStr} — ${stopped.stoppedStr} stopped`);
  }

  // Gray zone — the flagship metric
  const gz = streamMetrics?.grayZone;
  if (gz) {
    L.push(`gray_zone: ${gz.grayPct}% at HR 136–152 · ${gz.easyPct}% under 136 · flagged=${gz.flagged}`);
    L.push(`  ${gz.detail}`);
  } else {
    L.push('gray_zone: UNAVAILABLE — no HR stream for this activity');
  }

  // Absolute-band distribution
  const bands = streamMetrics?.absoluteBands?.pcts;
  if (bands) {
    L.push(`hr_bands: easy ${bands.easy}% · gray ${bands.gray}% · MP ${bands.mp}% · subT ${bands.subt}% · threshold ${bands.threshold}% · VO2 ${bands.vo2}%`);
  }

  // Rep structure for quality sessions
  if (Array.isArray(laps) && laps.length >= 2) {
    const classified = classifyLaps(laps, 6.5);
    const work = classified.filter(l => l.classification === 'Interval' || l.classification === 'Hard');
    if (work.length >= 2) {
      const reps = work.map(l => ({ avgHR: l.hr, maxHR: l.maxHR, paceMinMi: l.paceMPM, durationSec: (l.durationMin || 0) * 60 }));
      const recoveries = classified
        .filter(l => l.classification === 'Easy' || l.classification === 'Moderate')
        .map(l => ({ minHR: l.hr }));
      const ra = analyzeReps(reps, recoveries);
      if (ra) {
        L.push(`reps: ${ra.repCount} work intervals · avg HRs ${ra.repHRs.join('/')} · drift ${ra.driftBpm > 0 ? '+' : ''}${ra.driftBpm}bpm`);
        L.push(`  in 155–162 band: ${ra.inBandCount}/${ra.repHRs.length} · above band by final rep: ${ra.droveAboveBand}`);
        if (ra.recoveryClearance) {
          L.push(`  recoveries clearing below 140: ${ra.recoveryClearance.cleared}/${ra.recoveryClearance.total} (min HRs ${ra.recoveryClearance.minHRs.join('/')})`);
        }
        L.push(`  ${ra.verdict}`);
      }
      const rows = work.map((l, i) => `  Rep ${i + 1}: ${l.distMi}mi @ ${l.pace || '?'}/mi${l.hr ? ` · HR ${l.hr}` : ''}${l.maxHR ? ` (max ${l.maxHR})` : ''}`);
      L.push('rep_detail:\n' + rows.join('\n'));
    }
  }

  // Long-run pace discipline — the recurring 8:15 drift (KB §8.2)
  if (sessionType === 'long' && activity.average_speed) {
    const mpm  = 1609.34 / activity.average_speed / 60;
    const pace = fmtPace(mpm);
    const inBand = mpm >= 8.75 && mpm <= 9.0;
    L.push(`long_run_pace: ${pace}/mi vs 8:45–9:00 target — ${inBand ? 'in band' : mpm < 8.75 ? 'TOO FAST (the recurring drift toward 8:15)' : 'slower than target'}`);
  }

  return L.join('\n');
}

function isQualityRun(activity) {
  if (!/run/i.test(activity.type || '')) return false;
  const distMi = (activity.distance || 0) / 1609.34;
  const avgMPM = activity.average_speed ? 1609.34 / activity.average_speed / 60 : 99;
  return activity.workout_type === 1 || activity.workout_type === 3 ||
         avgMPM < 8.0 || (activity.max_heartrate || 0) > 160 ||
         (activity.suffer_score || 0) > 50 || distMi >= 10;
}

function isQualityActivity(activity) {
  // Quality run criteria
  if (/run/i.test(activity.type || '')) return isQualityRun(activity);
  // Non-run: any activity with high average HR or meaningful suffer score
  return (activity.average_heartrate || 0) > 130 || (activity.suffer_score || 0) > 30;
}

/* ── Activity summary builder ─────────────────────────────────────────────── */

function buildActivitySummary(activity, laps) {
  const distMi  = activity.distance   ? (activity.distance   / 1609.34).toFixed(2) : '?';
  const timeMin = activity.moving_time ? Math.round(activity.moving_time / 60) : '?';
  const avgPace = (activity.average_speed && activity.distance)
    ? fmtPace(1609.34 / activity.average_speed / 60) : '?:??';
  const elevFt  = activity.total_elevation_gain
    ? Math.round(activity.total_elevation_gain * 3.28084) : 0;
  const avgHR   = activity.average_heartrate ? Math.round(activity.average_heartrate) : null;
  const maxHR   = activity.max_heartrate     ? Math.round(activity.max_heartrate)     : null;
  const wt      = activity.workout_type;
  const wtLabel = { 1: 'Race', 2: 'Long Run', 3: 'Workout' }[wt] || 'Run';

  const lines = [
    `Activity: "${activity.name || 'Run'}" (${wtLabel})`,
    `Distance: ${distMi} miles | Time: ${timeMin} min | Avg pace: ${avgPace}/mi`,
    `Elevation: ${elevFt} ft${avgHR ? ` | Avg HR: ${avgHR} bpm` : ''}${maxHR ? ` | Max HR: ${maxHR} bpm` : ''}`,
  ];

  if (Array.isArray(laps) && laps.length > 1 && laps.length <= 15) {
    const lapLines = laps.slice(0, 10).map((l, i) => {
      const d    = l.distance ? (l.distance / 1609.34).toFixed(2) : '?';
      const pace = l.average_speed ? fmtPace(1609.34 / l.average_speed / 60) : '?:??';
      const hr   = l.average_heartrate ? ` HR:${Math.round(l.average_heartrate)}` : '';
      return `  Lap ${i + 1}: ${d}mi @ ${pace}/mi${hr}`;
    });
    lines.push('Laps:\n' + lapLines.join('\n'));
  }

  return lines.join('\n');
}

function buildContext(trainSum, ouraSum) {
  const parts = [];
  if (trainSum?.text)   parts.push('Recent training:\n' + trainSum.text.slice(0, 600));
  if (ouraSum?.available) {
    const r = ouraSum.todayReadiness, h = ouraSum.todayHrvPct;
    if (r != null) {
      parts.push(`Recovery: readiness ${r}/100${h != null ? `, HRV ${h > 0 ? '+' : ''}${h}% vs baseline` : ''}`);
    }
  }
  return parts.join('\n\n');
}

/* ── Claude API ───────────────────────────────────────────────────────────── */

/**
 * Grade a completed session against its intent (spec §4.2).
 *
 * Uses the knowledge base so grading runs against this athlete's absolute
 * zones and failure modes rather than generic coaching. Sonnet — the model
 * routing decision was Sonnet for grading, Opus for plan revision.
 */
async function generateAnalysis(activitySummary, context, grading, intent, blockState) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const system = buildKnowledgeBase(blockState) + `

═══════════════════════════════════════════════════════════════════════════════
TASK: grade this completed session.
═══════════════════════════════════════════════════════════════════════════════

GRADE AGAINST INTENT, NOT AN ABSOLUTE STANDARD.
If the plan was 3x12 and he ran 3x10 because HR climbed, that is a correct
execution of the bail condition — a completed session, not a failure. Say so.
If intent is listed as unknown, grade the execution on its own terms and do not
invent a target he "missed".

The GRADING FACTS below are computed from the HR stream and laps. They are
authoritative. Do not recompute them and do not contradict them.

ALWAYS COVER, when the data exists:
- Gray-zone percentage. On easy/long runs this is the flagship error — name it.
  On quality sessions time at 136–152 is expected (warmup, recoveries) and is
  NOT an error; do not flag it as one.
- Rep-by-rep HR trajectory and whether drift stayed in the 155–162 band.
- Whether recoveries cleared below ~140.
- Long-run pace against 8:45–9:00 — he drifts to 8:15 and it is a recurring
  correction worth making every time.
- For races: elapsed time alongside moving time.

Remember pace is primary and HR is a ceiling — max HR is unresolved (169
observed vs 181 assumed). A rep on target pace with a high HR reading is not
too hot.

FORMAT: lead with the verdict in one line, then the evidence. Two or three
short paragraphs at most. Specific numbers only. No headings, no bullets, no
preamble, no flattery.`;

  const userContent = [
    activitySummary,
    intent ? `\nPRESCRIBED INTENT (${intent.source}):\n${intent.text}`
           : '\nPRESCRIBED INTENT: unknown — no planned session on record for this date.',
    grading ? `\nGRADING FACTS (computed):\n${grading}` : '',
    context ? `\n${context}` : '',
  ].filter(Boolean).join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 600,
        system:     [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
        messages:   [{ role: 'user', content: userContent }],
      }),
    });
    if (!r.ok) {
      console.error('[webhook] grading API error:', r.status);
      return null;
    }
    const d = await r.json();
    return (d.content || []).find(b => b.type === 'text')?.text?.trim() || null;
  } catch (e) {
    console.error('[webhook] grading error:', e.message);
    return null;
  }
}

/* ── Strava token helpers ────────────────────────────────────────────────── */

async function getValidToken(tokens, athleteId, kvUrl, kvToken) {
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expiresAt > now + 120) return tokens.accessToken;

  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: tokens.refreshToken,
        grant_type:    'refresh_token',
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    await kvSet(kvUrl, kvToken, `athlete:${athleteId}:tokens`, {
      accessToken:  d.access_token,
      refreshToken: d.refresh_token,
      expiresAt:    d.expires_at,
    });
    return d.access_token;
  } catch (_) { return null; }
}

async function resolveAthleteId(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const a = await r.json();
    return a.id ? String(a.id) : null;
  } catch (_) { return null; }
}

/* ── KV helpers ──────────────────────────────────────────────────────────── */

async function kvSetEx(url, token, key, value, ttlSeconds) {
  try {
    await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]),
    });
  } catch (_) {}
}

async function kvPipelineDel(url, token, key) {
  try {
    await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['DEL', key]]),
    });
  } catch (_) {}
}

// Exposed for tests. Not part of the HTTP surface.
module.exports._internals = { buildGradingFacts, resolveIntent, generateAnalysis, buildActivitySummary };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
// Athlete-local date — must match the key oura.js writes.
function isoDate()  { return athleteToday(); }
