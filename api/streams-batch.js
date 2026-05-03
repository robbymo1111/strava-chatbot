'use strict';

/**
 * POST /api/streams-batch
 * Body: { accessToken, activities: [{id, average_heartrate, suffer_score, type, name}], maxHR }
 *
 * Batch-fetches HR streams for quality activities not yet cached in KV.
 * Quality filter: avg HR > 130 OR suffer score > 30 (any activity type).
 * Processes up to 10 uncached activities per call. Permanently caches each result.
 *
 * Returns: { processed, skipped, total, athleteId }
 */
const { getAthleteId, kvPipeline, kvSet } = require('./_lib');
const { analyzeHRStream }                  = require('./_stream-analysis');

function meetsStreamCriteria(a) {
  return (a.average_heartrate || 0) > 130 || (a.suffer_score || 0) > 30;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken, activities = [], maxHR } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

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

  /* ── Filter to quality activities ── */
  const candidates = activities.filter(meetsStreamCriteria);
  if (!candidates.length) {
    return res.status(200).json({ processed: 0, skipped: 0, total: 0, athleteId });
  }

  /* ── Batch-check KV for already-cached streams (1 HTTP round-trip) ── */
  let alreadyCached = new Set();
  if (kvUrl && kvToken) {
    const commands     = candidates.map(a => ['GET', `streams:${athleteId}:${a.id}`]);
    const cacheResults = await kvPipeline(kvUrl, kvToken, commands);
    candidates.forEach((a, i) => {
      if (cacheResults[i]?.result) alreadyCached.add(String(a.id));
    });
  }

  const needsFetch = candidates.filter(a => !alreadyCached.has(String(a.id)));
  const batch      = needsFetch.slice(0, 10); // cap concurrent Strava requests

  /* ── Fetch + analyse + cache concurrently ── */
  let processed = 0;
  await Promise.all(batch.map(async (a) => {
    try {
      const streamUrl =
        `https://www.strava.com/api/v3/activities/${a.id}/streams` +
        `?keys=heartrate,time,distance,velocity_smooth,altitude&key_by_type=true`;
      const r = await fetch(streamUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!r.ok) return;

      const raw = await r.json();
      const analysis = analyzeHRStream(
        {
          heartrate:       raw.heartrate?.data       || [],
          time:            raw.time?.data             || [],
          distance:        raw.distance?.data         || [],
          velocity_smooth: raw.velocity_smooth?.data  || [],
        },
        maxHR || null,
        a.type || ''
      );
      if (!analysis) return;

      analysis.activityId   = String(a.id);
      analysis.activityType = a.type || '';
      analysis.activityName = a.name || '';

      if (kvUrl && kvToken) {
        await kvSet(kvUrl, kvToken, `streams:${athleteId}:${a.id}`, analysis);
      }
      processed++;
    } catch (_) {}
  }));

  return res.status(200).json({
    processed,
    skipped:  alreadyCached.size,
    total:    candidates.length,
    athleteId,
  });
};
