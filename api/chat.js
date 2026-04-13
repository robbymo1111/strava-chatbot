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

  /* ── Fetch recent Strava activities (last 30 days) ── */
  const thirtyDaysAgo = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
  let activities = [];

  try {
    const stravaRes = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${thirtyDaysAgo}&per_page=20`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    if (stravaRes.status === 401) {
      return res.status(401).json({ error: 'Your Strava session has expired. Please log in again.' });
    }

    if (!stravaRes.ok) {
      console.error('Strava activities error:', stravaRes.status);
      return res.status(502).json({ error: 'Could not fetch your Strava activities. Please try again.' });
    }

    activities = await stravaRes.json();
  } catch (err) {
    console.error('Strava fetch error:', err);
    return res.status(502).json({ error: 'Network error fetching Strava data.' });
  }

  /* ── Classify runs & compute weekly balance ── */
  const athletePaces = memory?.paces || null;
  classifyActivities(activities, athletePaces);
  const weeklyBalance = getWeeklyBalance(activities);

  /* ── Format activities for Claude ── */
  const activitySummary = formatActivities(activities);

  /* ── Build conversation history for Claude ── */
  // Sanitize history: only keep valid role/content pairs
  const safeHistory = (Array.isArray(history) ? history : [])
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .slice(-8); // max 4 exchanges

  // The current message should be the last user turn
  // If history already ends with the current message, use it as-is; otherwise append
  const messages = buildMessages(safeHistory, message.trim());

  /* ── Call Claude ── */
  const systemPrompt = buildSystemPrompt(activitySummary, activities.length, memory);

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

    return res.status(200).json({ reply, weeklyBalance });

  } catch (err) {
    console.error('Claude fetch error:', err);
    return res.status(502).json({ error: 'Network error reaching AI service.' });
  }
};

/* ────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────── */

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
    const tag     = a._classification ? ` [${a._classification}]` : '';

    return `• ${date}: ${a.type}${tag} ${name}${dist}${dur}${pace}${hr}${maxHR}${elevFt}${suffer}${kudos}`;
  });

  return lines.join('\n');
}

/**
 * Build the system prompt for Claude.
 */
function buildSystemPrompt(activitySummary, count, memory) {
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  const memorySection = buildMemorySection(memory);

  return `You are an expert endurance sports coach and exercise physiologist. You give honest, specific, actionable coaching advice based on real athlete data.

Today's date: ${now}
${memorySection}
## Recent Strava Activities (last 30 days, ${count} total)
${activitySummary}

## Guidelines
- Always use imperial units: miles, feet, mph, and min/mile pace. Never use km, meters, or km/h.
- Each run has a classification tag in brackets e.g. [Easy Run], [Tempo Run] — reference these when discussing specific workouts
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

Return the COMPLETE updated memory including existing items — not just the new ones.
Existing memory: ${JSON.stringify(memory || { goals: [], prs: [], injuries: [], notes: [] })}

Format (omit entirely if nothing new was mentioned):
<memory-update>
{"goals":[...],"prs":[...],"injuries":[...],"notes":[...]}
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
 * Classify a single run.
 * If `paces` is provided (from the athlete's VDOT calculation) it is used
 * for pace-based thresholds; otherwise generic thresholds apply.
 * paces shape: { easy:[lo,hi], threshold:[lo,hi], ... }  (min/mile, lo < hi)
 */
function classifyRun(activity, paces) {
  if (!isRun(activity)) return null;

  const durationMin  = (activity.moving_time || 0) / 60;
  const distMi       = (activity.distance    || 0) / 1609.34;
  const avgSpeed     = activity.average_speed;                          // m/s
  const avgPaceMPM   = avgSpeed ? 1609.34 / avgSpeed / 60 : null;      // min/mile
  const avgHR        = activity.average_heartrate;
  const maxSpeed     = activity.max_speed;
  const workoutType  = activity.workout_type;

  // Respect Strava's own workout_type label first
  if (workoutType === 1) return 'Race';
  if (workoutType === 2) return 'Long Run';
  if (workoutType === 3) return 'Workout';

  // High max/avg speed ratio → intervals or fartlek
  const speedRatio = (maxSpeed && avgSpeed && avgSpeed > 0) ? maxSpeed / avgSpeed : 1;
  if (speedRatio > 1.9) return 'Workout';

  // 90+ minutes → long run
  if (durationMin >= 90) return 'Long Run';

  // Very short + slow → recovery
  if (durationMin <= 35 && distMi <= 4) return 'Recovery Run';

  // ── Personalized pace-based classification (VDOT) ──
  if (paces && avgPaceMPM) {
    const easyHi     = paces.easy[1];       // slowest easy pace (e.g. 10:30)
    const easyLo     = paces.easy[0];       // fastest easy pace (e.g. 8:20)
    const threshHi   = paces.threshold[1];  // slowest threshold pace
    const threshLo   = paces.threshold[0];  // fastest threshold pace

    if (avgPaceMPM > easyHi)                        return 'Recovery Run';
    if (avgPaceMPM >= easyLo && avgPaceMPM <= easyHi) return 'Easy Run';
    if (avgPaceMPM >= threshLo && avgPaceMPM <= threshHi) return 'Tempo Run';
    if (avgPaceMPM < threshLo)                      return 'Workout';
    return 'Easy Run'; // between easy and threshold → treat as easy
  }

  // ── HR-based (reliable when a monitor is worn) ──
  if (avgHR) {
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
function classifyActivities(activities, paces) {
  activities.forEach(a => { a._classification = classifyRun(a, paces); });
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

/**
 * Build the messages array for the Claude API, supporting multi-turn conversation.
 */
function buildMessages(history, currentMessage) {
  // history already contains the current message as the last user turn
  // (sent from frontend with the full history including current question)
  // If the last item is already the current message, use history as-is
  const lastItem = history[history.length - 1];
  if (lastItem && lastItem.role === 'user' && lastItem.content === currentMessage) {
    return history;
  }

  // Otherwise append the current message
  return [...history, { role: 'user', content: currentMessage }];
}
