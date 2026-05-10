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

const { kvGet, kvSet, fmtPace, computeMileSplits } = require('./_lib');
const { analyzeHRStream } = require('./_stream-analysis');

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
          await kvSet(kvUrl, kvToken, `streams:${athleteId}:${activityId}`, {
            ...analysis,
            activityId:   String(activityId),
            activityName: activity.name || '',
            activityType: activity.type || '',
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
  const [trainSum, ouraSum] = await Promise.all([
    kvGet(kvUrl, kvToken, `training_summary:${athleteId}`),
    kvGet(kvUrl, kvToken, `oura:${athleteId}:summary:v2:${isoDate()}`),
  ]);
  const context = buildContext(trainSum, ouraSum);

  // Generate coaching analysis
  const analysis = await generateAnalysis(actSummary, context);
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

async function generateAnalysis(activitySummary, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const system = [
    'You are a running coach. Generate exactly 3 lines:',
    'Line 1: What happened in the workout (distance, key paces, structure if workout)',
    'Line 2: One specific coaching observation (good or needs work)',
    'Line 3: How it affects race prep / what it means for Sugarloaf or current training phase',
    'Be specific, use actual numbers. No fluff. Output ONLY the 3 lines — no labels, no numbering.',
  ].join('\n');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: activitySummary + (context ? '\n\n' + context : '') }],
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || null;
  } catch (_) { return null; }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isoDate()  { return new Date().toISOString().split('T')[0]; }
