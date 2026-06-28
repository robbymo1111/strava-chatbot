'use strict';

/**
 * POST /api/voice
 * Body: { audio: "<base64>", mimeType: "audio/webm", activityId: "..." }
 * Authorization: Bearer <strava_access_token>
 *
 * 1. Transcribes audio via OpenAI Whisper API
 * 2. Fetches the matching Strava activity via Strava MCP + Anthropic API
 * 3. Analyzes transcript + activity data with Claude claude-sonnet-4-6
 * 4. Stores structured debrief in KV memory under key debrief_<activityId>
 * 5. Returns structured JSON + plain-English summary
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { audio, mimeType = 'audio/webm', activityId } = req.body || {};
  if (!audio) return res.status(400).json({ error: 'audio (base64) is required.' });
  if (!activityId) return res.status(400).json({ error: 'activityId is required.' });

  const authHeader = req.headers.authorization || '';
  const accessToken = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!accessToken) return res.status(401).json({ error: 'Authorization: Bearer <token> required.' });

  const openaiKey    = process.env.OPENAI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured.' });

  /* ── Step 1: Transcribe via OpenAI Whisper ── */
  let transcript = '[transcription unavailable]';
  if (openaiKey) {
    try {
      // Decode base64 → binary buffer
      const audioBuffer = Buffer.from(audio, 'base64');

      // Build multipart/form-data manually (no npm dependency needed)
      const boundary = '----VoiceDebriefBoundary' + Date.now();
      const filename  = 'debrief.' + (mimeType.split('/')[1] || 'webm');

      const header =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mimeType}\r\n\r\n`;
      const model =
        `\r\n--${boundary}\r\n` +
        `Content-Disposition: form-data; name="model"\r\n\r\n` +
        `whisper-1` +
        `\r\n--${boundary}--\r\n`;

      const headerBuf = Buffer.from(header, 'utf8');
      const modelBuf  = Buffer.from(model, 'utf8');
      const body      = Buffer.concat([headerBuf, audioBuffer, modelBuf]);

      const whisperRes = await fetch('https://api.openai.com/v1/audio/transcriptions', {
        method:  'POST',
        headers: {
          Authorization:  `Bearer ${openaiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      });

      if (whisperRes.ok) {
        const data = await whisperRes.json();
        if (data.text) transcript = data.text.trim();
      } else {
        const err = await whisperRes.json().catch(() => ({}));
        console.error('[voice] Whisper error:', whisperRes.status, err);
      }
    } catch (err) {
      console.error('[voice] Whisper fetch error:', err.message);
    }
  } else {
    console.warn('[voice] OPENAI_API_KEY not set — using stub transcript');
  }

  /* ── Step 2: Fetch activity data via Strava MCP ── */
  let activityData = null;
  try {
    const mcpRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
        'anthropic-beta':    'mcp-client-2025-04-04',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5',
        max_tokens: 2000,
        mcp_servers: [{
          type:                'url',
          url:                 'https://mcp.strava.com/mcp',
          name:                'strava',
          authorization_token: accessToken,
        }],
        messages: [{
          role:    'user',
          content: `Use the Strava MCP to fetch activity ${activityId}.
Call get_activity with activity_id=${activityId} and get_activity_performance with activity_id=${activityId}.
Return ONLY a raw JSON object (no markdown, no code fences):
{
  "id": number,
  "name": string,
  "type": string,
  "start_date_local": string,
  "distance": number,
  "moving_time": number,
  "average_speed": number,
  "average_heartrate": number,
  "max_heartrate": number,
  "total_elevation_gain": number,
  "suffer_score": number,
  "laps": [...],
  "segments": [...],
  "bestEfforts": [...]
}`,
        }],
      }),
    });

    if (mcpRes.ok) {
      const mcpData = await mcpRes.json();
      for (const block of (mcpData.content || [])) {
        if (block.type === 'text' && block.text) {
          try {
            const cleaned = block.text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
            activityData = JSON.parse(cleaned);
            break;
          } catch (_) {
            const match = block.text.match(/\{[\s\S]*\}/);
            if (match) {
              try { activityData = JSON.parse(match[0]); break; } catch (_) {}
            }
          }
        }
      }
    } else {
      console.error('[voice] MCP error:', mcpRes.status);
    }
  } catch (err) {
    console.error('[voice] MCP fetch error:', err.message);
  }

  /* ── Step 3: Analyze transcript + activity with Claude ── */
  const activitySummary = activityData
    ? formatActivityForPrompt(activityData)
    : `Activity ID ${activityId} — data unavailable`;

  const analysisPrompt = `The athlete just finished a run and recorded this voice memo:
"${transcript}"

Here is their actual workout data:
${activitySummary}

Extract and structure the following:
- Physical signals mentioned (pain, tightness, fatigue, breathing, effort perception)
- Emotional/mental state (motivated, flat, frustrated, confident)
- Execution notes (went out too fast, negative split, died at mile X)
- Correlate each signal with the actual data where possible
- Flag anything that should inform future coaching (injury risk, form breakdown, breakthrough)

Return as JSON with NO markdown and NO code fences:
{
  "activityId": "${activityId}",
  "transcript": "${transcript.replace(/"/g, '\\"')}",
  "physicalSignals": ["..."],
  "mentalState": "...",
  "executionNotes": ["..."],
  "coachingFlags": ["..."],
  "correlations": [{ "observation": "...", "dataPoint": "...", "insight": "..." }]
}`;

  let debrief = null;
  let summary = '';

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-sonnet-4-6',
        max_tokens: 1024,
        system:     'You are an elite running coach analyzing post-run voice debriefs. Return only valid JSON — no markdown, no code fences, no explanation.',
        messages:   [{ role: 'user', content: analysisPrompt }],
      }),
    });

    if (!claudeRes.ok) {
      const err = await claudeRes.json().catch(() => ({}));
      console.error('[voice] Claude error:', claudeRes.status, err);
      return res.status(502).json({ error: 'AI analysis failed. Please try again.' });
    }

    const claudeData = await claudeRes.json();
    const raw = claudeData.content?.[0]?.text || '';

    try {
      const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
      debrief = JSON.parse(cleaned);
    } catch (_) {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { debrief = JSON.parse(match[0]); } catch (_) {}
      }
    }

    if (!debrief) {
      console.error('[voice] Could not parse Claude JSON:', raw.substring(0, 300));
      return res.status(502).json({ error: 'Could not parse AI analysis response.' });
    }

    // Build plain-English summary
    const parts = [];
    if (debrief.mentalState) parts.push(`Mental state: ${debrief.mentalState}.`);
    if (debrief.physicalSignals?.length) parts.push(`Physical: ${debrief.physicalSignals.join(', ')}.`);
    if (debrief.executionNotes?.length)  parts.push(`Execution: ${debrief.executionNotes[0]}.`);
    if (debrief.coachingFlags?.length)   parts.push(`Coach note: ${debrief.coachingFlags[0]}.`);
    if (debrief.correlations?.length)    parts.push(`Key insight: ${debrief.correlations[0].insight}.`);
    summary = parts.join(' ') || 'Debrief recorded.';

  } catch (err) {
    console.error('[voice] Claude fetch error:', err.message);
    return res.status(502).json({ error: 'Network error reaching AI service.' });
  }

  /* ── Step 4: Store in memory via /api/memory ── */
  try {
    const date = activityData?.start_date_local
      ? activityData.start_date_local.split('T')[0]
      : new Date().toISOString().split('T')[0];

    const memoryEntry = {
      ...debrief,
      date,
      summary,
      storedAt: Date.now(),
    };

    // Call /api/memory internally via the same pattern other API files use:
    // POST to KV directly (avoids circular HTTP call in serverless environment)
    await storeDebriefInMemory(accessToken, activityId, memoryEntry);
  } catch (err) {
    console.error('[voice] Memory store error:', err.message);
    // Non-fatal — still return the debrief
  }

  return res.status(200).json({ ...debrief, summary });
};

/* ── Helpers ── */

function formatActivityForPrompt(a) {
  if (!a) return 'No activity data available.';
  const distMi   = a.distance ? (a.distance / 1609.34).toFixed(2) + ' mi' : '?';
  const durMin   = a.moving_time ? Math.round(a.moving_time / 60) + ' min' : '?';
  const pace     = a.average_speed
    ? (() => { const mpm = 1609.34 / a.average_speed / 60; return `${Math.floor(mpm)}:${String(Math.round((mpm % 1) * 60)).padStart(2,'0')}/mi`; })()
    : '?';
  const hr       = a.average_heartrate ? `avg HR ${Math.round(a.average_heartrate)} bpm (max ${Math.round(a.max_heartrate || 0)})` : '';
  const elev     = a.total_elevation_gain ? `+${Math.round(a.total_elevation_gain * 3.28084)} ft elevation` : '';
  const suffer   = a.suffer_score ? `suffer score ${a.suffer_score}` : '';
  const date     = a.start_date_local ? new Date(a.start_date_local).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '';

  const parts = [
    `Activity: "${a.name || 'Run'}" on ${date}`,
    `Distance: ${distMi} | Duration: ${durMin} | Pace: ${pace}`,
    hr, elev, suffer,
  ].filter(Boolean);

  if (Array.isArray(a.laps) && a.laps.length > 1) {
    const lapLines = a.laps.slice(0, 10).map((l, i) => {
      const lapDist = l.distance_meters ? (l.distance_meters / 1609.34).toFixed(2) + 'mi' : '';
      const lapPace = l.average_speed_m_per_s
        ? (() => { const mpm = 1609.34 / l.average_speed_m_per_s / 60; return `${Math.floor(mpm)}:${String(Math.round((mpm % 1) * 60)).padStart(2,'0')}/mi`; })()
        : '';
      const lapHR = l.average_heartrate ? `HR${Math.round(l.average_heartrate)}` : '';
      return `  Lap ${i + 1}: ${[lapDist, lapPace, lapHR].filter(Boolean).join(' ')}`;
    });
    parts.push('Laps:\n' + lapLines.join('\n'));
  }

  if (Array.isArray(a.bestEfforts) && a.bestEfforts.length > 0) {
    const effortLines = a.bestEfforts.slice(0, 5).map(e =>
      `  ${e.name}: ${fmtTime(e.elapsed_time)}`
    );
    parts.push('Best Efforts:\n' + effortLines.join('\n'));
  }

  return parts.join('\n');
}

function fmtTime(seconds) {
  if (!seconds) return '?';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

/**
 * Store debrief in KV under key debrief_<activityId> inside the athlete's memory object.
 * Mirrors the pattern used by /api/memory: resolves athlete ID via Strava, then sets KV.
 */
async function storeDebriefInMemory(accessToken, activityId, debriefEntry) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return; // KV not configured — degrade gracefully

  // Resolve athlete ID
  let athleteId;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return;
    const a = await r.json();
    athleteId = String(a.id);
  } catch (_) { return; }

  const memKey = `memory:${athleteId}`;

  // Read existing memory
  let existing = {};
  try {
    const r    = await fetch(`${kvUrl}/get/${encodeURIComponent(memKey)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const data = await r.json();
    if (data.result) existing = JSON.parse(data.result);
  } catch (_) {}

  // Merge the new debrief under debrief_<activityId>
  const updated = {
    ...existing,
    [`debrief_${activityId}`]: debriefEntry,
  };

  // Write back
  try {
    await fetch(`${kvUrl}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['SET', memKey, JSON.stringify(updated)]]),
    });
  } catch (_) {}
}
