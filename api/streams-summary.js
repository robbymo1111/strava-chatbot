'use strict';

/**
 * POST /api/streams-summary
 * Body: { accessToken, activityIds: string[], maxHR }
 *
 * Reads cached stream analyses from KV for the given activity IDs,
 * aggregates zone distribution, cardiac recovery, and decoupling trends,
 * then writes a summary index to KV.
 *
 * KV key: streams:{athleteId}:summary
 *
 * Called from the frontend after streams-batch completes.
 * Also used by the coaching-summary endpoint.
 */
const { getAthleteId, kvPipeline, kvSet } = require('./_lib');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken, activityIds = [], maxHR } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });
  if (!activityIds.length) return res.status(200).json({ ok: false, reason: 'no activity IDs' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ ok: false, reason: 'KV not configured' });

  let athleteId;
  try {
    athleteId = await getAthleteId(accessToken);
    if (!athleteId) return res.status(401).json({ error: 'Could not resolve athlete ID' });
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  /* ── Batch-read all stream analyses ── */
  const commands = activityIds.map(id => ['GET', `streams:${athleteId}:${id}`]);
  let rawResults;
  try {
    rawResults = await kvPipeline(kvUrl, kvToken, commands);
  } catch (_) {
    return res.status(200).json({ ok: false, reason: 'KV pipeline failed' });
  }

  const analyses = rawResults
    .map(r => { try { return r.result ? JSON.parse(r.result) : null; } catch (_) { return null; } })
    .filter(Boolean);

  if (!analyses.length) {
    return res.status(200).json({ ok: false, reason: 'no cached stream analyses found' });
  }

  /* ── Aggregate metrics ── */
  let z2Sum = 0, z5Sum = 0, recovSum = 0, recovCount = 0, dcSum = 0, dcCount = 0;
  let count  = 0;

  // Track weekly Z5 averages for "low Z5 for N weeks" detection
  // Group by ISO week (yyyy-Wnn)
  const weeklyZ5 = {};

  for (const sa of analyses) {
    if (!sa.zones) continue;
    count++;
    z2Sum += sa.zones.z2?.pct || 0;
    z5Sum += sa.zones.z5?.pct || 0;
    if (sa.avgRecoveryS != null) { recovSum += sa.avgRecoveryS; recovCount++; }
    if (sa.decoupling?.available) { dcSum += sa.decoupling.pct || 0; dcCount++; }

    // Bucket by analyzedAt week
    if (sa.analyzedAt) {
      const d   = new Date(sa.analyzedAt);
      const wk  = isoWeek(d);
      if (!weeklyZ5[wk]) weeklyZ5[wk] = { z5sum: 0, n: 0 };
      weeklyZ5[wk].z5sum += sa.zones.z5?.pct || 0;
      weeklyZ5[wk].n++;
    }
  }

  const avgZ2Pct       = count > 0 ? Math.round(z2Sum / count) : null;
  const avgZ5Pct       = count > 0 ? Math.round(z5Sum / count) : null;
  const avgRecoveryS   = recovCount > 0 ? Math.round(recovSum / recovCount) : null;
  const avgDecouplingPct = dcCount > 0 ? Math.round(dcSum / dcCount * 10) / 10 : null;

  // Consecutive weeks with avg Z5 < 5%
  const wkKeys     = Object.keys(weeklyZ5).sort().slice(-8); // last 8 weeks
  let lowZ5Weeks   = 0;
  for (let i = wkKeys.length - 1; i >= 0; i--) {
    const wk = weeklyZ5[wkKeys[i]];
    if (wk.n > 0 && wk.z5sum / wk.n < 5) lowZ5Weeks++;
    else break;
  }

  // Detect declining cardiac recovery: last 4 activities vs prior 4
  let decliningRecovery = false;
  const recovActivities = analyses.filter(sa => sa.avgRecoveryS != null)
    .sort((a, b) => (a.analyzedAt || 0) - (b.analyzedAt || 0));
  if (recovActivities.length >= 8) {
    const recent4 = recovActivities.slice(-4).map(sa => sa.avgRecoveryS);
    const prior4  = recovActivities.slice(-8, -4).map(sa => sa.avgRecoveryS);
    const recentAvg = recent4.reduce((a, b) => a + b, 0) / 4;
    const priorAvg  = prior4.reduce((a, b) => a + b, 0) / 4;
    // Lower HRR = worse recovery (heart rate drops less in 60s)
    decliningRecovery = recentAvg < priorAvg * 0.88; // >12% decline
  }

  // Low Z2 warning: if average Z2 time < 40% of total training
  const lowZ2Warning = avgZ2Pct != null && avgZ2Pct < 40;

  const summary = {
    generatedAt:       Date.now(),
    activityCount:     count,
    avgZ2Pct,
    avgZ5Pct,
    avgRecoveryS,
    avgDecouplingPct,
    lowZ5Weeks,
    decliningRecovery,
    lowZ2Warning,
    weeklyZ5: Object.fromEntries(
      wkKeys.map(k => [k, Math.round(weeklyZ5[k].z5sum / weeklyZ5[k].n)])
    ),
  };

  await kvSet(kvUrl, kvToken, `streams:${athleteId}:summary`, summary);

  return res.status(200).json({ ok: true, ...summary });
};

/* ── ISO week string helper ── */
function isoWeek(date) {
  const d   = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  const wn    = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return `${d.getFullYear()}-W${String(wn).padStart(2, '0')}`;
}
