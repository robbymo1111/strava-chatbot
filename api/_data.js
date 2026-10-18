'use strict';

/**
 * SHARED DATA ACCESS
 *
 * The KV/Strava/Intervals readers that used to live in chat.js. The chat
 * endpoint is gone — Claude chat + the Strava MCP connector is the
 * conversational surface now — but this layer is what the MCP server and the
 * dashboard both read from, so it outlives it.
 *
 * Every athlete-facing date here comes from athleteToday() (America/New_York
 * by default): Vercel runs UTC, and a UTC date is a day ahead every evening.
 */

const { computeSubTMinutes, isQualityEffort, weekStart, athleteToday,
        computeRollingContext } = require('./_coach-metrics');

// Cached for the lifetime of a warm function instance, so repeated readers in
// one request don't each hit /athlete. Declared here because the extraction
// out of chat.js left it behind — under 'use strict' the bare reference threw
// a ReferenceError that the catch below swallowed, silently nulling every
// KV read keyed on athlete id.
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
  } catch (e) {
    console.error('[data] getAthleteIdOnce failed:', e.message);
    return null;
  }
}

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
  const today   = athleteToday();
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
 * Read cached lap analysis for this week's quality sessions and sum the work
 * intervals. Returns null when no lap data exists — the context block then
 * says UNKNOWN rather than reporting a fabricated zero (spec §6.1).
 */
async function getSubTMinutesThisWeek(accessToken, activities) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;

    const monday = weekStart(athleteToday());
    const thisWeekQuality = activities.filter(a => {
      const d = (a.start_date_local || a.start_date || '').slice(0, 10);
      return d >= monday && isQualityEffort(a);
    });
    if (!thisWeekQuality.length) return 0; // no quality sessions yet — a real zero

    const lapData = await Promise.all(
      thisWeekQuality.map(a =>
        kvGet(kvUrl, kvToken, `laps:${athleteId}:${a.id}`).catch(() => null)
      )
    );
    const usable = lapData.filter(Boolean);
    if (!usable.length) return null; // sessions exist but no lap data — unknown

    return computeSubTMinutes(usable, { since: monday }).minutes;
  } catch (_) { return null; }
}

/**
 * Read the current training block state from KV (§9 of the knowledge base).
 * KV-backed so block changes — key sessions, MP recalibration after Bronx 10 —
 * take effect without a redeploy. Returns null to fall back to DEFAULT_BLOCK_STATE.
 */
async function getBlockStateFromKV(accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;
    return await kvGet(kvUrl, kvToken, `coach:${athleteId}:block-state`);
  } catch (_) { return null; }
}

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
    const today    = athleteToday();
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
 * Read cached weather from KV (written by /api/brain?action=weather with 30-min TTL).
 * Returns null gracefully if not yet fetched or stale. KV-read-only — never makes
 * a live weather API call; that's the frontend's job via brain.js.
 * Fires in parallel with all other KV reads — zero net latency.
 */
async function getWeatherForChat(accessToken) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return null;

  try {
    const athleteId = await getAthleteIdOnce(accessToken);
    if (!athleteId) return null;
    const cacheKey = `weather:${athleteId}:current`;
    const r    = await fetch(`${kvUrl}/get/${encodeURIComponent(cacheKey)}`, {
      headers: { Authorization: `Bearer ${kvToken}` },
    });
    const data = await r.json();
    if (!data.result) return null;
    const parsed = JSON.parse(data.result);
    if (!parsed?.available) return null;
    // Treat as stale if older than 60 minutes (brain.js refreshes every 30 min)
    const ageMs = Date.now() - (parsed.fetchedAt || 0);
    if (ageMs > 60 * 60 * 1000) return null;
    return parsed;
  } catch (_) { return null; }
}

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

function kvWriteEx(url, token, key, value, ttlSeconds) {
  fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]),
  }).catch(() => {});
}

/**
 * Assemble the deterministic context that check_rules validates against.
 * Computed once per turn from data already in memory — the tool handler does
 * zero I/O, which is what keeps the loop inside the function timeout.
 */
function buildRuleContext(activities, blockState, subTMinutesThisWeek) {
  const bs = blockState || {};
  const rolling = computeRollingContext(activities, {
    raceDate:       bs.race_date,
    blockStartDate: bs.block_start_date,
    longRunCapMi:   bs.long_run_cap || 18,
    keySessions:    bs.key_sessions,
    timezone:       bs.timezone,
    subTMinutesThisWeek,
  });
  return rolling;
}
module.exports = {
  getAthleteIdOnce,
  getHistoryAnalysisFromKV,
  fetchIntervalsWellnessForChat,
  getConversationContext,
  getSubTMinutesThisWeek,
  getBlockStateFromKV,
  getThresholdDriftFromKV,
  getOuraDataFromKV,
  getWeatherForChat,
  getTrainingSummaryFromKV,
  kvGet,
  kvWrite,
  kvWriteEx,
  buildRuleContext,
};
