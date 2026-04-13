/**
 * POST /.netlify/functions/chat
 * Body: { message: string, accessToken: string, history: Array<{role, content}> }
 *
 * 1. Fetches the athlete's recent Strava activities (last 30 days, up to 20)
 * 2. Sends them to Claude with the user's question
 * 3. Returns { reply: string }
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  /* ── Parse body ── */
  let message, accessToken, history;
  try {
    ({ message, accessToken, history = [] } = JSON.parse(event.body));
  } catch (_) {
    return jsonError(400, 'Invalid request body.');
  }

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return jsonError(400, 'message is required.');
  }

  if (!accessToken || typeof accessToken !== 'string') {
    return jsonError(401, 'accessToken is required.');
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    return jsonError(500, 'Anthropic API key is not configured on the server.');
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
      return jsonError(401, 'Your Strava session has expired. Please log in again.');
    }

    if (!stravaRes.ok) {
      console.error('Strava activities error:', stravaRes.status);
      return jsonError(502, 'Could not fetch your Strava activities. Please try again.');
    }

    activities = await stravaRes.json();
  } catch (err) {
    console.error('Strava fetch error:', err);
    return jsonError(502, 'Network error fetching Strava data.');
  }

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
  const systemPrompt = buildSystemPrompt(activitySummary, activities.length);

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
      return jsonError(502, 'AI service error. Please try again in a moment.');
    }

    const claudeData = await claudeRes.json();
    const reply = claudeData.content?.[0]?.text;

    if (!reply) {
      return jsonError(502, 'Empty response from AI. Please try again.');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reply })
    };

  } catch (err) {
    console.error('Claude fetch error:', err);
    return jsonError(502, 'Network error reaching AI service.');
  }
};

/* ────────────────────────────────────────────
   Helpers
   ──────────────────────────────────────────── */

function jsonError(status, error) {
  return {
    statusCode: status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ error })
  };
}

/**
 * Format Strava activities array into a compact human-readable string for Claude.
 */
function formatActivities(activities) {
  if (!activities || activities.length === 0) {
    return 'No activities found in the last 30 days.';
  }

  const lines = activities.map((a) => {
    const date     = new Date(a.start_date_local || a.start_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const distKm   = a.distance ? (a.distance / 1000).toFixed(2) : null;
    const distMi   = a.distance ? (a.distance / 1609.34).toFixed(2) : null;
    const durationMin = a.moving_time ? Math.round(a.moving_time / 60) : null;

    let pace = '';
    if (a.average_speed && a.type && /run/i.test(a.type)) {
      const minPerKm = 1000 / a.average_speed / 60;
      const mins     = Math.floor(minPerKm);
      const secs     = Math.round((minPerKm - mins) * 60).toString().padStart(2, '0');
      pace = ` | pace ${mins}:${secs}/km`;
    } else if (a.average_speed) {
      const kph = (a.average_speed * 3.6).toFixed(1);
      pace = ` | ${kph} km/h avg`;
    }

    const hr      = a.average_heartrate ? ` | HR ${Math.round(a.average_heartrate)} bpm` : '';
    const maxHR   = a.max_heartrate     ? ` (max ${Math.round(a.max_heartrate)})` : '';
    const elev    = a.total_elevation_gain ? ` | elev +${Math.round(a.total_elevation_gain)}m` : '';
    const suffer  = a.suffer_score      ? ` | suffer ${a.suffer_score}` : '';
    const kudos   = a.kudos_count > 0   ? ` | ${a.kudos_count} kudos` : '';
    const name    = a.name ? `"${a.name}"` : a.type;
    const dist    = distKm ? ` ${distKm}km (${distMi}mi)` : '';
    const dur     = durationMin ? ` in ${durationMin}min` : '';

    return `• ${date}: ${a.type} ${name}${dist}${dur}${pace}${hr}${maxHR}${elev}${suffer}${kudos}`;
  });

  return lines.join('\n');
}

/**
 * Build the system prompt for Claude.
 */
function buildSystemPrompt(activitySummary, count) {
  const now = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

  return `You are an expert endurance sports coach and exercise physiologist. You give honest, specific, actionable coaching advice based on real athlete data.

Today's date: ${now}

The athlete's Strava activities from the last 30 days (${count} total):
${activitySummary}

Guidelines:
- Reference specific activities, dates, and numbers from the data when answering
- Be direct and conversational — this is a mobile chat, not a report
- Use bullet points or numbered lists for multi-step advice
- Highlight both positives and areas for improvement
- If asked about an activity type not present in the data, say so clearly
- Keep responses concise (2–4 short paragraphs or equivalent) unless the athlete asks for detail
- If there are no recent activities, acknowledge that and offer general advice
- Never make up data — only use what's in the activity list above`;
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
