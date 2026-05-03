'use strict';

/**
 * GET /api/streams?accessToken=xxx&activityId=yyy&maxHR=187&activityType=Run
 *
 * Fetches Strava activity HR stream, computes full analysis, caches permanently in KV.
 * Key: streams:{athleteId}:{activityId}
 *
 * Streams are immutable historical data — no TTL.
 */
const { getAthleteId, kvGet, kvSet } = require('./_lib');
const { analyzeHRStream }            = require('./_stream-analysis');

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const { accessToken, activityId, activityType } = req.query;
  const maxHR = parseInt(req.query.maxHR) || null;

  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });
  if (!activityId)  return res.status(400).json({ error: 'activityId required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  /* ── Resolve athlete ID ── */
  let athleteId;
  try {
    athleteId = await getAthleteId(accessToken);
    if (!athleteId) return res.status(401).json({ error: 'Could not resolve athlete ID' });
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  const cacheKey = `streams:${athleteId}:${activityId}`;

  /* ── Serve from KV cache (streams never change) ── */
  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, cacheKey);
    if (cached) return res.status(200).json({ ...cached, fromCache: true });
  }

  /* ── Fetch stream from Strava ── */
  let rawStreams;
  try {
    const streamUrl =
      `https://www.strava.com/api/v3/activities/${activityId}/streams` +
      `?keys=heartrate,time,distance,velocity_smooth,altitude&key_by_type=true`;
    const r = await fetch(streamUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit' });
    if (!r.ok) return res.status(502).json({ error: `Strava error ${r.status}` });
    rawStreams = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'Network error fetching stream' });
  }

  /* ── Analyse ── */
  const analysis = analyzeHRStream(
    {
      heartrate:       rawStreams.heartrate?.data       || [],
      time:            rawStreams.time?.data             || [],
      distance:        rawStreams.distance?.data         || [],
      velocity_smooth: rawStreams.velocity_smooth?.data  || [],
    },
    maxHR,
    activityType || ''
  );

  if (!analysis) {
    return res.status(200).json({ available: false, activityId, reason: 'insufficient HR data' });
  }

  analysis.activityId   = String(activityId);
  analysis.activityType = activityType || analysis.activityType || '';

  /* ── Cache permanently ── */
  if (kvUrl && kvToken) {
    await kvSet(kvUrl, kvToken, cacheKey, analysis);
  }

  return res.status(200).json({ ...analysis, fromCache: false });
};
