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

  /* ── Parallel: fetch Strava activities + training summary from KV ── */
  const fortyTwoDaysAgo = Math.floor((Date.now() - 42 * 24 * 60 * 60 * 1000) / 1000);
  let activities     = [];
  let trainingSummary = null;

  try {
    // Fetch Strava activities + training summary from KV in parallel
    const [stravaRes, kvSummary] = await Promise.all([
      fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${fortyTwoDaysAgo}&per_page=100`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ),
      getTrainingSummaryFromKV(accessToken),
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

    trainingSummary = kvSummary;
  } catch (err) {
    console.error('Strava fetch error:', err);
    return res.status(502).json({ error: 'Network error fetching Strava data.' });
  }

  /* ── Classify runs & compute weekly balance + training load ── */
  const athletePaces = memory?.paces  || null;
  const athleteMaxHR = memory?.maxHR  || null;
  const hrZones      = getHRZones(athleteMaxHR);
  classifyActivities(activities, athletePaces, hrZones);
  const weeklyBalance = getWeeklyBalance(activities);
  const trainingLoad  = calculateTrainingLoad(activities, athletePaces, athleteMaxHR);

  /* ── Fetch lap data for recent workouts & races (up to 5, in parallel) ── */
  await attachLapsToWorkouts(activities, accessToken);

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
  const systemPrompt = buildSystemPrompt(activitySummary, recentActivities.length, memory, trainingLoad, trainingSummary);

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
 * Attach lap data to recent workouts, races, and any multi-lap run.
 * Strategy: check KV cache first (populated by the frontend sync) — only fall back
 * to a live Strava API call if the activity is not yet cached.
 * Attaches both raw `_laps` (for the existing prompt formatter) and `_lapAnalysis`
 * (the structured pattern + classification from training-summary analysis).
 */
async function attachLapsToWorkouts(activities, accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // Include any multi-lap run from the last 14 days, not just workouts
  const cutoff14  = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const candidates = activities
    .filter(a => {
      if (!isRun(a)) return false;
      const ts = new Date(a.start_date_local || a.start_date).getTime();
      return ts > cutoff14;
    })
    .slice(0, 8); // up to 8 recent runs

  // Resolve athlete ID once (needed for KV key)
  let athleteId = null;
  if (kvUrl && kvToken) {
    athleteId = await getAthleteIdOnce(accessToken);
  }

  await Promise.all(candidates.map(async (a) => {
    try {
      // 1. Check KV cache
      if (kvUrl && kvToken && athleteId) {
        const cached = await kvGet(kvUrl, kvToken, `laps:${athleteId}:${a.id}`);
        if (cached && cached.laps && cached.laps.length > 1) {
          a._laps        = cached.laps.map(l => ({
            distance:          (l.distMi || 0) * 1609.34,
            average_speed:     l.paceMPM ? 1609.34 / l.paceMPM / 60 : 0,
            average_heartrate: l.hr,
            elapsed_time:      (l.durationMin || 0) * 60,
            name:              `Lap ${l.lapNum}`,
          }));
          a._lapAnalysis = cached;
          return;
        }
      }

      // 2. Fetch live from Strava (for workouts/races and varied-speed runs only)
      const isQuality = a._classification === 'Workout' || a._classification === 'Race' ||
                        a.workout_type === 3 ||
                        (a.max_speed && a.average_speed && a.max_speed / a.average_speed > 1.7);
      if (!isQuality) return;

      const r = await fetch(
        `https://www.strava.com/api/v3/activities/${a.id}/laps`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (!r.ok) return;
      const laps = await r.json();
      if (Array.isArray(laps) && laps.length > 1) {
        a._laps = laps;
      }
    } catch (_) {}
  }));
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
 * Format pre-classified lap array (from training-summary analysis) into a compact string.
 * Prefers the hard-effort summary line; falls back to per-lap detail.
 */
function formatLapsFromAnalysis(laps, hardEffortSummary) {
  if (!laps || laps.length < 2) return '';
  const parts = laps.slice(0, 30).map(l => {
    const cls  = l.classification ? `[${l.classification}]` : '';
    const pace = l.pace ? `@${l.pace}/mi` : '';
    const hr   = l.hr  ? ` HR${l.hr}` : '';
    return `${l.lapNum})${cls} ${l.distMi}mi${pace}${hr}`;
  });
  const more    = laps.length > 30 ? ` (+${laps.length - 30} more)` : '';
  const lapLine = `Laps: ${parts.join(' | ')}${more}`;
  // Prepend the hard-effort summary if present — gives Claude the workout in one sentence
  return hardEffortSummary
    ? `Hard efforts: ${hardEffortSummary}\n  ${lapLine}`
    : lapLine;
}

/**
 * Format Strava activities array into a compact human-readable string for Claude.
 */
function formatActivities(activities) {
  if (!activities || activities.length === 0) {
    return 'No activities found in the last 30 days.';
  }

  const lines = activities.map((a) => {
    const date        = new Date(a.start_date_local || a.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const distMi      = a.distance ? (a.distance / 1609.34).toFixed(2) : null;
    const durationMin = a.moving_time ? Math.round(a.moving_time / 60) : null;

    let pace = '';
    if (a.average_speed && /run/i.test(a.type || '')) {
      const minPerMile = 1609.34 / a.average_speed / 60;
      const mins       = Math.floor(minPerMile);
      const secs       = Math.round((minPerMile - mins) * 60).toString().padStart(2, '0');
      pace = ` | pace ${mins}:${secs}/mi`;
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
    const tag        = a._classification ? ` [${a._classification}]` : '';
    // Prefer structured lap analysis (with hard effort summary); fall back to raw lap formatter
    const laps = a._lapAnalysis?.pattern
      ? ` (pattern: ${a._lapAnalysis.pattern.description})\n  ${formatLapsFromAnalysis(a._lapAnalysis.laps, a._lapAnalysis.hardEffortSummary)}`
      : formatLaps(a._laps);
    // Temperature note (used for heat/humidity warnings in coaching)
    let weatherAdj = '';
    if (a.average_temp != null) {
      const tempF = Math.round(a.average_temp * 9 / 5 + 32);
      weatherAdj = ` | ${tempF}°F`;
    }

    return `• ${date}: ${a.type}${tag} ${name}${dist}${dur}${pace}${weatherAdj}${hr}${maxHR}${elevFt}${suffer}${kudos}${laps}`;
  });

  return lines.join('\n');
}

/**
 * Build the system prompt for Claude.
 */
function buildSystemPrompt(activitySummary, count, memory, trainingLoad, trainingSummary) {
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const memorySection   = buildMemorySection(memory);
  const loadSection     = buildTrainingLoadSection(trainingLoad);
  const historySection  = trainingSummary
    ? `\n## Training History (lap analysis · 90 days)\n${trainingSummary}\n`
    : '';

  return `You are an expert endurance sports coach and exercise physiologist. You give honest, specific, actionable coaching advice based on real athlete data.

Today's date: ${now}
${memorySection}${loadSection}${historySection}
## Recent Strava Activities (last 42 days, ${count} shown)
${activitySummary}

## Guidelines
- Always use imperial units: miles, feet, mph, and min/mile pace. Never use km, meters, or km/h.
- Each run has a classification tag in brackets e.g. [Easy Run], [Tempo Run] — reference these when discussing specific workouts
- Workouts and races include per-lap splits and a "Hard efforts:" line — ALWAYS cite the exact paces: "Your Tuesday session was 6×800m @ 5:52/mi · recovery 9:05/mi". Never give vague descriptions like "a hard workout" when lap data is present
- The Training History section (when present) summarises 90 days of lap-level workout patterns — use it for longitudinal context: days since last interval, pace trends, hard-day patterns, and exact paces from recent quality sessions
- Activities include temperature in °F when available — if a run was at 75°F or above, proactively note the heat and suggest slowing easy/long runs by ~20–30 sec/mi per 10°F above 60°F; warn against hard quality sessions in extreme heat (85°F+)
- When suggesting workouts, recommend a specific shoe from the athlete's Shoes list (matched to workout type: racing flat for speed, daily trainer for easy/long) and note its current mileage
- Reference specific activities, dates, and numbers from the data when answering
- Be direct and conversational — this is a mobile chat, not a report
- Use bullet points or numbered lists for multi-step advice
- Highlight both positives and areas for improvement
- Keep responses concise (2–4 short paragraphs) unless the athlete asks for detail
- Never make up data — only use what's in the activity list above

## Saving to Memory
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

  return 'Easy Run';
}

/** Mutates the activities array, adding `_classification` to each item. */
function classifyActivities(activities, paces, hrZones) {
  activities.forEach(a => { a._classification = classifyRun(a, paces, hrZones); });
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
  const tsbInterp =
    load.tsb > 10  ? 'Fresh (possibly detrained — good race window)' :
    load.tsb >= -10 ? 'Optimal (good race window)' :
    load.tsb >= -20 ? 'Productive training stress' :
    'Deep fatigue — back off';
  return `\n## Training Load (last 42 days)
CTL (Fitness): ${load.ctl} | ATL (Fatigue): ${load.atl} | TSB (Form): ${load.tsb > 0 ? '+' : ''}${load.tsb}
Form status: ${tsbInterp}\n`;
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
