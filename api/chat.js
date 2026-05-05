const { classifyLaps, detectPattern } = require('./_lib');

/**
 * POST /api/chat
 * Body: { message: string, accessToken: string, history: Array<{role, content}> }
 *
 * 1. Fetches the athlete's recent Strava activities (last 30 days, up to 20)
 * 2. Classifies each run by type (Easy, Long, Tempo, Workout, Recovery, Race)
 * 3. Sends classified activities + weekly balance to Claude with the user's question
 * 4. Returns { reply: string, weeklyBalance: object }
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  /* ── Parse body ── */
  const { message, accessToken, history = [], memory = null } = req.body || {};

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'message is required.' });
  }

  if (!accessToken || typeof accessToken !== 'string') {
    return res.status(401).json({ error: 'accessToken is required.' });
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return res.status(500).json({ error: 'Anthropic API key is not configured on the server.' });
  }

  /* ── Parallel: fetch Strava activities + training summary + Intervals.icu + history ── */
  const ninetyDaysAgo = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  let activities           = [];
  let trainingSummary      = null;
  let intervalsWellness    = null;
  let historyAnalysis      = null;
  let conversationContext  = null;
  let ouraData             = null;
  let thresholdDrift       = null;

  // Detect historical query before fetching so we can fire it in parallel
  const historicalQuery = detectHistoricalQuery(message);
  let   historicalBlock = null;

  try {
    // Fetch all data sources in parallel
    const [stravaRes, kvSummary, iWellness, histAnalysis, histBlock, convContext, ouraRaw, threshRaw] = await Promise.all([
      fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${ninetyDaysAgo}&per_page=200`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ),
      getTrainingSummaryFromKV(accessToken),
      fetchIntervalsWellnessForChat(),
      getHistoryAnalysisFromKV(accessToken),
      historicalQuery ? getHistoricalBlock(accessToken, historicalQuery) : Promise.resolve(null),
      getConversationContext(accessToken),
      getOuraDataFromKV(accessToken),
      getThresholdDriftFromKV(accessToken),
    ]);

    if (stravaRes.status === 401) {
      return res.status(401).json({ error: 'Your Strava session has expired. Please log in again.' });
    }
    if (stravaRes.status === 429) {
      return res.status(429).json({ error: 'Strava rate limit reached — your activity history synced recently and used up the quota. Wait a few minutes and try again.' });
    }
    if (!stravaRes.ok) {
      console.error('Strava activities error:', stravaRes.status);
      return res.status(502).json({ error: 'Could not fetch your Strava activities (Strava returned ' + stravaRes.status + '). Please try again.' });
    }

    activities = await stravaRes.json();
    activities.sort((a, b) =>
      new Date(b.start_date_local || b.start_date) - new Date(a.start_date_local || a.start_date)
    );

    trainingSummary      = kvSummary;
    intervalsWellness    = iWellness;
    historyAnalysis      = histAnalysis;
    historicalBlock      = histBlock;
    conversationContext  = convContext;
    ouraData             = ouraRaw;
    thresholdDrift       = threshRaw;
  } catch (err) {
    console.error('Strava fetch error:', err);
    return res.status(502).json({ error: 'Network error fetching Strava data.' });
  }

  const athletePaces = memory?.paces  || null;
  const athleteMaxHR = memory?.maxHR  || null;
  const hrZones      = getHRZones(athleteMaxHR);

  /* ── Pipeline order (strict) ──────────────────────────────────────────────
     Step 1: activities already fetched above
     Step 2: fetch laps using OBJECTIVE criteria (no classification gating)
     Step 3: initial classification using activity-level data
     Step 4: refine classifications using lap data
     Step 5: compute balance + load from final classifications
     ──────────────────────────────────────────────────────────────────────── */
  await attachLapsToWorkouts(activities, accessToken);
  await attachStreamAnalysis(activities, accessToken, athleteMaxHR);
  classifyActivities(activities, athletePaces, hrZones);
  refineClassificationsWithLaps(activities, athletePaces);
  const weeklyBalance  = getWeeklyBalance(activities);
  const estimatedLoad  = calculateTrainingLoad(activities, athletePaces, athleteMaxHR);

  // Use real Intervals.icu values when available
  const trainingLoad = (intervalsWellness && intervalsWellness.available)
    ? {
        ctl:      intervalsWellness.ctl,
        atl:      intervalsWellness.atl,
        tsb:      intervalsWellness.tsb,
        rampRate: intervalsWellness.rampRate,
        source:   'intervals.icu',
        dataDate: intervalsWellness.dataDate,
        history:  intervalsWellness.history,
      }
    : { ...estimatedLoad, source: 'estimated' };

  /* ── Format activities for Claude ── */
  // Full detail for the 20 most recent; compact one-liners for the rest of the 90-day window
  const recentActivities  = activities.slice(0, 20);
  const olderActivities   = activities.slice(20);
  const activitySummary   = formatActivities(recentActivities, olderActivities);

  /* ── Build conversation history for Claude ── */
  // Sanitize history: only keep valid role/content pairs
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8); // max 4 exchanges

  // The current message should be the last user turn
  // If history already ends with the current message, use it as-is; otherwise append
  const messages = buildMessages(safeHistory, message.trim());

  /* ── Call Claude ── */
  const systemPrompt = buildSystemPrompt(activitySummary, activities.length, memory, trainingLoad, trainingSummary, historyAnalysis, historicalBlock, conversationContext, ouraData, thresholdDrift, activities);

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     systemPrompt,
        messages
      })
    });

    if (!claudeRes.ok) {
      const errBody = await claudeRes.json().catch(() => ({}));
      console.error('Claude API error:', claudeRes.status, errBody);
      return res.status(502).json({ error: 'AI service error. Please try again in a moment.' });
    }

    const claudeData = await claudeRes.json();
    const rawReply = claudeData.content?.[0]?.text;

    if (!rawReply) {
      return res.status(502).json({ error: 'Empty response from AI. Please try again.' });
    }

    // Extract session note, strip tag, write to KV before responding
    const reply      = rawReply
      .replace(/<session-note>[\s\S]*?<\/session-note>/g, '')
      .replace(/<memory-update>[\s\S]*?<\/memory-update>/g, '')
      .replace(/<session-note>[\s\S]*/g, '')   // catch truncated (no closing tag)
      .replace(/<memory-update>[\s\S]*/g, '')  // catch truncated
      .trim();
    const sessionNote = parseSessionNote(rawReply, message);
    console.log('[session-note]', sessionNote.summary);
    await Promise.allSettled([
      updateConversationLog(accessToken, sessionNote),
      saveChatMessages(accessToken, message.trim(), reply),
    ]);

    return res.status(200).json({ reply, weeklyBalance, trainingLoad });

  } catch (err) {
    console.error('Claude fetch error:', err);
    return res.status(502).json({ error: 'Network error reaching AI service.' });
  }
};

/* ────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────── */

/**
 * Attach lap data to runs using objective activity signals — NEVER classification tags.
 * Classification happens AFTER this function runs, so gating on _classification here
 * creates a circular dependency that hides workout structure on misclassified runs.
 *
 * Criteria (any one → fetch laps):
 *   - Distance > 6mi (could be long run with pace work)
 *   - Avg pace faster than 8:30/mi (likely quality run)
 *   - Suffer score > 50 (Strava's own effort metric)
 *   - Max HR > 160
 *   - Strava labeled it workout_type 1 (race) or 3 (workout)
 *
 * Fetches up to 20 qualifying runs, batched 5 at a time with 100ms between
 * batches to stay within Strava rate limits.
 * Sets a._lapStatus on every run so formatActivities can explain coverage.
 */
async function attachLapsToWorkouts(activities, accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const LIVE_FETCH_CAP = 20; // max live Strava API calls; KV cache hits are unlimited/free

  // Quality detection: sub-7:55 pace, long runs, labeled workouts, noticeable effort
  function meetsLapCriteria(a) {
    if (!isRun(a)) return false;
    const distMi  = (a.distance || 0) / 1609.34;
    const avgMPM  = a.average_speed ? 1609.34 / a.average_speed / 60 : 99;
    const maxHR   = a.max_heartrate  || 0;
    const suffer  = a.suffer_score   || 0;
    const labeled = a.workout_type === 1 || a.workout_type === 3;
    return avgMPM < 7.917 || distMi > 12 || labeled || suffer > 40 || maxHR > 155;
  }

  // No slice cap here — KV reads are free; only live Strava calls are capped below
  const candidates = activities.filter(meetsLapCriteria);
  const candidateIds = new Set(candidates.map(a => a.id));

  activities.forEach(a => {
    if (!isRun(a)) return;
    if (!candidateIds.has(a.id)) {
      a._lapStatus = 'skipped';
      const distMi  = ((a.distance || 0) / 1609.34).toFixed(1);
      const avgMPM  = a.average_speed ? 1609.34 / a.average_speed / 60 : null;
      const paceStr = avgMPM ? fmtPace(avgMPM) : '?:??';
      a._lapSkipReason = `${distMi}mi @ ${paceStr}/mi — below quality threshold`;
    }
  });

  if (!candidates.length) return;

  let athleteId = null;
  if (kvUrl && kvToken) athleteId = await getAthleteIdOnce(accessToken);

  // Bulk-load mile splits for all candidates in one parallel sweep
  if (kvUrl && kvToken && athleteId) {
    const splitResults = await Promise.all(
      candidates.map(a => kvGet(kvUrl, kvToken, `mile-splits:${athleteId}:${a.id}`))
    );
    candidates.forEach((a, i) => {
      if (splitResults[i]?.splits?.length > 0) a._mileSplits = splitResults[i].splits;
    });
  }

  // Bulk KV lap lookup for ALL candidates in one parallel sweep — no rate-limit cost
  const needLiveFetch = [];
  if (kvUrl && kvToken && athleteId) {
    const cacheResults = await Promise.all(
      candidates.map(a => kvGet(kvUrl, kvToken, `laps:${athleteId}:${a.id}`))
    );
    candidates.forEach((a, i) => {
      const cached = cacheResults[i];
      if (cached && cached.v === 2 && cached.laps && cached.laps.length > 1) {
        a._laps = cached.laps.map(l => ({
          distance:          (l.distMi || 0) * 1609.34,
          average_speed:     l.paceMPM ? 1609.34 / l.paceMPM / 60 : 0,
          average_heartrate: l.hr,
          elapsed_time:      (l.durationMin || 0) * 60,
          name:              `Lap ${l.lapNum}`,
        }));
        a._lapAnalysis = cached;
        a._lapStatus   = 'cached';
      } else {
        needLiveFetch.push(a);
      }
    });
  } else {
    needLiveFetch.push(...candidates);
  }

  // Live fetch only for cache misses, most recent first, hard-capped at LIVE_FETCH_CAP
  const toFetch = needLiveFetch.slice(0, LIVE_FETCH_CAP);
  needLiveFetch.slice(LIVE_FETCH_CAP).forEach(a => {
    a._lapStatus     = 'skipped';
    a._lapSkipReason = 'not cached — run history-sync to populate';
  });

  for (let bStart = 0; bStart < toFetch.length; bStart += 5) {
    const batch = toFetch.slice(bStart, bStart + 5);
    await Promise.all(batch.map(async (a) => {
      try {
        const r = await fetch(
          `https://www.strava.com/api/v3/activities/${a.id}/laps`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!r.ok) { a._lapStatus = 'error'; return; }
        const laps = await r.json();
        if (Array.isArray(laps) && laps.length > 1) {
          a._laps      = laps;
          a._lapStatus = 'fetched';
        } else {
          a._lapStatus = 'insufficient';
        }
      } catch (_) {
        a._lapStatus = 'error';
      }
    }));
    if (bStart + 5 < toFetch.length) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}

// Cached athlete ID within a single request (avoids duplicate /athlete calls)
let _cachedAthleteId = null;
async function getAthleteIdOnce(accessToken) {
  if (_cachedAthleteId) return _cachedAthleteId;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const a = await r.json();
    _cachedAthleteId = a.id ? String(a.id) : null;
    return _cachedAthleteId;
  } catch (_) { return null; }
}

/* ── HR Stream Analysis attachment ─────────────────────────────────────── */

/**
 * Reads cached stream analyses from KV for all activities in a single pipeline call,
 * then attaches as a._streamAnalysis. Covers ALL activity types (not just runs).
 */
async function attachStreamAnalysis(activities, accessToken, maxHR) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return;

  const athleteId = await getAthleteIdOnce(accessToken);
  if (!athleteId) return;

  const commands = activities.map(a => ['GET', `streams:${athleteId}:${a.id}`]);
  try {
    const r = await fetch(`${kvUrl}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(commands),
    });
    const results = await r.json();
    activities.forEach((a, i) => {
      const raw = results[i]?.result;
      if (!raw) return;
      try { a._streamAnalysis = JSON.parse(raw); } catch (_) {}
    });
  } catch (_) {}
}

/**
 * Formats stream analysis as a compact 1–2 line addition to an activity string.
 * Targets under 6 total lines per activity (including lap data).
 */
function formatStreamAnalysis(sa) {
  if (!sa || !sa.zones) return '';

  const z = sa.zones;
  const zoneParts = ['z1','z2','z3','z4','z5'].map(function(k, i) {
    const pct = z[k] ? z[k].pct : 0;
    return pct > 0 ? `Z${i+1}:${pct}%` : null;
  }).filter(Boolean);
  const zoneStr = zoneParts.join(' ');

  const dcStr = (sa.decoupling && sa.decoupling.available)
    ? ` | decouple ${sa.decoupling.pct > 0 ? '+' : ''}${sa.decoupling.pct}%${sa.decoupling.flagged ? ' ⚠' : ''}`
    : '';

  const recovStr = sa.avgRecoveryS != null ? ` | HRR ${sa.avgRecoveryS}bpm/60s` : '';

  const effortStr = sa.effortBlocks && sa.effortBlocks.length > 0
    ? ` | ${sa.effortBlocks.length} effort block${sa.effortBlocks.length > 1 ? 's' : ''} (` +
      sa.effortBlocks.slice(0, 3).map(b => Math.round(b.durationS / 60) + 'min@' + b.avgHR + 'bpm').join(', ') + ')'
    : '';

  const te = sa.trainingEffect;
  const teStr = te ? `  Training Effect: Aerobic ${te.aerobic} / Anaerobic ${te.anaerobic}` : '';

  return `\n  HR Zones: ${zoneStr}${dcStr}${recovStr}${effortStr}` + (teStr ? `\n${teStr}` : '');
}

// KV helpers (same as api/laps.js)
async function kvGet(url, token, key) {
  try {
    const r    = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch (_) { return null; }
}

function kvWrite(url, token, key, value) {
  fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify([['SET', key, JSON.stringify(value)]]),
  }).catch(() => {});
}

/**
 * Format lap array into a compact string for the prompt.
 * Shows up to 30 laps as: "1) 0.25mi@6:45/mi HR168 | 2) 0.13mi@10:20/mi HR142 | ..."
 */
function formatLaps(laps) {
  if (!laps || laps.length < 2) return '';
  const parts = laps.slice(0, 30).map((lap, i) => {
    const distMi = lap.distance ? (lap.distance / 1609.34).toFixed(2) : '?';
    let pace = '';
    if (lap.average_speed && lap.distance > 50) { // ignore < 50m segments
      const mpm = 1609.34 / lap.average_speed / 60;
      const m   = Math.floor(mpm);
      const s   = Math.round((mpm - m) * 60).toString().padStart(2, '0');
      pace = `@${m}:${s}/mi`;
    }
    const hr   = lap.average_heartrate ? ` HR${Math.round(lap.average_heartrate)}` : '';
    const name = lap.name && !/^lap \d+$/i.test(lap.name) ? ` "${lap.name}"` : '';
    return `${i + 1})${name} ${distMi}mi${pace}${hr}`;
  });
  const more = laps.length > 30 ? ` (+${laps.length - 30} more)` : '';
  return `\n  Laps: ${parts.join(' | ')}${more}`;
}

/**
 * Format pre-classified lap array into a compact per-lap string.
 * Used for easy/moderate runs where the flat format is sufficient.
 * Interval workouts use formatWorkoutLaps() instead.
 */
function formatLapsFromAnalysis(laps) {
  if (!laps || laps.length < 2) return '';
  const parts = laps.slice(0, 30).map(l => {
    const cls  = l.classification ? `[${l.classification}]` : '';
    const pace = l.pace ? `@${l.pace}/mi` : '';
    const hr   = l.hr  ? ` HR${l.hr}` : '';
    return `${l.lapNum})${cls} ${l.distMi}mi${pace}${hr}`;
  });
  const more = laps.length > 30 ? ` (+${laps.length - 30} more)` : '';
  return `Laps: ${parts.join(' | ')}${more}`;
}

/**
 * Format cached mile splits into a per-mile block for the prompt.
 * Output example:
 *   Mile 1: 6:28/mi | HR 158 | elev +42ft | GAP 6:22
 *   Mile 2: 6:31/mi | HR 161 | elev +18ft | GAP 6:28
 */
function formatMileSplits(splits) {
  if (!splits || splits.length === 0) return '';
  const lines = splits.map(s => {
    const hr   = s.hr   ? ` | HR ${s.hr}` : '';
    const elev = s.elevFt != null ? ` | elev ${s.elevFt >= 0 ? '+' : ''}${s.elevFt}ft` : '';
    const gap  = (s.gap && s.gap !== s.pace) ? ` | GAP ${s.gap}` : '';
    return `  Mile ${s.mile}: ${s.pace}/mi${hr}${elev}${gap}`;
  });
  return '\n  Per-mile GPS splits:\n' + lines.join('\n');
}

/**
 * Format classified lap array into a structured workout breakdown.
 * Groups consecutive hard laps (Interval/Hard) as numbered reps with
 * per-rep pace listed in parentheses, interstitial easy laps as recovery,
 * and explicitly labels warmup/cooldown.
 *
 * Example output for 5×1mi workout:
 *   Warmup: 2.06mi @ 8:38/mi
 *   5 × ~0.97mi @ 6:15/mi avg (6:14, 6:12, 6:18, 6:14, 6:19)
 *   Recovery jogs: ~0.21mi avg @ 11:36/mi
 *   Cooldown: 2.34mi @ 8:13/mi
 */
function formatWorkoutLaps(classifiedLaps) {
  if (!classifiedLaps || classifiedLaps.length < 2) return '';

  const warmupLap   = classifiedLaps[0]?.classification === 'Warm-up'
    ? classifiedLaps[0] : null;
  const cooldownLap = classifiedLaps[classifiedLaps.length - 1]?.classification === 'Cool-down'
    ? classifiedLaps[classifiedLaps.length - 1] : null;
  const core = classifiedLaps.filter(
    l => l.classification !== 'Warm-up' && l.classification !== 'Cool-down'
  );

  if (!core.length) {
    return classifiedLaps.map(l =>
      `Lap ${l.lapNum}: ${l.distMi}mi @ ${l.pace || '?:??'}/mi [${l.classification}]`
    ).join('\n  ');
  }

  // Group consecutive core laps by rep vs recovery
  const groups = [];
  core.forEach(l => {
    const isHard = l.classification === 'Interval' || l.classification === 'Hard';
    const kind   = isHard ? 'rep' : 'recovery';
    const last   = groups[groups.length - 1];
    if (last && last.kind === kind) last.laps.push(l);
    else groups.push({ kind, laps: [l] });
  });

  const repGroups = groups.filter(g => g.kind === 'rep');
  const parts     = [];

  if (warmupLap) {
    parts.push(`Warmup: ${warmupLap.distMi}mi @ ${warmupLap.pace || '?:??'}/mi`);
  }

  if (repGroups.length > 0) {
    // Per-rep stats: individual distances + paces (handles multi-lap reps too)
    const repStats = repGroups.map(g => {
      const distMi  = g.laps.reduce((s, l) => s + (l.distMi || 0), 0);
      const paceVals = g.laps.map(l => l.paceMPM).filter(Boolean);
      const avgPace  = paceVals.length
        ? paceVals.reduce((a, b) => a + b, 0) / paceVals.length : null;
      // Display each lap's pace; for a single-lap rep just that one pace
      const displayPaces = g.laps.map(l => l.pace).filter(Boolean);
      return { distMi, avgPaceMPM: avgPace, displayPaces };
    });

    const avgRepDist = repStats.reduce((s, r) => s + r.distMi, 0) / repStats.length;
    const allPaceMPM = repStats.map(r => r.avgPaceMPM).filter(Boolean);
    const avgPace    = allPaceMPM.reduce((a, b) => a + b, 0) / allPaceMPM.length;
    // Individual rep paces — one entry per rep group, with sub-lap paces joined by + if needed
    const paceList   = repStats.map(r =>
      r.displayPaces.length === 1 ? r.displayPaces[0] : r.displayPaces.join('+')
    ).join(', ');

    parts.push(
      `${repGroups.length} × ~${avgRepDist.toFixed(2)}mi @ ${fmtPace(avgPace)}/mi avg (${paceList})`
    );

    // Interstitial recoveries only (between reps, not leading/trailing easy laps)
    const interstitialRecov = groups.filter((g, i) =>
      g.kind === 'recovery' && i > 0 && i < groups.length - 1
    );
    if (interstitialRecov.length > 0) {
      const recovLaps = interstitialRecov.flatMap(g => g.laps);
      const recovDists = interstitialRecov.map(g =>
        g.laps.reduce((s, l) => s + (l.distMi || 0), 0)
      );
      const avgDist  = recovDists.reduce((a, b) => a + b, 0) / recovDists.length;
      const paceVals = recovLaps.map(l => l.paceMPM).filter(Boolean);
      const avgRecov = paceVals.reduce((a, b) => a + b, 0) / paceVals.length;
      parts.push(`Recovery jogs: ~${avgDist.toFixed(2)}mi avg @ ${fmtPace(avgRecov)}/mi`);
    }
  } else {
    // No hard reps — just list core laps
    core.forEach(l => {
      parts.push(`Lap ${l.lapNum}: ${l.distMi}mi @ ${l.pace || '?:??'}/mi [${l.classification}]`);
    });
  }

  if (cooldownLap) {
    parts.push(`Cooldown: ${cooldownLap.distMi}mi @ ${cooldownLap.pace || '?:??'}/mi`);
  }

  return parts.join('\n  ');
}

/**
 * Detect whether an activity's overall avg pace is a misleading blended figure.
 * Returns true when the fastest lap is >15% faster than the overall average —
 * meaning warmup/recovery jogs are dragging up the reported pace.
 */
function isBlendedPaceWorkout(a) {
  // Lap analysis already flagged it
  if (a._lapAnalysis?.paceVariance?.isWorkout) return true;
  if (a._lapAnalysis?.hardEfforts?.repCount  > 0) return true;

  // Fallback: check raw laps for pace spread
  if (a._laps && a._laps.length > 1 && a.average_speed) {
    const avgMPM = 1609.34 / a.average_speed / 60;
    const fastestSpeed = Math.max(...a._laps.filter(l => (l.average_speed || 0) > 0 && (l.distance || 0) > 100).map(l => l.average_speed));
    if (fastestSpeed > 0) {
      const fastestMPM = 1609.34 / fastestSpeed / 60;
      return avgMPM / fastestMPM > 1.15;
    }
  }
  return false;
}

/**
 * Format Strava activities array into a compact human-readable string for Claude.
 * For activities with mixed paces (workouts), lap-level data leads and the blended
 * average is annotated as such so Claude never anchors on it.
 */
function formatActivities(activities, olderActivities) {
  if (!activities || activities.length === 0) {
    return 'No activities found in the last 90 days.';
  }

  const lines = activities.map((a) => {
    const date        = new Date(a.start_date_local || a.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const distMi      = a.distance ? (a.distance / 1609.34).toFixed(2) : null;
    const durationMin = a.moving_time ? Math.round(a.moving_time / 60) : null;

    const blended = isBlendedPaceWorkout(a);

    let pace = '';
    if (a.average_speed && /run/i.test(a.type || '')) {
      const mpm  = 1609.34 / a.average_speed / 60;
      const mins = Math.floor(mpm);
      const secs = Math.round((mpm - mins) * 60).toString().padStart(2, '0');
      // For blended workouts, label clearly so Claude doesn't use it as the workout pace
      pace = blended
        ? ` | blended avg ${mins}:${secs}/mi (warmup+recovery included — NOT workout pace)`
        : ` | pace ${mins}:${secs}/mi`;
    } else if (a.average_speed) {
      const mph = (a.average_speed * 2.23694).toFixed(1);
      pace = ` | ${mph} mph avg`;
    }

    const hr      = a.average_heartrate ? ` | HR ${Math.round(a.average_heartrate)} bpm` : '';
    const maxHR   = a.max_heartrate     ? ` (max ${Math.round(a.max_heartrate)})` : '';
    const elevFt  = a.total_elevation_gain ? ` | elev +${Math.round(a.total_elevation_gain * 3.28084)}ft` : '';
    const suffer  = a.suffer_score      ? ` | suffer ${a.suffer_score}` : '';
    const kudos   = a.kudos_count > 0   ? ` | ${a.kudos_count} kudos` : '';
    const name    = a.name ? `"${a.name}"` : a.type;
    const dist    = distMi ? ` ${distMi}mi` : '';
    const dur     = durationMin ? ` in ${durationMin}min` : '';
    const tag     = a._classification ? ` [${a._classification}]` : '';

    // Temperature note
    let weatherAdj = '';
    if (a.average_temp != null) {
      const tempF = Math.round(a.average_temp * 9 / 5 + 32);
      weatherAdj = ` | ${tempF}°F`;
    }

    // Lap section — always annotate coverage so Claude knows what data exists.
    // For interval/workout structure: use the grouped rep format (shows per-rep paces).
    // For easy runs with laps: use flat per-lap format.
    let laps = '';
    if (a._lapAnalysis?.laps?.length > 1) {
      const hasRepStructure = a._lapAnalysis.laps.some(
        l => l.classification === 'Interval' || l.classification === 'Hard'
      );
      const patternDesc = a._lapAnalysis.pattern?.description;

      if (hasRepStructure) {
        // Grouped format: warmup / reps with individual paces / recovery / cooldown
        const workoutFmt = formatWorkoutLaps(a._lapAnalysis.laps);
        if (blended) {
          laps =
            '\n  *** ACTUAL WORKOUT PACE (use this, not blended avg):\n  ' + workoutFmt +
            (patternDesc ? `\n  Pattern: ${patternDesc}` : '');
        } else {
          laps = (patternDesc ? ` (pattern: ${patternDesc})` : '') + '\n  ' + workoutFmt;
        }
      } else {
        // Easy/moderate run with lap data — flat per-lap format
        const lapDetail = formatLapsFromAnalysis(a._lapAnalysis.laps);
        laps = patternDesc
          ? ` (pattern: ${patternDesc})\n  ${lapDetail}`
          : `\n  ${lapDetail}`;
      }
    } else if (a._laps && a._laps.length > 1) {
      laps = formatLaps(a._laps);
    } else if (isRun(a)) {
      // Always show lap coverage status for runs so Claude knows what data exists
      if (a._lapStatus === 'skipped') {
        laps = `\n  (lap data: not fetched — ${a._lapSkipReason || 'below threshold'})`;
      } else if (a._lapStatus === 'insufficient') {
        laps = '\n  (lap data: fetch attempted — Strava returned single lap or no structure)';
      } else if (a._lapStatus === 'error') {
        laps = '\n  (lap data: fetch error)';
      } else if (a._lapStatus === 'fetched' || a._lapStatus === 'cached') {
        laps = '\n  (lap data: fetched — no meaningful lap structure detected)';
      }
    }

    const mileSplits  = a._mileSplits?.length > 0 ? formatMileSplits(a._mileSplits) : '';
    const streamBlock = a._streamAnalysis ? formatStreamAnalysis(a._streamAnalysis) : '';
    return `• ${date}: ${a.type}${tag} ${name}${dist}${dur}${pace}${weatherAdj}${hr}${maxHR}${elevFt}${suffer}${kudos}${laps}${mileSplits}${streamBlock}`;
  });

  let output = lines.join('\n');

  if (olderActivities && olderActivities.length > 0) {
    const compactLines = olderActivities.map(a => {
      const date   = new Date(a.start_date_local || a.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const distMi = a.distance ? (a.distance / 1609.34).toFixed(1) : null;
      const dist   = distMi ? ` ${distMi}mi` : '';
      let pace = '';
      if (a.average_speed && /run/i.test(a.type || '')) {
        const mpm  = 1609.34 / a.average_speed / 60;
        const mins = Math.floor(mpm);
        const secs = Math.round((mpm - mins) * 60).toString().padStart(2, '0');
        pace = ` ${mins}:${secs}/mi`;
      }
      const hr  = a.average_heartrate ? ` HR${Math.round(a.average_heartrate)}` : '';
      const tag = a._classification ? ` [${a._classification}]` : '';
      return `  ${date}: ${a.type}${tag}${dist}${pace}${hr}`;
    });
    output += `\n\n(Older activities — date/dist/pace/HR only):\n` + compactLines.join('\n');
  }

  return output;
}

/**
 * Build a deep physiological analysis block from 90 days of activity + PMC history.
 * Gives Claude the data it needs for race probability estimates and trend analysis.
 */
function buildPhysiologicalAnalysisSection(activities, load) {
  if (!activities || activities.length === 0) return '';
  const runs = activities.filter(a => isRun(a));
  if (runs.length === 0) return '';

  const now = new Date();
  now.setHours(23, 59, 59, 999);

  // Weekly mileage + quality session count for last 13 weeks (oldest first)
  const weekData = [];
  for (let w = 12; w >= 0; w--) {
    const end = new Date(now);
    end.setDate(end.getDate() - w * 7);
    const start = new Date(end);
    start.setDate(start.getDate() - 7);
    const weekRuns = runs.filter(a => {
      const d = new Date(a.start_date_local || a.start_date).getTime();
      return d > start.getTime() && d <= end.getTime();
    });
    const miles = weekRuns.reduce((s, a) => s + (a.distance || 0) / 1609.34, 0);
    const q = weekRuns.filter(a =>
      ['Workout', 'Tempo', 'Race'].includes(a._classification)
    ).length;
    weekData.push({ miles: Math.round(miles * 10) / 10, q });
  }

  // CTL trajectory from history
  const hist = load?.history || [];
  const peakCTL = hist.length ? Math.max(...hist.map(h => h.ctl)) : null;
  const peakEntry = peakCTL != null ? hist.find(h => h.ctl === peakCTL) : null;
  const currentCTL = load?.ctl ?? null;
  const ctlWeek4 = hist.length >= 28 ? hist[hist.length - 28].ctl : null;
  const ctlTrend = (currentCTL != null && ctlWeek4 != null)
    ? `${currentCTL > ctlWeek4 ? '+' : ''}${Math.round((currentCTL - ctlWeek4) * 10) / 10} pts over last 4 weeks`
    : null;

  // Overreach: weeks where avg ACWR > 1.3
  let overreachWeeks = 0;
  for (let w = 0; w < 13 && hist.length > 0; w++) {
    const slice = hist.slice(Math.max(0, hist.length - (w + 1) * 7), hist.length - w * 7 || undefined);
    if (!slice.length) continue;
    const avgACWR = slice.reduce((s, h) => s + (h.ctl > 0 ? h.atl / h.ctl : 1), 0) / slice.length;
    if (avgACWR > 1.3) overreachWeeks++;
  }

  // Long runs ≥14 miles
  const longRuns = runs
    .filter(a => (a.distance || 0) / 1609.34 >= 14)
    .sort((a, b) => new Date(b.start_date_local || b.start_date) - new Date(a.start_date_local || a.start_date))
    .map(a => {
      const mi = Math.round((a.distance || 0) / 1609.34 * 10) / 10;
      const date = new Date(a.start_date_local || a.start_date).toISOString().split('T')[0];
      return `${mi}mi (${date})`;
    });

  // Race readiness
  const tsb = load?.tsb ?? null;
  let raceReadiness;
  if (currentCTL != null && tsb != null) {
    if      (currentCTL >= 55 && tsb >= -5 && tsb <= 20)  raceReadiness = 'Peak window — elite fitness, good form. Optimal for marathon racing';
    else if (currentCTL >= 45 && tsb >= -10 && tsb <= 20) raceReadiness = 'Near-peak — strong fitness, low fatigue. Suitable for goal race';
    else if (currentCTL >= 40 && tsb >= -5)               raceReadiness = 'Good base — 2-3 more build weeks would sharpen fitness';
    else if (tsb < -25)                                    raceReadiness = 'Fatigued — needs 1-2 easy/recovery weeks before race';
    else if (currentCTL < 35)                             raceReadiness = 'Building — fitness not yet at marathon-ready threshold';
    else                                                    raceReadiness = 'Developing — 4-8 more weeks recommended before goal race';
  } else {
    raceReadiness = 'Insufficient data for PMC-based assessment';
  }

  const milesRow = weekData.map(w => `${w.miles}`).join(' | ');
  const qRow     = weekData.map(w => w.q).join(' | ');

  const lines = [
    '\n## Physiological Training Analysis (90-Day Window)',
    `Weekly mileage (oldest→newest wk): ${milesRow}`,
    `Quality sessions per week:          ${qRow}`,
  ];

  if (currentCTL != null) {
    const peakStr = peakCTL != null ? ` | 90d peak: ${peakCTL}${peakEntry ? ` on ${peakEntry.date}` : ''}` : '';
    const trendStr = ctlTrend ? ` | trend: ${ctlTrend}` : '';
    lines.push(`CTL: ${currentCTL}${peakStr}${trendStr}`);
  }
  if (tsb != null) {
    lines.push(`ATL: ${load.atl} | TSB: ${tsb > 0 ? '+' : ''}${tsb}`);
  }
  lines.push(`Race readiness: ${raceReadiness}`);

  if (longRuns.length) {
    lines.push(`Long runs ≥14mi: ${longRuns.join(', ')}`);
  } else {
    lines.push('Long runs ≥14mi: NONE — critical gap for marathon fitness');
  }

  if (overreachWeeks >= 3) {
    lines.push(`⚠️ Overreach: ${overreachWeeks}/13 weeks with ACWR >1.3 — elevated cumulative fatigue risk`);
  }

  lines.push('');
  lines.push('RACE PROBABILITY INSTRUCTIONS: When the athlete asks about race readiness or probability, use CTL, peak CTL, TSB, long run inventory, and weekly mileage trend above. Compare CTL to target-level benchmarks (sub-3 marathon ≈ CTL 55-65, sub-3:30 ≈ CTL 45-55). Estimate percentage likelihood based on fitness gap, time to race, and trajectory. Never give vague answers — commit to a specific % and explain the data behind it.');

  return lines.join('\n');
}

/**
 * Build the system prompt for Claude.
 */
function buildSystemPrompt(activitySummary, count, memory, trainingLoad, trainingSummary, historyAnalysis, historicalBlock, conversationContext, ouraData, thresholdDrift, allActivities) {
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const memorySection        = buildMemorySection(memory, thresholdDrift);
  const loadSection          = buildTrainingLoadSection(trainingLoad);
  const ouraSection          = buildOuraSection(ouraData, trainingLoad);
  const historySection       = trainingSummary
    ? `\n## Training History (lap analysis · 90 days)\n${trainingSummary}\n`
    : '';
  const longitudinalSection  = historyAnalysis
    ? `\n${historyAnalysis}\n`
    : '';
  const historicalSection    = historicalBlock
    ? `\n${historicalBlock}\n`
    : '';
  const recentContextSection = conversationContext
    ? `\n## CONVERSATION HISTORY (previous sessions — use to recall past discussions, plans, and context)\n${conversationContext}\n`
    : '';
  const physiologicalSection = buildPhysiologicalAnalysisSection(allActivities, trainingLoad);

  return `You are an elite running coach for experienced runners targeting sub-3 marathons. Every response is grounded in the athlete's actual data — no generic advice.

Today's date: ${now}
${recentContextSection}${memorySection}${loadSection}${ouraSection}${historySection}${longitudinalSection}${historicalSection}${physiologicalSection}
## Recent Strava Activities (last 90 days, ${count} total — full detail for newest 20, compact for remainder)
${activitySummary}

## DATA HIERARCHY
Two data sources per activity: (a) activity list — overall avg pace/HR, (b) Training History — lap-level analysis.
Priority: 1) Training History lap analysis  2) "ACTUAL WORKOUT PACE" lap splits  3) Overall avg (never use to characterize intensity)
If Training History shows interval structure, that IS the workout — ignore blended avg. Always cross-reference both sources.

## COACHING FRAMEWORKS

JACK DANIELS (primary):
- All paces from VDOT. Zones: Easy 59-74%, Marathon 75-84%, Threshold 83-88%, Interval 95-100%, Rep 105-120% vVO2max
- Threshold: 20-30 min continuous or cruise intervals (e.g. 5×1mi, 1 min rest). Max 2 quality sessions/week.
- Intervals: 3-5 min hard, equal recovery. Total interval volume ≤ 8% weekly mileage.
- Easy days must be truly easy — check HR drift, not just pace.

PFITZINGER: LT is most trainable component. Medium-long runs (13-17mi) underused. Recovery weeks every 3-4 weeks (drop 20-30%). Key: LT intervals, MP long runs.

CANOVA: Specificity builds as fitness matures. Fundamental → Special → Specific periodization. Long tempo runs (10-15mi at MP) for advanced runners.

HANSONS: Cumulative fatigue is intentional. Long run capped at 16mi. Tempo = marathon pace (not threshold). Back-to-back quality days intentional.

POLARIZED: 80% easy (below LT1), 20% high intensity (above LT2). Minimize Zone 3. Single-day HRV dip = noise.

## RECOVERY (Oura — follow exactly)

Modify/skip a workout ONLY if 2+ of these signals are true:
1. HRV >15% below 7-day baseline
2. Readiness <55
3. Resting HR >7 bpm above 7-day baseline
4. Third+ consecutive night of poor sleep
5. TSB <-25 AND readiness <60

Signal count rules: 0-1 → proceed as planned | 2 → easier version | 3+ → easy effort or rest
Never lead with negative sleep data. Synthesize into one insight. Use trends, not daily snapshots.
Race week: only flag illness signals (RHR 10+ bpm above baseline for 3+ days). Reassure everything else.
Do not mention HRV/readiness numbers unprompted unless 3+ bad signals.

## APPLYING FRAMEWORKS

Workout suggestions must include: distance, VDOT pace (MM:SS/mi), rest intervals, volume, coaching rationale.
Analyzing runs: use lap data, compare to VDOT targets, flag easy runs above marathon pace or intervals below 95% vVO2max.
Load thresholds: TSB -10 to +5 = optimal | TSB +10 = consider quality session | TSB -20 = back off | ACWR >1.5 = reduce immediately.
Marathon: long runs peak 20-22mi, taper 3 weeks (volume not intensity), no new workout types in final 6 weeks.

## TONE
Direct, specific, data-grounded. 2-4 short paragraphs unless asked for more. Imperial units only. When suggesting a shoe, name one from the athlete's Shoes list with current mileage.

## SAVING TO MEMORY
If the athlete mentions any of the following, append a <memory-update> block at the very end of your response (do NOT mention it in your reply text):
- Race goals or target events → "goals" array (e.g. "Boston Qualifier sub-3:30", "NYC Marathon Nov 2026")
- Personal records → "prs" array (e.g. "5K: 21:30", "Marathon: 3:52:10")
- Injuries or health issues → "injuries" array (e.g. "Left knee tendinitis, started March 2026")
- Preferences or useful context → "notes" array (e.g. "Runs mornings only", "Training 5 days/week")
- Max heart rate (if mentioned or clearly visible from a race/all-out effort) → "maxHR" number (e.g. 187)

Return the COMPLETE updated memory including existing items — not just the new ones.
Existing memory: ${JSON.stringify(memory || { goals: [], prs: [], injuries: [], notes: [], maxHR: null })}

Format (omit entirely if nothing new was mentioned):
<memory-update>
{"goals":[...],"prs":[...],"injuries":[...],"notes":[...],"maxHR":null}
</memory-update>

## SESSION NOTE (required — always append, no exceptions)
After your reply (and after any <memory-update>), append a structured note in exactly this format — all four fields required:
<session-note>
summary: 1-2 sentences. What was discussed, any workouts analyzed, data referenced, decisions made, or concerns raised.
topics: comma-separated keywords (e.g., race plan, tempo workout, calf tightness, taper, HRV, long run pacing)
decisions: comma-separated action items agreed on (e.g., easy week this week, long run Sunday, skip tempo, add strides)
feel: one word or short phrase describing the athlete's state or confidence (e.g., confident, cautious, fatigued, motivated, nervous, strong)
</session-note>`;
}

/**
 * Format the stored memory into a readable system prompt section.
 */
function buildMemorySection(memory, thresholdDrift) {
  if (!memory) return '';

  const lines = [];
  if (memory.goals?.length)    lines.push(`Goals/Races: ${memory.goals.join(' | ')}`);
  if (memory.prs?.length)      lines.push(`PRs: ${memory.prs.join(' | ')}`);
  if (memory.injuries?.length) lines.push(`Injuries/Health: ${memory.injuries.join(' | ')}`);
  if (memory.notes?.length)    lines.push(`Notes: ${memory.notes.join(' | ')}`);

  if (memory.maxHR) {
    lines.push(`Max HR: ${memory.maxHR} bpm`);
  }

  if (memory.vdot) {
    lines.push(`VDOT: ${memory.vdot}`);
  }

  if (memory.paces) {
    const p   = memory.paces;
    const fmt = ([lo, hi]) => `${fmtPace(lo)}–${fmtPace(hi)}/mi`;
    lines.push(
      `Training Paces — Easy: ${fmt(p.easy)}, Marathon: ${fmt(p.marathon)}, ` +
      `Threshold: ${fmt(p.threshold)}, Interval: ${fmt(p.interval)}`
    );
  }

  // Threshold drift from longitudinal analysis
  if (thresholdDrift && thresholdDrift.currentEstimate) {
    const curr    = fmtPace(thresholdDrift.currentEstimate);
    const ago30   = thresholdDrift.estimate30dAgo ? fmtPace(thresholdDrift.estimate30dAgo) : null;
    const trend   = thresholdDrift.trendDirection || 'flat';
    const trendSec = thresholdDrift.trendSeconds;
    const trendStr = trendSec != null
      ? (trendSec < 0 ? `${Math.abs(trendSec)}s faster` : trendSec > 0 ? `${trendSec}s slower` : 'flat')
      : trend;
    lines.push(
      `Threshold pace (${thresholdDrift.totalSessions} sessions): ${curr}/mi` +
      (ago30 ? `, was ${ago30}/mi 30 days ago` : '') +
      ` — trend: ${trendStr}` +
      (thresholdDrift.bigShift ? ' ⚠ significant shift in last 2 weeks' : '')
    );
  }

  // Shoe categories saved by the athlete in the Gear tab
  if (memory.shoeCategories && Object.keys(memory.shoeCategories).length) {
    const pairs = Object.entries(memory.shoeCategories)
      .map(([name, cat]) => `${name} (${cat})`).join(', ');
    lines.push(`Shoes: ${pairs}`);
  }

  if (!lines.length) return '';
  return `\n## Athlete Profile (remembered from past sessions)\n${lines.join('\n')}\n`;
}

function fmtPace(minPerMile) {
  const m = Math.floor(minPerMile);
  const s = Math.round((minPerMile - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ────────────────────────────────────────────
   Workout classifier
   ──────────────────────────────────────────── */

function isRun(activity) {
  return /run/i.test(activity.type || '');
}

/**
 * Derive HR zone boundaries from athlete's max HR (Swain et al. 1994).
 * Returns null if maxHR is unavailable or implausible.
 */
function getHRZones(maxHR) {
  if (!maxHR || maxHR < 100 || maxHR > 230) return null;
  return {
    recovery: maxHR * 0.63,
    easy:     maxHR * 0.77,
    tempo:    maxHR * 0.85,
    thresh:   maxHR * 0.87,
  };
}

/**
 * Classify a single run.
 * Priority: Strava label → speed ratio → duration → VDOT pace zones → HR zones → generic fallback.
 * @param {object} activity
 * @param {object|null} paces    - VDOT pace ranges { easy:[lo,hi], threshold:[lo,hi], ... }
 * @param {object|null} hrZones  - Personalized HR zones from getHRZones(maxHR)
 */
function classifyRun(activity, paces, hrZones) {
  if (!isRun(activity)) return null;

  const durationMin  = (activity.moving_time || 0) / 60;
  const distMi       = (activity.distance    || 0) / 1609.34;
  const avgSpeed     = activity.average_speed;
  const avgPaceMPM   = avgSpeed ? 1609.34 / avgSpeed / 60 : null;
  const avgHR        = activity.average_heartrate;
  const maxSpeed     = activity.max_speed;
  const workoutType  = activity.workout_type;

  if (workoutType === 1) return 'Race';
  if (workoutType === 2) return 'Long Run';
  if (workoutType === 3) return 'Workout';

  const speedRatio = (maxSpeed && avgSpeed && avgSpeed > 0) ? maxSpeed / avgSpeed : 1;
  if (speedRatio > 1.9) return 'Workout';
  if (durationMin >= 90) return 'Long Run';
  if (durationMin <= 35 && distMi <= 4) return 'Recovery Run';

  // ── Personalized pace-based classification (VDOT) ──
  if (paces && avgPaceMPM) {
    const easyHi   = paces.easy[1];
    const easyLo   = paces.easy[0];
    const threshHi = paces.threshold[1];
    const threshLo = paces.threshold[0];

    if (avgPaceMPM > easyHi)                              return 'Recovery Run';
    if (avgPaceMPM >= easyLo && avgPaceMPM <= easyHi)     return 'Easy Run';
    if (avgPaceMPM >= threshLo && avgPaceMPM <= threshHi) return 'Tempo Run';
    if (avgPaceMPM < threshLo)                            return 'Workout';
    return 'Easy Run';
  }

  // ── HR-based (personalized zones when maxHR known) ──
  if (avgHR) {
    if (hrZones) {
      if (avgHR < hrZones.recovery) return 'Recovery Run';
      if (avgHR < hrZones.easy)     return 'Easy Run';
      if (avgHR < hrZones.tempo)    return 'Tempo Run';
      return 'Workout';
    }
    // Generic fixed thresholds
    if (avgHR < 135) return 'Recovery Run';
    if (avgHR < 150) return 'Easy Run';
    if (avgHR < 168) return 'Tempo Run';
    return 'Workout';
  }

  // ── Generic pace-based fallback ──
  if (avgPaceMPM) {
    if (avgPaceMPM > 12.0) return 'Recovery Run';
    if (avgPaceMPM >  9.5) return 'Easy Run';
    if (avgPaceMPM >  7.5) return 'Tempo Run';
    return 'Workout';
  }

  // No reliable data — return Unclassified rather than guessing Easy Run.
  // refineClassificationsWithLaps() will upgrade this after lap data is attached.
  return 'Unclassified';
}

/** Mutates the activities array, adding `_classification` to each item. */
function classifyActivities(activities, paces, hrZones) {
  activities.forEach(a => { a._classification = classifyRun(a, paces, hrZones); });
}

/**
 * Second-pass classification using lap analysis data (attached after initial classify).
 * Upgrades Unclassified runs and corrects misclassifications when lap data is present.
 * Must be called after attachLapsToWorkouts().
 */
function refineClassificationsWithLaps(activities, paces) {
  activities.forEach(a => {
    if (!isRun(a)) return;
    const cls = a._classification;

    // Lap analysis shows hard efforts → it's definitely a Workout (unless already Race)
    if (a._lapAnalysis?.hardEfforts?.repCount > 0) {
      if (cls !== 'Race') a._classification = 'Workout';
      return;
    }

    // Pace variance flags mixed-effort workout structure
    if (a._lapAnalysis?.paceVariance?.isWorkout) {
      if (cls !== 'Race' && cls !== 'Workout') a._classification = 'Workout';
      return;
    }

    // Resolve Unclassified using avg pace vs VDOT marathon pace (if known)
    if (cls === 'Unclassified' && paces?.marathon && a.average_speed) {
      const avgPaceMPM = 1609.34 / a.average_speed / 60;
      if (avgPaceMPM < paces.marathon[0]) a._classification = 'Workout';
      // If still Unclassified, leave it — better than a wrong label
    }
  });
}

/**
 * Summarise the past 7 days of runs by category and produce coaching warnings
 * about intensity distribution (targeted at marathon/endurance runners).
 */
function getWeeklyBalance(activities) {
  const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekRuns   = activities.filter(a =>
    isRun(a) && new Date(a.start_date_local || a.start_date).getTime() > oneWeekAgo
  );

  const counts = {};
  weekRuns.forEach(a => {
    const cat = a._classification || 'Easy Run';
    counts[cat] = (counts[cat] || 0) + 1;
  });

  const easy     = counts['Easy Run']     || 0;
  const long     = counts['Long Run']     || 0;
  const tempo    = counts['Tempo Run']    || 0;
  const workout  = counts['Workout']      || 0;
  const recovery = counts['Recovery Run'] || 0;
  const race     = counts['Race']         || 0;
  const total    = weekRuns.length;
  const quality  = tempo + workout + race; // "hard" sessions

  const warnings = [];
  if (total >= 3) {
    if (quality > 2)
      warnings.push('High intensity load — more easy days would aid recovery');
    if (long === 0)
      warnings.push('No long run this week — long runs build your aerobic base');
    if (quality === 0 && total >= 4)
      warnings.push('All easy miles — consider adding one quality session');
    if (recovery > Math.ceil(total / 2) && total > 2)
      warnings.push('Lots of recovery runs — could signal accumulated fatigue');
  }

  return { total, quality, easy, long, tempo, workout, recovery, race, warnings };
}

/* ────────────────────────────────────────────
   Training Load: ATL / CTL / TSB
   ──────────────────────────────────────────── */

/**
 * Estimate Training Stress Score (TSS) for a single activity.
 * @param {object}      activity
 * @param {object|null} paces        - VDOT pace ranges { threshold:[lo,hi], ... }
 * @param {number|null} personMaxHR  - athlete's known max HR (from memory)
 */
function calculateTSS(activity, paces, personMaxHR) {
  const durationH = (activity.moving_time || 0) / 3600;
  if (durationH < 5 / 60) return 0;

  const avgHR    = activity.average_heartrate;
  const actMaxHR = activity.max_heartrate;
  const type     = (activity.type || '').toLowerCase();
  const cls      = activity._classification;

  let IF = 0.65;

  if (avgHR) {
    // Prefer athlete's known maxHR × 0.87 (lactate threshold), else activity maxHR × 0.90
    const threshHR = personMaxHR
      ? personMaxHR * 0.87
      : (actMaxHR ? actMaxHR * 0.90 : avgHR * 1.1);
    IF = avgHR / threshHR;
  } else if (activity.average_speed && /run/i.test(type)) {
    const avgPaceMPM = 1609.34 / activity.average_speed / 60;
    const threshPace = paces?.threshold
      ? (paces.threshold[0] + paces.threshold[1]) / 2
      : 7.5;
    IF = threshPace / avgPaceMPM;
  } else {
    const ifByCls = {
      'Recovery Run': 0.55, 'Easy Run': 0.65, 'Long Run': 0.65,
      'Tempo Run': 0.85, 'Workout': 0.95, 'Race': 1.0,
    };
    if (ifByCls[cls])                         IF = ifByCls[cls];
    else if (/ride|cycling/i.test(type))      IF = 0.70;
    else if (/swim/i.test(type))              IF = 0.75;
    else if (/weight|strength/i.test(type))   IF = 0.55;
  }

  IF = Math.min(Math.max(IF, 0.4), 1.15);
  return durationH * IF * IF * 100;
}

/**
 * Calculate ATL/CTL/TSB history over a 90-day window using exponential weighted averages.
 * Time constants: CTL=42d, ATL=7d (Coggan PMC). Walking 90 days lets the EWA warm up properly.
 * Returns { ctl, atl, tsb, history: [{date, tss, ctl, atl, tsb}] }
 */
function calculateTrainingLoad(activities, paces, personMaxHR) {
  const dailyTSS = {};
  activities.forEach(a => {
    const dateStr = new Date(a.start_date_local || a.start_date).toISOString().split('T')[0];
    dailyTSS[dateStr] = (dailyTSS[dateStr] || 0) + calculateTSS(a, paces, personMaxHR);
  });

  // Walk 90 days oldest→newest — longer window gives EWA time to converge
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const history = [];
  let ctl = 0, atl = 0;

  for (let i = 89; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    const tss = dailyTSS[dateStr] || 0;

    ctl = ctl + (tss - ctl) / 42;
    atl = atl + (tss - atl) / 7;

    history.push({
      date: dateStr,
      tss:  Math.round(tss),
      ctl:  Math.round(ctl * 10) / 10,
      atl:  Math.round(atl * 10) / 10,
      tsb:  Math.round((ctl - atl) * 10) / 10,
    });
  }

  const cur = history[history.length - 1];
  return { ctl: cur.ctl, atl: cur.atl, tsb: cur.tsb, history };
}

/**
 * Format the training load section for the system prompt.
 */
function buildTrainingLoadSection(load) {
  if (!load) return '';
  const ctl = load.ctl ?? '?';
  const atl = load.atl ?? '?';
  const tsb = load.tsb ?? '?';
  const tsbNum = typeof tsb === 'number' ? tsb : 0;
  const tsbSign = tsbNum > 0 ? '+' : '';

  const tsbInterp =
    tsbNum > 10  ? 'Fresh (possibly detrained — good race window)' :
    tsbNum >= -10 ? 'Optimal (good race window)' :
    tsbNum >= -20 ? 'Productive training stress' :
    'Deep fatigue — back off';

  const sourceLabel = load.source === 'intervals.icu'
    ? `(Intervals.icu · data date ${load.dataDate || 'today'})`
    : '(estimated from Strava HR/pace)';

  const rampLine = (load.rampRate != null)
    ? `Ramp rate: ${load.rampRate > 0 ? '+' : ''}${load.rampRate} CTL/week${load.rampRate > 5 ? ' ⚠️ AGGRESSIVE — injury risk elevated' : load.rampRate > 3 ? ' (moderate increase)' : ' (sustainable)'}\n`
    : '';

  return `\n## Training Load ${sourceLabel}
CTL (Fitness): ${ctl} | ATL (Fatigue): ${atl} | TSB (Form): ${tsbSign}${tsb}
Form status: ${tsbInterp}
${rampLine}`;
}

/**
 * Build the messages array for the Claude API, supporting multi-turn conversation.
 */
function buildMessages(history, currentMessage) {
  const lastItem = history[history.length - 1];
  if (lastItem && lastItem.role === 'user' && lastItem.content === currentMessage) {
    return history;
  }
  return [...history, { role: 'user', content: currentMessage }];
}

/* ── Historical analysis reader ─────────────────────────────────────────── */

/**
 * Read the longitudinal training intelligence text from KV.
 * Returns a plain string ready to embed in the system prompt, or null.
 * Fires in parallel with all other KV reads — adds zero net latency.
 */
async function getHistoryAnalysisFromKV(accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;

    const r    = await fetch(`${kvUrl}/get/${encodeURIComponent('history:' + athleteId + ':analysis')}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const data = await r.json();
    if (!data.result) return null;
    const stored = JSON.parse(data.result);
    return stored?.text || null;
  } catch (_) { return null; }
}

/* ── Intervals.icu wellness reader ──────────────────────────────────────── */

/**
 * Fetch real CTL/ATL/TSB from Intervals.icu, using KV cache (1-hour TTL).
 * Returns null if not configured or on any error.
 */
async function fetchIntervalsWellnessForChat() {
  const apiKey    = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;
  if (!apiKey || !athleteId) return null;

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const today   = new Date().toISOString().split('T')[0];
  const cacheKey = `intervals:${athleteId}:wellness:${today}`;

  // Check KV cache first
  if (kvUrl && kvToken) {
    try {
      const r    = await fetch(`${kvUrl}/get/${encodeURIComponent(cacheKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      const data = await r.json();
      if (data.result) {
        const cached = JSON.parse(data.result);
        if (cached && cached.available) return cached;
      }
    } catch (_) {}
  }

  const auth    = Buffer.from('API_KEY:' + apiKey).toString('base64');
  const headers = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
  const base    = `https://intervals.icu/api/v1/athlete/${athleteId}`;
  const oldest  = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  try {
    const wRes = await fetch(`${base}/wellness?oldest=${oldest}&newest=${today}`, { headers });
    if (!wRes.ok) return null;

    const wellnessData = await wRes.json();
    if (!Array.isArray(wellnessData) || !wellnessData.length) return null;

    const sorted  = [...wellnessData].sort((a, b) => b.id.localeCompare(a.id));
    const current = sorted.find(w => w.ctl != null) || {};

    const ctl      = current.ctl      != null ? Math.round(current.ctl)      : null;
    const atl      = current.atl      != null ? Math.round(current.atl)      : null;
    const tsb      = current.form     != null ? Math.round(current.form)
                   : (ctl != null && atl != null) ? ctl - atl : null;
    const rampRate = current.rampRate != null ? Math.round(current.rampRate * 10) / 10 : null;

    const history = wellnessData
      .filter(w => w.ctl != null)
      .map(w => {
        const c = Math.round(w.ctl || 0);
        const a = Math.round(w.atl || 0);
        return {
          date: w.id,
          ctl:  c,
          atl:  a,
          tsb:  w.form != null ? Math.round(w.form) : c - a,
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const result = {
      available: true,
      dataDate:  current.id || today,
      ctl, atl, tsb, rampRate, history,
      bestEfforts: null, // power-curves not fetched in chat path for speed
    };

    // Cache with 1-hour TTL
    if (kvUrl && kvToken) {
      try {
        await fetch(`${kvUrl}/pipeline`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify([['SET', cacheKey, JSON.stringify(result), 'EX', 3600]]),
        });
      } catch (_) {}
    }

    return result;
  } catch (_) {
    return null;
  }
}

/* ── Conversation memory ─────────────────────────────────────────────────── */

async function getConversationContext(accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;
  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;
    const log = await kvGet(kvUrl, kvToken, `memory:${athleteId}:conversations`);
    if (!Array.isArray(log) || !log.length) return null;

    // Last 10 conversations: recent 5 get rich format, older 5 get compact format
    const recent = log.slice(-10);
    const lines  = recent.map((e, i) => {
      const isCompact = i < recent.length - 5;
      const dateLabel = e.date || '?';
      const summary   = e.summary || e.note || ''; // backwards-compat with old {note} format
      if (isCompact || !summary) return `${dateLabel}: ${summary}`;
      const parts = [`${dateLabel}: ${summary}`];
      if (e.topics    && e.topics.length)    parts.push(`  Topics: ${e.topics.join(', ')}`);
      if (e.decisions && e.decisions.length) parts.push(`  Decided: ${e.decisions.join(', ')}`);
      if (e.feel)                            parts.push(`  Athlete feel: ${e.feel}`);
      return parts.join('\n');
    });
    return lines.join('\n\n');
  } catch (_) { return null; }
}

/**
 * Parse a <session-note> block from Claude's raw reply into a structured object.
 * Handles both the new structured format (summary/topics/decisions/feel lines)
 * and the old single-sentence format for backwards compatibility.
 */
function parseSessionNote(rawReply, fallbackMessage) {
  const match = rawReply.match(/<session-note>([\s\S]*?)<\/session-note>/);
  const today = new Date().toISOString().slice(0, 10);
  const ts    = new Date().toISOString();

  if (!match) {
    // No tag at all — use the user's message as a minimal summary
    return { date: today, ts, summary: fallbackMessage.trim().slice(0, 200), topics: [], decisions: [], feel: '' };
  }

  const body = match[1].trim();

  // Try to parse structured fields
  const get = (field) => {
    const re = new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'im');
    const m  = body.match(re);
    return m ? m[1].trim() : null;
  };

  const summary = get('summary');
  if (summary) {
    const topicsRaw    = get('topics');
    const decisionsRaw = get('decisions');
    const feel         = get('feel') || '';
    return {
      date:      today,
      ts,
      summary,
      topics:    topicsRaw    ? topicsRaw.split(',').map(s => s.trim()).filter(Boolean)    : [],
      decisions: decisionsRaw ? decisionsRaw.split(',').map(s => s.trim()).filter(Boolean) : [],
      feel,
    };
  }

  // Fallback: treat entire body as a plain summary (old single-sentence format)
  return { date: today, ts, summary: body.slice(0, 300), topics: [], decisions: [], feel: '' };
}

async function updateConversationLog(accessToken, sessionNote) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken || !sessionNote) return;
  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return;
    const key      = `memory:${athleteId}:conversations`;
    const existing = await kvGet(kvUrl, kvToken, key) || [];

    // Append this conversation as its own entry — never overwrite same-day entries.
    // Conversations from the same session (same ts minute) deduplicate against the last entry.
    const last = existing[existing.length - 1];
    const sameMinute = last && last.ts && sessionNote.ts &&
      last.ts.slice(0, 16) === sessionNote.ts.slice(0, 16);
    const base = sameMinute ? existing.slice(0, -1) : existing;

    // Keep 30 entries max. Entries beyond the most recent 10 are compressed to date+summary only.
    const updated = [...base, sessionNote]
      .slice(-30)
      .map((e, i, arr) => {
        if (i < arr.length - 10) {
          // Compress old entries: drop topics/decisions/feel to save KV space
          return { date: e.date, summary: e.summary || e.note || '' };
        }
        return e;
      });

    await fetch(`${kvUrl}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['SET', key, JSON.stringify(updated)]]),
    });
    console.log('[conv-log] saved for', athleteId, '(', updated.length, 'entries ):', (sessionNote.summary || '').slice(0, 60));
  } catch (e) {
    console.error('[conv-log] write failed:', e.message);
  }
}

async function saveChatMessages(accessToken, userMessage, coachReply) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return;
  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return;

    const key     = `memory:${athleteId}:chat-messages`;
    const today   = new Date().toISOString().slice(0, 10);
    const ts      = new Date().toISOString();
    let sessions  = (await kvGet(kvUrl, kvToken, key)) || [];
    if (!Array.isArray(sessions)) sessions = [];

    let todayIdx = sessions.findIndex(s => s.date === today);
    if (todayIdx === -1) {
      sessions.push({ date: today, messages: [] });
      todayIdx = sessions.length - 1;
    }

    sessions[todayIdx].messages.push(
      { role: 'user',  content: userMessage.slice(0, 2000), ts },
      { role: 'coach', content: coachReply.slice(0, 4000),  ts }
    );

    if (sessions[todayIdx].messages.length > 20) {
      sessions[todayIdx].messages = sessions[todayIdx].messages.slice(-20);
    }
    if (sessions.length > 5) {
      sessions = sessions.slice(-5);
    }

    await fetch(`${kvUrl}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['SET', key, JSON.stringify(sessions)]]),
    });
    console.log('[chat-messages] saved for', athleteId, 'session', today);
  } catch (e) {
    console.error('[chat-messages] write failed:', e.message);
  }
}

/* ── Threshold drift reader ──────────────────────────────────────────────── */

/**
 * Read cached threshold drift data from KV (written by /api/threshold-drift).
 * Returns null if not yet computed. Fires in parallel — zero net latency.
 */
async function getThresholdDriftFromKV(accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;
    const cacheKey = `threshold:${athleteId}:drift-cache`;
    const r    = await fetch(`${kvUrl}/get/${encodeURIComponent(cacheKey)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const data = await r.json();
    if (!data.result) return null;
    const parsed = JSON.parse(data.result);
    return parsed?.currentEstimate ? parsed : null;
  } catch (_) { return null; }
}

/* ── Oura Ring recovery data reader ─────────────────────────────────────── */

/**
 * Read cached Oura summary from KV (written by /api/oura with 12h TTL).
 * Returns null gracefully if Oura is not configured or data is not yet cached.
 * Fires in parallel with all other reads — zero net latency.
 */
async function getOuraDataFromKV(accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;
  if (!process.env.OURA_ACCESS_TOKEN) return null; // not configured — skip the lookup

  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;
    const today    = new Date().toISOString().split('T')[0];
    const cacheKey = `oura:${athleteId}:summary:v2:${today}`;
    const r    = await fetch(`${kvUrl}/get/${encodeURIComponent(cacheKey)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const data = await r.json();
    if (!data.result) return null;
    const parsed = JSON.parse(data.result);
    return parsed?.available ? parsed : null;
  } catch (_) { return null; }
}

/**
 * Compute derived recovery signals from cached Oura data and format a system
 * prompt section. Returns empty string when Oura is not available.
 *
 * Signals computed here are used by the RECOVERY INTERPRETATION rules in the prompt.
 */
function buildOuraSection(ouraData, trainingLoad) {
  if (!ouraData || !ouraData.available) return '';

  const r7 = ouraData.readiness7d || [];
  const s7 = ouraData.sleep7d     || [];
  const h7 = ouraData.hrv7d       || [];
  if (!r7.length && !s7.length) return '';

  // ── 7-day HRV baseline and today's deviation ──────────────────────────────
  const hrvVals7d     = s7.map(d => d.avgHrv).filter(v => v != null);
  const hrv7dBaseline = hrvVals7d.length
    ? Math.round(hrvVals7d.reduce((a, b) => a + b, 0) / hrvVals7d.length * 10) / 10
    : null;
  const todayHrvRaw   = s7.length ? s7[s7.length - 1]?.avgHrv : null;
  const hrv7dPct      = (hrv7dBaseline && todayHrvRaw != null)
    ? Math.round((todayHrvRaw - hrv7dBaseline) / hrv7dBaseline * 1000) / 10
    : null;

  // ── 7-day resting HR baseline and today's delta ───────────────────────────
  const hrVals7d          = s7.map(d => d.restingHr).filter(v => v != null);
  const restingHrBaseline = hrVals7d.length
    ? Math.round(hrVals7d.reduce((a, b) => a + b, 0) / hrVals7d.length * 10) / 10
    : null;
  const todayRestingHr    = s7.length ? s7[s7.length - 1]?.restingHr : null;
  const restingHrDelta    = (restingHrBaseline && todayRestingHr != null)
    ? Math.round((todayRestingHr - restingHrBaseline) * 10) / 10
    : null;

  // ── Consecutive nights with readiness < 55 (from most recent backward) ────
  let consecutivePoor = 0;
  for (let i = r7.length - 1; i >= 0; i--) {
    if ((r7[i].score ?? 100) < 55) consecutivePoor++;
    else break;
  }

  // ── 7-day HRV trend direction (compare first half avg vs second half avg) ─
  let hrvTrend = 'stable';
  let consecutiveDeclining = 0;
  if (h7.length >= 4) {
    const mid  = Math.floor(h7.length / 2);
    const avg  = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
    const fst  = h7.slice(0, mid).map(d => d.pctVsBaseline).filter(v => v != null);
    const snd  = h7.slice(mid).map(d => d.pctVsBaseline).filter(v => v != null);
    if (fst.length && snd.length) {
      const diff = avg(snd) - avg(fst);
      if (diff > 3)       hrvTrend = 'improving';
      else if (diff < -3) hrvTrend = 'declining';
    }
    // Count consecutive declining days (most recent → older)
    for (let i = h7.length - 1; i >= 1; i--) {
      if ((h7[i].pctVsBaseline ?? 0) < (h7[i - 1].pctVsBaseline ?? 0)) consecutiveDeclining++;
      else break;
    }
  }

  // ── Signal count for go/no-go ─────────────────────────────────────────────
  const tsb            = trainingLoad?.tsb ?? 0;
  const todayReadiness = ouraData.todayReadiness;

  const signal1 = hrv7dPct != null && hrv7dPct < -15;
  const signal2 = todayReadiness != null && todayReadiness < 55;
  const signal3 = restingHrDelta != null && restingHrDelta > 7;
  const signal4 = consecutivePoor >= 3;
  const signal5 = tsb < -25 && todayReadiness != null && todayReadiness < 60;
  const signalCount = [signal1, signal2, signal3, signal4, signal5].filter(Boolean).length;

  // ── Format readable 7-day rows ────────────────────────────────────────────
  const DAYS = ['Su','Mo','Tu','We','Th','Fr','Sa'];
  const dayLabel = dateStr => DAYS[new Date(dateStr + 'T12:00:00Z').getUTCDay()];

  const readinessRow = r7.map(d => `${dayLabel(d.day)}:${d.score ?? '?'}`).join(' ');
  const sleepRow     = s7.map(d => d.durationMin != null
    ? (d.durationMin / 60).toFixed(1) + 'h'
    : '?').join(' ');
  const hrv30Row     = h7.map(d => {
    if (d.pctVsBaseline == null) return '?';
    return (d.pctVsBaseline >= 0 ? '+' : '') + d.pctVsBaseline.toFixed(1) + '%';
  }).join(' ');

  const lines = [];
  lines.push(`\n## Recovery Data (Oura Ring)`);
  if (r7.length) {
    lines.push(`Readiness 7d (${r7[0].day}→${r7[r7.length-1].day}): ${readinessRow}`);
    const rLabel = todayReadiness >= 80 ? 'Ready' : todayReadiness >= 60 ? 'Moderate' : todayReadiness >= 55 ? 'Fair' : 'Low';
    lines.push(`Today readiness: ${todayReadiness ?? '?'}/100 [${rLabel}]`);
  }
  if (h7.length) {
    lines.push(`HRV vs 30-day baseline (7d): ${hrv30Row}`);
    lines.push(`HRV vs 7-day baseline today: ${hrv7dPct != null ? (hrv7dPct >= 0 ? '+' : '') + hrv7dPct + '%' : '?'} | 7-day trend: ${hrvTrend}${consecutiveDeclining >= 3 ? ` (${consecutiveDeclining} consecutive declining days)` : ''}`);
  }
  if (s7.length) {
    lines.push(`Sleep duration 7d: ${sleepRow}`);
    if (restingHrBaseline != null && todayRestingHr != null) {
      const sign = restingHrDelta >= 0 ? '+' : '';
      lines.push(`Resting HR: today ${todayRestingHr} bpm | 7-day avg ${restingHrBaseline} bpm (${sign}${restingHrDelta} bpm vs baseline)`);
    }
  }
  lines.push(`\nDerived signals (for go/no-go rules below):`);
  lines.push(`  [${signal1 ? 'X' : ' '}] HRV >15% below 7-day baseline${signal1 ? ` (${hrv7dPct}%)` : ''}`);
  lines.push(`  [${signal2 ? 'X' : ' '}] Readiness <55${signal2 ? ` (${todayReadiness})` : ''}`);
  lines.push(`  [${signal3 ? 'X' : ' '}] Resting HR >7bpm above baseline${signal3 ? ` (+${restingHrDelta} bpm)` : ''}`);
  lines.push(`  [${signal4 ? 'X' : ' '}] 3rd+ consecutive poor-sleep night${signal4 ? ` (${consecutivePoor} nights)` : ''}`);
  lines.push(`  [${signal5 ? 'X' : ' '}] TSB <-25 AND readiness <60${signal5 ? ` (TSB ${tsb}, readiness ${todayReadiness})` : ''}`);
  lines.push(`  Active signals: ${signalCount}/5${signalCount === 0 ? ' → proceed as planned' : signalCount === 1 ? ' → proceed, note lightly' : signalCount === 2 ? ' → suggest easier version' : ' → back off'}`);

  return lines.join('\n');
}

/* ── KV training summary reader ─────────────────────────────────────────── */

/**
 * Read the pre-built training history summary from KV.
 * Returns a plain-text string (or null if not yet synced / KV not configured).
 * Called in parallel with the Strava activities fetch — adds zero net latency.
 */
async function getTrainingSummaryFromKV(accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    // Re-use the cached athlete ID if available, otherwise fetch
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;

    const r    = await fetch(`${kvUrl}/get/${encodeURIComponent('training_summary:' + athleteId)}`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    const data = await r.json();
    if (!data.result) return null;
    const stored = JSON.parse(data.result);
    if (!stored?.v || stored.v < 2) return null; // stale pre-90d entry
    return stored?.text || null;
  } catch (_) { return null; }
}

/* ═══════════════════════════════════════════════════════════════════════════
   HISTORICAL QUERY ENGINE
   Detects when the user is asking about a past training period, fetches the
   relevant pre-computed block from KV, and formats it for Claude's context.
   Runs in parallel with all other data fetches — zero added latency on
   normal (non-historical) questions.
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Parse the user's message to detect if they're asking about a specific past
 * training period. Returns a query descriptor or null if not a historical query.
 */
function detectHistoricalQuery(message) {
  const lower = message.toLowerCase();

  // Named-race lookup — checked FIRST so race name alone is sufficient historical signal.
  // e.g. "how was my Houston build?" doesn't need to match HISTORY_PHRASES.
  const RACE_PATTERNS = [
    { re: /\beugene\b/i,                          label: 'Eugene Marathon',         approxMonth: 4  },
    { re: /\bboston\b/i,                          label: 'Boston Marathon',         approxMonth: 4  },
    { re: /\bchicago\b/i,                         label: 'Chicago Marathon',        approxMonth: 10 },
    { re: /\b(new york|nyc)\b/i,                  label: 'NYC Marathon',            approxMonth: 11 },
    { re: /\bcim\b|california international/i,    label: 'CIM',                     approxMonth: 12 },
    { re: /\bmarine corps\b/i,                    label: 'Marine Corps Marathon',   approxMonth: 10 },
    { re: /\blos\s*angeles\b|(?<!\w)la marathon/i, label: 'LA Marathon',            approxMonth: 3  },
    { re: /\bberlin\b/i,                          label: 'Berlin Marathon',         approxMonth: 9  },
    { re: /\blondon\b/i,                          label: 'London Marathon',         approxMonth: 4  },
    { re: /\bsugarloaf\b/i,                       label: 'Sugarloaf Marathon',      approxMonth: 5  },
    { re: /\bhouston\b/i,                         label: 'Houston Marathon',        approxMonth: 1  },
    { re: /\bdallas\b/i,                          label: 'Dallas Marathon',         approxMonth: 12 },
    { re: /\bphoenix\b/i,                         label: 'Phoenix Marathon',        approxMonth: 2  },
    { re: /\bgrandma'?s\b/i,                      label: "Grandma's Marathon",      approxMonth: 6  },
    { re: /\bvermont\s+city\b/i,                  label: 'Vermont City Marathon',   approxMonth: 5  },
    { re: /\bwashington\s+dc\b|\bdc\s+marathon\b/i, label: 'DC Marathon',          approxMonth: 3  },
    { re: /\bportland\b/i,                        label: 'Portland Marathon',       approxMonth: 10 },
    { re: /\bseattle\b/i,                         label: 'Seattle Marathon',        approxMonth: 11 },
    { re: /\bdenver\b/i,                          label: 'Denver Marathon',         approxMonth: 10 },
    { re: /\bminneapolis\b|twin\s+cities\b/i,     label: 'Twin Cities Marathon',    approxMonth: 10 },
  ];
  for (const rp of RACE_PATTERNS) {
    if (rp.re.test(message)) {
      const yearMatch = message.match(/\b(20\d{2})\b/);
      return {
        type:        'named-race',
        raceLabel:   rp.label,
        approxMonth: rp.approxMonth,
        year:        yearMatch ? parseInt(yearMatch[1]) : null,
      };
    }
  }

  // For non-race-name queries, require an explicit historical phrase to avoid false positives
  const HISTORY_PHRASES = [
    'buildup', 'build up', 'training block', 'before my', 'last fall', 'last spring',
    'last summer', 'last winter', 'last year', 'what did i', 'what were my',
    'how was my training', 'how did my', 'how was my', 'show me my', 'tell me about my',
    'that block', 'that training', 'those weeks',
    'in 2024', 'in 2023', 'in 2022', 'in 2025', 'in 2026',
    'spring 2024', 'spring 2023', 'spring 2025', 'spring 2022',
    'fall 2024',   'fall 2023',   'fall 2025',   'fall 2022',
    'summer 2024', 'summer 2023', 'summer 2025', 'summer 2022',
    'winter 2024', 'winter 2023', 'winter 2025', 'winter 2022',
    'the build', 'the buildup', 'my build', 'best block', 'peak training',
    'highest mileage block', 'best marathon training',
  ];
  if (!HISTORY_PHRASES.some(p => lower.includes(p))) return null;

  // Generic fallback: detect any "CityName [marathon|build|buildup|block]" not in the named list.
  // Uses original-case message to identify proper nouns (capitalized words).
  const genericRaceRe = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\s+(?:[Mm]arathon|[Hh]alf(?:\s+[Mm]arathon)?|build(?:up)?|[Tt]raining\s+[Bb]lock)\b/;
  const genericMatch  = message.match(genericRaceRe);
  if (genericMatch) {
    const raceName  = genericMatch[1].trim();
    const yearMatch2 = message.match(/\b(20\d{2})\b/);
    return {
      type:        'named-race',
      raceLabel:   raceName + ' Marathon',
      approxMonth: null,
      year:        yearMatch2 ? parseInt(yearMatch2[1]) : null,
    };
  }

  // "before my [time] [distance]" — find matching race from history
  const beforeMatch = lower.match(/before (?:my|the) (\d+:\d+(?::\d+)?) (marathon|half(?:\s*marathon)?|10k|5k)/);
  if (beforeMatch) {
    return { type: 'race-by-time', raceTime: beforeMatch[1], distance: beforeMatch[2].replace(/\s+/g, ' ').trim() };
  }

  // Season detection ("last fall", "spring 2024", "summer training")
  const seasonMatch = lower.match(/(last|this)?\s*(spring|summer|fall|autumn|winter)(?:\s+(?:of\s+)?(\d{4}))?/);
  if (seasonMatch) {
    const qualifier = (seasonMatch[1] || '').trim();
    const season    = seasonMatch[2] === 'autumn' ? 'fall' : seasonMatch[2];
    const yearStr   = seasonMatch[3];
    const today     = new Date();
    const curYear   = today.getFullYear();

    let year;
    if (yearStr) {
      year = parseInt(yearStr);
    } else if (qualifier === 'last') {
      const SEASON_MONTH = { spring: 2, summer: 5, fall: 8, winter: 11 };
      year = today.getMonth() <= (SEASON_MONTH[season] || 0) ? curYear - 1 : curYear;
    } else {
      year = curYear;
    }
    return { type: 'season', season, year };
  }

  // Year only ("in 2024", "during 2023")
  const yearMatch = lower.match(/(?:^|\s)(?:in|during|throughout|all of|from)\s+(20\d{2})\b/);
  if (yearMatch) return { type: 'year', year: parseInt(yearMatch[1]) };

  // Best-ever block
  if (lower.includes('best block') || lower.includes('peak training') ||
      lower.includes('best marathon training') || lower.includes('highest mileage block')) {
    return { type: 'best-block' };
  }

  return null;
}

/**
 * Convert a query descriptor to a {start, end} date-string range.
 */
function queryToDateRange(query) {
  const SEASON_RANGES = {
    spring: { sm: 2, sd: 1,  em: 4, ed: 31 },
    summer: { sm: 5, sd: 1,  em: 7, ed: 31 },
    fall:   { sm: 8, sd: 1,  em: 10, ed: 30 },
    winter: null, // handled separately
  };
  const pad = n => String(n).padStart(2, '0');

  if (query.type === 'season') {
    const yr = query.year;
    if (query.season === 'winter') {
      return { start: `${yr}-12-01`, end: `${yr + 1}-02-28` };
    }
    const r = SEASON_RANGES[query.season];
    if (!r) return null;
    return { start: `${yr}-${pad(r.sm + 1)}-01`, end: `${yr}-${pad(r.em + 1)}-${r.ed}` };
  }
  if (query.type === 'year') {
    return { start: `${query.year}-01-01`, end: `${query.year}-12-31` };
  }
  return null;
}

/** Parse "2:55:30" or "2:55" into total minutes. */
function parseTimeStrMins(t) {
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.length === 3) return parts[0] * 60 + parts[1] + parts[2] / 60;
  if (parts.length === 2) return parts[0] + parts[1] / 60;
  return null;
}

/**
 * Main entry point: resolve a historical query into a pre-computed block from KV
 * and return it as a formatted string for the system prompt, or null.
 */
async function getHistoricalBlock(accessToken, query) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;

    if (query.type === 'named-race' || query.type === 'race-by-time' || query.type === 'best-block') {
      return getRaceBlockText(athleteId, query, kvUrl, kvToken, accessToken);
    }
    return getDateRangeBlockText(athleteId, query, kvUrl, kvToken, accessToken);
  } catch (_) {
    return null;
  }
}

async function getRaceBlockText(athleteId, query, kvUrl, kvToken, accessToken) {
  // Read race-index and full analysis in parallel.
  // Race-index may not exist yet (built lazily on first Insights tab visit).
  // When missing, fall back to analysis.races so the coach still has context.
  const [indexData, analysisData] = await Promise.all([
    kvGet(kvUrl, kvToken, `history:${athleteId}:race-index`),
    kvGet(kvUrl, kvToken, `history:${athleteId}:analysis`),
  ]);

  let races = indexData?.races;
  if (!races || !races.length) {
    if (!analysisData?.races?.length) return null;
    races = analysisData.races
      .filter(r => r.id)
      .map(r => ({ id: r.id, date: r.date, name: r.name, label: r.label,
                   distMi: r.distMi, timeStr: r.timeStr, paceStr: r.paceStr }));
  }
  if (!races || !races.length) return null;

  let target = null;

  if (query.type === 'named-race') {
    // Match by label or name, filter by year if specified
    const labelRe = new RegExp(
      (query.raceLabel || '').split(/\s+/).filter(Boolean).join('.*'),
      'i'
    );
    let matches = races.filter(r => labelRe.test(r.name) || labelRe.test(r.label || ''));

    if (query.year) {
      const yearStr = String(query.year);
      const withYear = matches.filter(r => r.date.startsWith(yearStr));
      matches = withYear.length ? withYear : matches; // fall back if no exact year match
    }
    if (!matches.length && query.year && query.approxMonth) {
      // Fuzzy: any marathon within ±2 months of expected race month in that year
      const mo = query.approxMonth;
      matches = races.filter(r => {
        if (!r.date.startsWith(String(query.year))) return false;
        const rMo = parseInt(r.date.slice(5, 7));
        return Math.abs(rMo - mo) <= 2 && r.distMi >= 12;
      });
    }
    target = matches.sort((a, b) => b.date.localeCompare(a.date))[0];

  } else if (query.type === 'race-by-time') {
    const targetMins = parseTimeStrMins(query.raceTime);
    const DIST_MAP   = { marathon: 26.2, 'half marathon': 13.1, 'half': 13.1, '10k': 6.2, '5k': 3.1 };
    const targetDist = DIST_MAP[query.distance] || 26.2;
    if (targetMins) {
      target = races
        .filter(r => {
          const rMins = parseTimeStrMins(r.timeStr);
          return r.distMi >= targetDist * 0.9 && r.distMi <= targetDist * 1.1 &&
                 rMins && Math.abs(rMins - targetMins) < 10;
        })
        .sort((a, b) => b.date.localeCompare(a.date))[0];
    }

  } else if (query.type === 'best-block') {
    // Fastest marathon (lowest time)
    const marathons = races.filter(r => r.distMi >= 25);
    target = marathons.sort((a, b) =>
      (parseTimeStrMins(a.timeStr) || 999) - (parseTimeStrMins(b.timeStr) || 999)
    )[0];
    if (!target) {
      target = races.sort((a, b) =>
        (parseTimeStrMins(a.paceStr) || 99) - (parseTimeStrMins(b.paceStr) || 99)
      )[0];
    }
  }

  if (!target || !target.id) return null;

  // Read pre-computed race block
  const block = await kvGet(kvUrl, kvToken, `history:${athleteId}:race-block:${target.id}`);

  if (block) {
    const topQ = (block.allQuality || []).slice(0, 8);
    await enrichWithLapData(topQ, athleteId, kvUrl, kvToken, accessToken);
    return formatRaceBlock(block, topQ);
  }

  // race-block not yet built (analysis rebuild pending) — fall back to preRace
  // stats from the analysis object, which have the key training load numbers.
  const raceDetail = analysisData?.races?.find(r => r.id === target.id);
  if (raceDetail) return formatRaceBlockFallback(raceDetail);

  return null;
}

async function getDateRangeBlockText(athleteId, query, kvUrl, kvToken, accessToken) {
  const range = queryToDateRange(query);
  if (!range) return null;

  const qIdx = await kvGet(kvUrl, kvToken, `history:${athleteId}:quality-index`);
  if (!qIdx || !qIdx.sessions || !qIdx.sessions.length) return null;

  const sessions    = qIdx.sessions.filter(s => s.d >= range.start && s.d <= range.end);
  const topSessions = sessions.slice(-10);

  await enrichWithLapData(topSessions, athleteId, kvUrl, kvToken, accessToken);

  return formatDateRangeBlock(range, sessions.length, topSessions);
}

/**
 * Given an array of quality-session objects {id, d, nm, mi, pa, hr},
 * populate .lapSummary on each by reading KV cache first, then fetching
 * live from Strava for any sessions still missing data (up to 5 at a time).
 * Results are stored back to KV so subsequent requests are instant.
 * Mutates the sessions array in place.
 */
async function enrichWithLapData(sessions, athleteId, kvUrl, kvToken, accessToken) {
  if (!sessions || !sessions.length) return;

  // Read KV in parallel
  const lapDatas = await Promise.all(
    sessions.map(s => kvGet(kvUrl, kvToken, `laps:${athleteId}:${s.id}`))
  );

  // Apply whatever is already cached
  lapDatas.forEach((ld, i) => {
    if (!ld) return;
    if (ld.hardEffortSummary)       sessions[i].lapSummary = ld.hardEffortSummary;
    else if (ld.pattern?.description) sessions[i].lapSummary = ld.pattern.description;
  });

  // Fetch live from Strava for sessions still missing data (up to 5)
  if (!accessToken) return;
  const missingIdxs = lapDatas
    .map((ld, i) => (!ld || ld.v < 2) ? i : null)
    .filter(i => i !== null)
    .slice(0, 5);

  if (!missingIdxs.length) return;

  const liveResults = await Promise.all(
    missingIdxs.map(async (i) => {
      const s = sessions[i];
      try {
        const r = await fetch(
          `https://www.strava.com/api/v3/activities/${s.id}/laps`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (!r.ok || r.status === 429) return null;
        const rawLaps = await r.json();
        if (!Array.isArray(rawLaps) || rawLaps.length < 2) return null;

        const classified = classifyLaps(rawLaps, 7.5);
        const pattern    = detectPattern(classified);

        let hardEffortSummary = null;
        if (pattern?.description && pattern.description !== 'Insufficient lap data') {
          const hardLaps = classified.filter(
            l => l.classification === 'Interval' || l.classification === 'Hard'
          );
          const hrVals   = hardLaps.map(l => l.hr).filter(Boolean);
          const hrSuffix = hrVals.length
            ? ' · HR ' + Math.round(hrVals.reduce((a, b) => a + b, 0) / hrVals.length)
            : '';
          hardEffortSummary = pattern.description + hrSuffix;
        }

        const entry = {
          v: 2, activityId: s.id, laps: classified, pattern,
          hardEffortSummary, source: 'chat-on-demand', analyzedAt: Date.now(),
        };
        kvWrite(kvUrl, kvToken, `laps:${athleteId}:${s.id}`, entry);
        return entry;
      } catch (_) { return null; }
    })
  );

  missingIdxs.forEach((qi, j) => {
    const ld = liveResults[j];
    if (!ld || sessions[qi].lapSummary) return;
    if (ld.hardEffortSummary)        sessions[qi].lapSummary = ld.hardEffortSummary;
    else if (ld.pattern?.description) sessions[qi].lapSummary = ld.pattern.description;
  });
}

function fmtHistPace(pa) {
  if (!pa) return '?:??';
  const m = Math.floor(pa);
  const s = Math.round((pa - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatRaceBlock(block, enrichedQ) {
  const lines = [];
  const label = block.raceName || block.raceLabel || 'Race';

  lines.push(`## HISTORICAL TRAINING BLOCK — ${label.toUpperCase()} BUILDUP`);
  lines.push(`Race: ${block.raceName} · ${block.raceDate} · ${block.timeStr} (${block.paceStr}/mi)`);
  if (block.preRace) {
    const p = block.preRace;
    lines.push(
      `Build stats: avg ${p.avgWeeklyMi}mi/wk · peak week ${p.peakWeekMi}mi · ` +
      `${p.qualityCount} quality sessions · ${p.lastHardDaysOut ? `last hard run ${p.lastHardDaysOut}d before race` : ''}`
    );
  }
  lines.push('');

  if (block.weeks && block.weeks.length) {
    lines.push('WEEKLY MILEAGE (weeks out from race):');
    block.weeks.forEach(wk => {
      const qNote = wk.quality.length ? ` · ${wk.quality.length} quality` : '';
      lines.push(`  Week −${wk.weeksOut}: ${wk.miles}mi · ${wk.runs} runs${qNote}`);
    });
    lines.push('');
  }

  if (enrichedQ && enrichedQ.length) {
    lines.push('KEY QUALITY SESSIONS (most recent first):');
    enrichedQ.forEach(s => {
      const lap = s.lapSummary ? ` → ${s.lapSummary}` : '';
      lines.push(`  ${s.d}: "${s.nm}" ${s.mi}mi @ ${fmtHistPace(s.pa)}/mi avg${lap}`);
    });
    lines.push('');
  }

  lines.push(
    'Use this data to answer the question. You have the full 12-week weekly mileage breakdown ' +
    'and the key quality sessions (date, distance, avg pace). Sessions marked with → have ' +
    'lap-level detail; others have activity-level data only — use the avg pace and distance to ' +
    'characterize the effort. Do NOT say you lack workout data. Reference specific weeks, ' +
    'mileage totals, session paces, and taper timing. Compare to current training where relevant.'
  );
  return lines.join('\n');
}

/**
 * Simplified race block when the full race-block KV entry hasn't been built yet.
 * Uses the preRace stats stored in the analysis object (confirmed accurate).
 */
function formatRaceBlockFallback(race) {
  const lines = [];
  const label = race.name || race.label || 'Race';
  lines.push(`## HISTORICAL TRAINING BLOCK — ${label.toUpperCase()} BUILDUP`);
  lines.push(`Race: ${race.name} · ${race.date} · ${race.timeStr} (${race.paceStr}/mi)${race.hr ? ` · HR ${race.hr}` : ''}`);
  if (race.preRace) {
    const p = race.preRace;
    lines.push(
      `8-week build: avg ${p.avgWeeklyMi}mi/wk · peak week ${p.peakWeekMi}mi · ` +
      `${p.qualityCount} quality sessions (pace < 8:00/mi)` +
      (p.lastHardDaysOut ? ` · last hard run ${p.lastHardDaysOut}d before race` : '')
    );
  }
  lines.push('');
  lines.push(
    'Use these confirmed training stats to answer the question. You have: race result, ' +
    'avg weekly mileage, peak week, quality session count, and taper timing. ' +
    'These are enough to describe the training block accurately — be specific about the numbers. ' +
    'Do NOT say you lack workout data or individual workout breakdowns. ' +
    'Detailed per-week and per-session data will be available after a background rebuild.'
  );
  return lines.join('\n');
}

function formatDateRangeBlock(range, totalCount, sessions) {
  const lines = [];
  lines.push(`## HISTORICAL QUALITY SESSIONS — ${range.start} to ${range.end}`);
  lines.push(`${totalCount} quality runs (pace < 8:00/mi, ≥ 3mi) in this period. Most recent ${sessions.length} shown:`);
  lines.push('');
  sessions.slice().reverse().forEach(s => {
    const lap = s.lapSummary ? ` → ${s.lapSummary}` : '';
    lines.push(`  ${s.d}: "${s.nm}" ${s.mi}mi @ ${fmtHistPace(s.pa)}/mi${lap}`);
  });
  lines.push('');
  lines.push('Use this historical data to answer the athlete\'s question about this period.');
  return lines.join('\n');
}
