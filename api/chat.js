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
  const fortyTwoDaysAgo = Math.floor((Date.now() - 42 * 24 * 60 * 60 * 1000) / 1000);
  let activities        = [];
  let trainingSummary   = null;
  let intervalsWellness = null;
  let historyAnalysis   = null;

  try {
    // Fetch all data sources in parallel
    const [stravaRes, kvSummary, iWellness, histAnalysis] = await Promise.all([
      fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${fortyTwoDaysAgo}&per_page=100`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ),
      getTrainingSummaryFromKV(accessToken),
      fetchIntervalsWellnessForChat(),
      getHistoryAnalysisFromKV(accessToken),
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

    trainingSummary   = kvSummary;
    intervalsWellness = iWellness;
    historyAnalysis   = histAnalysis;
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

  /* ── Format activities for Claude (most recent 30 for prompt size) ── */
  const recentActivities = activities.slice(0, 30);
  const activitySummary = formatActivities(recentActivities);

  /* ── Build conversation history for Claude ── */
  // Sanitize history: only keep valid role/content pairs
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8); // max 4 exchanges

  // The current message should be the last user turn
  // If history already ends with the current message, use it as-is; otherwise append
  const messages = buildMessages(safeHistory, message.trim());

  /* ── Call Claude ── */
  const systemPrompt = buildSystemPrompt(activitySummary, recentActivities.length, memory, trainingLoad, trainingSummary, historyAnalysis);

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json'
      },
      body: JSON.stringify({
        model:      'claude-opus-4-6',
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
    const reply = claudeData.content?.[0]?.text;

    if (!reply) {
      return res.status(502).json({ error: 'Empty response from AI. Please try again.' });
    }

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

  // Objective criteria — no classification gating
  function meetsLapCriteria(a) {
    if (!isRun(a)) return false;
    const distMi  = (a.distance || 0) / 1609.34;
    const avgMPM  = a.average_speed ? 1609.34 / a.average_speed / 60 : 99;
    const maxHR   = a.max_heartrate  || 0;
    const suffer  = a.suffer_score   || 0;
    const labeled = a.workout_type === 1 || a.workout_type === 3;
    return distMi > 6 || avgMPM < 8.5 || suffer > 50 || maxHR > 160 || labeled;
  }

  const candidates = activities.filter(meetsLapCriteria).slice(0, 20);
  const candidateIds = new Set(candidates.map(a => a.id));

  // Mark runs that won't have laps fetched so Claude knows why
  activities.forEach(a => {
    if (!isRun(a)) return;
    if (!candidateIds.has(a.id)) {
      a._lapStatus = 'skipped';
      const distMi = ((a.distance || 0) / 1609.34).toFixed(1);
      const avgMPM = a.average_speed ? 1609.34 / a.average_speed / 60 : null;
      const paceStr = avgMPM ? fmtPace(avgMPM) : '?:??';
      a._lapSkipReason = `${distMi}mi @ ${paceStr}/mi — below threshold`;
    }
  });

  if (!candidates.length) return;

  let athleteId = null;
  if (kvUrl && kvToken) {
    athleteId = await getAthleteIdOnce(accessToken);
  }

  // Process in batches of 5 with 100ms pause between batches
  for (let bStart = 0; bStart < candidates.length; bStart += 5) {
    const batch = candidates.slice(bStart, bStart + 5);

    await Promise.all(batch.map(async (a) => {
      try {
        // 1. KV cache — v2+ only; v1 entries had wrong unit formatting and are discarded
        if (kvUrl && kvToken && athleteId) {
          const cached = await kvGet(kvUrl, kvToken, `laps:${athleteId}:${a.id}`);
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
            return;
          }
        }

        // 2. Fetch live from Strava
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
          a._lapStatus = 'insufficient'; // Strava returned ≤1 lap
        }
      } catch (_) {
        a._lapStatus = 'error';
      }
    }));

    if (bStart + 5 < candidates.length) {
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
function formatActivities(activities) {
  if (!activities || activities.length === 0) {
    return 'No activities found in the last 30 days.';
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

    return `• ${date}: ${a.type}${tag} ${name}${dist}${dur}${pace}${weatherAdj}${hr}${maxHR}${elevFt}${suffer}${kudos}${laps}`;
  });

  return lines.join('\n');
}

/**
 * Build the system prompt for Claude.
 */
function buildSystemPrompt(activitySummary, count, memory, trainingLoad, trainingSummary, historyAnalysis) {
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const memorySection        = buildMemorySection(memory);
  const loadSection          = buildTrainingLoadSection(trainingLoad);
  const historySection       = trainingSummary
    ? `\n## Training History (lap analysis · 90 days)\n${trainingSummary}\n`
    : '';
  const longitudinalSection  = historyAnalysis
    ? `\n${historyAnalysis}\n`
    : '';

  return `You are an elite running coach with deep expertise in marathon and distance running. You coach experienced runners targeting sub-3 hour marathons and faster. You do not give generic advice. Every response is grounded in the athlete's actual Strava data.

Today's date: ${now}
${memorySection}${loadSection}${historySection}${longitudinalSection}
## Recent Strava Activities (last 42 days, ${count} shown)
${activitySummary}

## DATA HIERARCHY — NON-NEGOTIABLE
You have TWO data sources for each activity:
(a) Recent Activities list — overall avg pace/HR/distance for the full run
(b) Training History — lap-level analysis with per-rep paces and workout structure

ALWAYS cross-reference both. If Training History shows interval structure for an activity that the Recent Activities list shows as a slow average pace — trust the Training History. A 10-mile run averaging 7:43/mile that contains 5×0.98mi at 6:16/mile is an interval workout, not an easy run. The blended average is irrelevant for characterizing workout type or effort.

Before describing any workout, check: does Training History have lap data for this activity? If yes, use that as the primary description.

Priority order when data sources exist:
1. Training History lap analysis (most accurate — per-rep distances, paces, recovery)
2. Activity lap splits ("ACTUAL WORKOUT PACE" and "Laps:" lines in the activity)
3. Overall activity average (NEVER use to characterize workout intensity)

Blended average rule: When an activity shows "blended avg X/mi (warmup+recovery included — NOT workout pace)", that figure is meaningless for describing workout quality. The actual rep pace is in the "ACTUAL WORKOUT PACE" line. Always lead with the rep pace. Example: "Your 10-mile workout had 5 reps at 6:16/mi with recovery jogs at 8:45/mi — the blended 7:43/mi overall includes warmup and cooldown."

Training History is authoritative: If Training History states hard efforts at a specific pace, that IS the answer. Do not contradict it with activity-level averages. If stats seem to conflict, trust the lap analysis and explain: "Your overall avg was 7:43/mi — your actual rep pace was 6:16/mi."

## COACHING FRAMEWORKS

JACK DANIELS (primary framework):
- All training paces derived from VDOT. Five zones: Easy (59-74% vVO2max), Marathon (75-84%), Threshold (83-88%), Interval (95-100%), Repetition (105-120%)
- Threshold runs: 20-30 min continuous OR cruise intervals (5×1mi with 1min rest). Never longer than 30 min at T-pace.
- Interval sessions: 3-5 min hard with equal recovery. Total interval volume per session = 8% of weekly mileage max.
- Easy days must be truly easy — 59-74% vVO2max. Most runners run easy days too fast. Check HR drift.
- Quality sessions: max 2 per week for most runners. 3 only for high-mileage athletes (70+ mpw).

PETE PFITZINGER:
- Lactate threshold is the most trainable fitness component for marathoners
- Medium-long runs (13-17mi) are underutilized — more specific than easy runs, less costly than long runs
- Long runs at 10-20% slower than marathon pace
- Recovery weeks every 3-4 weeks, drop volume 20-30%
- 18-week marathon plans peak at 55-70+ mpw for sub-3 runners
- Key workouts: LT intervals, marathon-pace long runs, progressive long runs

RENATO CANOVA:
- Specific endurance: train at or near race pace as fitness builds
- Fundamental → Special → Specific periodization
- Long tempo runs (10-15 miles at marathon pace) for advanced marathoners
- Competition as training — races within training blocks
- Volume before intensity in annual plan

HANSONS METHOD:
- Cumulative fatigue is intentional — trains the body to run on tired legs
- Long run capped at 16 miles (26% of weekly volume max)
- Tempo = marathon pace, not threshold pace (key difference from Daniels)
- Back-to-back quality days are intentional

POLARIZED TRAINING (Seiler/Norwegian model):
- 80% of runs at truly easy effort (Zone 1-2, below LT1)
- 20% at high intensity (Zone 4-5, above LT2). Minimal time in Zone 3 (the "grey zone")
- Sub-threshold doubles: two easy runs beats one moderate run
- LT1 is the most important threshold for aerobic base development

LETSRUN / r/AdvancedRunning PRINCIPLES:
- Consistency over heroics — missing a workout matters less than cumulative training
- Most recreational elites are injured by too much too soon, not too little
- Strides are underused — 4-6×20 sec after easy runs builds speed without fatigue cost
- Doubles only make sense above 60 mpw
- HR can vary 5-10 bpm day to day — chase effort, not pace
- "The best training plan is the one you can do consistently"

## HOW TO APPLY THE FRAMEWORKS

WORKOUT SUGGESTIONS — always specify all of:
- Distance, pace (MM:SS/mile from VDOT), rest intervals, total volume
- Which coaching principle you're applying and why (e.g. "Daniels T-pace cruise intervals")
- Whether it conflicts with recent training load or TSB
- Example: "Daniels T-pace cruise intervals: 5×1 mile at 6:48/mile with 60s rest. Total threshold volume: 5 miles (within 10% of weekly mileage). You last did threshold work 6 days ago — good spacing. [Pfitzinger: fits your LT development phase before the peak block.]"

WHEN ANALYZING RUNS:
- Never use blended average pace to characterize a workout — always use lap data
- Compare actual paces to VDOT-predicted paces and name the discrepancy
- Flag if easy runs are too fast (above 74% vVO2max or too close to marathon pace)
- Flag if workouts are too slow (below 95% vVO2max for intervals)

TRAINING LOAD INTERPRETATION:
- TSB -10 to +5: optimal training window
- TSB +10 or higher: athlete is fresh — consider adding a quality session
- TSB -20 or lower: back off, injury risk elevated
- CTL rising more than 5 points/week: too aggressive
- ACWR above 1.3: caution; above 1.5: reduce load immediately

MARATHON-SPECIFIC RULES:
- Long runs peak at 20-22 miles for sub-3 runners
- Marathon-pace miles in long runs: start at 25% MP miles, build to 50% in peak weeks
- Last long run: 3 weeks before race, 20 miles max
- Taper: 3 weeks, reduce volume not intensity
- Do not introduce new workout types in the final 6 weeks

WHAT YOU NEVER DO:
- Give vague advice ("run easy today") without specifying pace, duration, purpose
- Ignore the athlete's actual data when making suggestions
- Recommend the same workout structure two sessions in a row
- Suggest intensity when TSB is below -20
- Praise every workout — be honest if a run was too fast, too slow, or too long
- Use blended average pace to describe a workout that has lap variation

## TONE AND FORMAT
- Direct and honest — this is a mobile chat with an experienced runner, not a beginner report
- Use specific numbers from the data. If a run was at 8:12/mi easy pace but their VDOT easy ceiling is 8:30/mi, say so.
- Keep responses concise (2-4 short paragraphs) unless asked for detail
- Use bullets or numbered lists for multi-step advice
- Always use imperial units: miles, feet, mph, min/mile. Never km or km/h.
- When suggesting a shoe, name one from the athlete's Shoes list matched to workout type, with its current mileage.

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
</memory-update>`;
}

/**
 * Format the stored memory into a readable system prompt section.
 */
function buildMemorySection(memory) {
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
 * Calculate 42-day ATL/CTL/TSB history using exponential weighted averages.
 * Returns { ctl, atl, tsb, history: [{date, tss, ctl, atl, tsb}] }
 */
function calculateTrainingLoad(activities, paces, personMaxHR) {
  const dailyTSS = {};
  activities.forEach(a => {
    const dateStr = new Date(a.start_date_local || a.start_date).toISOString().split('T')[0];
    dailyTSS[dateStr] = (dailyTSS[dateStr] || 0) + calculateTSS(a, paces, personMaxHR);
  });

  // Walk 42 days oldest→newest, computing EWA
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const history = [];
  let ctl = 0, atl = 0;

  for (let i = 41; i >= 0; i--) {
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
  const oldest  = new Date(Date.now() - 42 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

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
    return stored?.text || null;
  } catch (_) { return null; }
}
