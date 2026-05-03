'use strict';

/**
 * GET/POST /api/brain?action=<action>
 *
 * Unified router for all "brain" features, consolidating previously separate
 * endpoints to stay within Vercel Hobby plan's 12-function limit.
 *
 * GET  ?action=threshold-drift    &accessToken=&maxHR=
 * GET  ?action=coaching-summary   &accessToken=&vdot=&maxHR=
 * GET  ?action=training-summary   &accessToken=
 * GET  ?action=stream             &accessToken=&activityId=&maxHR=&activityType=
 * GET  ?action=cron-intervals     (Authorization: Bearer $CRON_SECRET)
 * POST ?action=streams-batch      body: { accessToken, activities[], maxHR }
 * POST ?action=streams-summary    body: { accessToken, activityIds[], maxHR }
 */

const { getAthleteId, kvGet, kvSet, kvPipeline, fmtPace,
        classifyLaps, detectPattern } = require('./_lib');
const { analyzeHRStream }             = require('./_stream-analysis');

module.exports = async (req, res) => {
  const action = req.query.action;
  if (!action) return res.status(400).json({ error: 'action required' });

  switch (action) {
    case 'threshold-drift':  return handleThresholdDrift(req, res);
    case 'coaching-summary': return handleCoachingSummary(req, res);
    case 'training-summary': return handleTrainingSummary(req, res);
    case 'stream':           return handleStream(req, res);
    case 'streams-batch':    return handleStreamsBatch(req, res);
    case 'streams-summary':  return handleStreamsSummary(req, res);
    case 'cron-intervals':   return handleCronIntervals(req, res);
    default:
      return res.status(400).json({ error: `Unknown action: ${action}` });
  }
};

/* ════════════════════════════════════════════════════════════════════════════
   THRESHOLD DRIFT
   ════════════════════════════════════════════════════════════════════════════ */

async function handleThresholdDrift(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const maxHR   = parseInt(req.query.maxHR) || null;
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  let athleteId;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (!r.ok)           return res.status(502).json({ error: 'Could not verify Strava session' });
    const a = await r.json();
    athleteId = String(a.id);
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  const cacheKey = `threshold:${athleteId}:drift-cache`;
  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, cacheKey);
    if (cached && Date.now() - (cached.builtAt || 0) < 5 * 60 * 1000) {
      return res.status(200).json(cached);
    }
  }

  const since90 = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  let activities = [];
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${since90}&per_page=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit reached' });
    if (!r.ok)            return res.status(502).json({ error: 'Could not fetch activities' });
    activities = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'Network error fetching activities' });
  }

  // Infer maxHR from observed peak HR in recent activities when not explicitly provided.
  // Add 5% to observed peak — you rarely hit absolute max in training.
  const observedMaxHR = activities
    .filter(a => /run/i.test(a.type || ''))
    .reduce((m, a) => Math.max(m, a.max_heartrate || 0), 0);
  const effectiveMaxHR = maxHR ||
    (observedMaxHR > 140 ? Math.round(observedMaxHR * 1.05) : null);

  // LT2 (lactate threshold) sits at ~83–92% of maxHR for trained athletes.
  // Old defaults (86–91%) were too high; many runners hit LT2 at 82–88%.
  const threshLow  = effectiveMaxHR ? Math.round(effectiveMaxHR * 0.83) : 150;
  const threshHigh = effectiveMaxHR ? Math.round(effectiveMaxHR * 0.92) : 172;

  const qualifying = [];
  for (const a of activities) {
    if (!/run/i.test(a.type || '')) continue;
    const durationMin = (a.moving_time || 0) / 60;
    if (durationMin < 20) continue;
    const avgHR = a.average_heartrate;
    if (!avgHR || avgHR < threshLow || avgHR > threshHigh) continue;
    const avgSpeed = a.average_speed;
    if (!avgSpeed || avgSpeed < 0.1) continue;
    const maxSpeed   = a.max_speed || avgSpeed;
    const speedRatio = maxSpeed / avgSpeed;
    if (speedRatio > 1.20) continue; // 20% variance allows for hills; 15% was too tight
    const paceMPM = 1609.34 / avgSpeed / 60;
    qualifying.push({
      date:            (a.start_date_local || a.start_date).split('T')[0],
      activityId:      String(a.id),
      name:            a.name || 'Run',
      paceMPM:         Math.round(paceMPM * 1000) / 1000,
      avgHR:           Math.round(avgHR),
      durationMin:     Math.round(durationMin),
      efficiencyRatio: Math.round((paceMPM / avgHR) * 10000) / 10000,
    });
  }

  const histKey = `threshold:${athleteId}:drift-history`;
  let history = [];
  if (kvUrl && kvToken) {
    const stored = await kvGet(kvUrl, kvToken, histKey);
    if (stored && Array.isArray(stored)) history = stored;
  }

  const existingIds = new Set(history.map(h => h.activityId));
  for (const s of qualifying) {
    if (!existingIds.has(s.activityId)) {
      history.push(s);
      existingIds.add(s.activityId);
    }
  }
  history.sort((a, b) => a.date.localeCompare(b.date));

  const now   = Date.now();
  const DECAY = 0.85;
  let weightedSum = 0, weightTotal = 0;
  for (const s of history) {
    const weeksAgo = (now - new Date(s.date + 'T12:00:00Z').getTime()) / (7 * 86400 * 1000);
    const w = Math.pow(DECAY, weeksAgo);
    weightedSum  += s.paceMPM * w;
    weightTotal  += w;
  }
  const currentEstimate = weightTotal > 0
    ? Math.round((weightedSum / weightTotal) * 1000) / 1000
    : null;

  const d30 = new Date(now - 30 * 86400 * 1000).toISOString().split('T')[0];
  const sessionsAt30 = history.filter(h => h.date <= d30);
  const estimate30dAgo = sessionsAt30.length >= 1
    ? Math.round(sessionsAt30.slice(-3).reduce((s, h) => s + h.paceMPM, 0) / Math.min(3, sessionsAt30.length) * 1000) / 1000
    : null;

  let trendDirection = 'flat';
  let trendSeconds   = 0;
  if (history.length >= 4) {
    const recent = history.slice(-4);
    const prior  = history.slice(-8, -4);
    if (prior.length >= 2) {
      const ra = recent.reduce((s, h) => s + h.paceMPM, 0) / recent.length;
      const pa = prior.reduce((s, h) => s + h.paceMPM, 0) / prior.length;
      trendSeconds = Math.round((ra - pa) * 60);
      if (trendSeconds < -5)      trendDirection = 'improving';
      else if (trendSeconds > 5)  trendDirection = 'declining';
    }
  }

  const d14 = new Date(now - 14 * 86400 * 1000).toISOString().split('T')[0];
  const recentSessions = history.filter(h => h.date >= d14);
  const olderSessions  = history.filter(h => h.date <  d14).slice(-5);
  let bigShift = false;
  if (recentSessions.length >= 1 && olderSessions.length >= 1) {
    const ra = recentSessions.reduce((s, h) => s + h.paceMPM, 0) / recentSessions.length;
    const oa = olderSessions.reduce((s, h) => s + h.paceMPM, 0) / olderSessions.length;
    bigShift = Math.abs((ra - oa) * 60) > 5;
  }

  const result = {
    builtAt:       Date.now(),
    thresholdZone: { low: threshLow, high: threshHigh, maxHRSource: maxHR ? 'user' : (observedMaxHR > 140 ? 'observed' : 'default') },
    totalSessions:  history.length,
    currentEstimate,
    estimate30dAgo,
    trendDirection,
    trendSeconds,
    bigShift,
    last5: history.slice(-5).reverse().map(s => ({
      date:            s.date,
      name:            s.name,
      paceMPM:         s.paceMPM,
      avgHR:           s.avgHR,
      durationMin:     s.durationMin,
      efficiencyRatio: s.efficiencyRatio,
    })),
    history: history.map(s => ({ date: s.date, paceMPM: s.paceMPM })),
  };

  if (kvUrl && kvToken) {
    await kvPipeline(kvUrl, kvToken, [
      ['SET', histKey,  JSON.stringify(history)],
      ['SET', cacheKey, JSON.stringify(result), 'EX', 300],
    ]);
  }

  return res.status(200).json(result);
}

/* ════════════════════════════════════════════════════════════════════════════
   COACHING SUMMARY
   ════════════════════════════════════════════════════════════════════════════ */

const COACHING_SYSTEM_PROMPT = `You are an elite running coach with deep expertise in marathon and distance running training, drawing on the methodologies of Jack Daniels, Pete Pfitzinger, Renato Canova, and Stephen Seiler.

Write a coaching assessment of exactly 150–200 words. Structure it as four clear points:
1. ONE specific training priority for this phase (be concrete — name a workout type, pace, or metric)
2. Reference the actual data with specific numbers ("threshold improved 6 sec", "CTL at 38", etc.)
3. ONE specific workout recommendation with exact paces derived from their VDOT
4. ONE thing to monitor or watch based on current load or recovery

Rules:
- Written like a direct message from a knowledgeable coach, not a report
- No bullet points — flowing prose with clear structure
- Imperial units only (miles, min/mile)
- If VDOT is available, all pace references must use VDOT-derived paces
- Be honest if something looks off (threshold declining, ACWR high, etc.)
- Do not give generic advice — every sentence must reference the athlete's actual numbers
- Never use filler phrases like "great work" or "keep it up"`;

async function handleCoachingSummary(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'Anthropic API key not configured' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  let athleteId;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (!r.ok)           return res.status(502).json({ error: 'Could not verify session' });
    const a = await r.json();
    athleteId = String(a.id);
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  const cacheKey = `coaching-summary:${athleteId}:v2`;
  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, cacheKey);
    if (cached && Date.now() - (cached.generatedAt || 0) < 6 * 3600 * 1000) {
      return res.status(200).json(cached);
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const [
    intervalsData,
    threshHistory,
    threshCache,
    ouraData,
    histAnalysis,
    streamIndex,
  ] = await (kvUrl && kvToken ? Promise.all([
    kvGet(kvUrl, kvToken, `intervals:${athleteId}:wellness:${today}`),
    kvGet(kvUrl, kvToken, `threshold:${athleteId}:drift-history`),
    kvGet(kvUrl, kvToken, `threshold:${athleteId}:drift-cache`),
    kvGet(kvUrl, kvToken, `oura:${athleteId}:summary:${today}`),
    kvGet(kvUrl, kvToken, `history:${athleteId}:analysis`),
    kvGet(kvUrl, kvToken, `streams:${athleteId}:summary`),
  ]) : Promise.resolve([null, null, null, null, null, null]));

  const sections = [];

  if (intervalsData && intervalsData.available) {
    const { ctl, atl, tsb, rampRate, dataDate } = intervalsData;
    const acwr = ctl > 0 ? Math.round((atl / ctl) * 100) / 100 : null;
    sections.push(
      `TRAINING LOAD (Intervals.icu, ${dataDate}):` +
      `\n  CTL (Fitness): ${ctl}` +
      `\n  ATL (Fatigue): ${atl}` +
      `\n  TSB (Form): ${tsb}` +
      (rampRate != null ? `\n  Ramp Rate: ${rampRate > 0 ? '+' : ''}${rampRate} CTL/wk` : '') +
      (acwr != null ? `\n  ACWR: ${acwr} (sweet spot 0.8–1.3)` : '')
    );
  }

  const drift = threshCache || buildDriftSummary(threshHistory);
  if (drift && drift.currentEstimate) {
    const paceStr = fmtPace(drift.currentEstimate);
    const ago30   = drift.estimate30dAgo ? fmtPace(drift.estimate30dAgo) : null;
    const delta   = drift.trendSeconds != null
      ? (drift.trendSeconds < 0 ? `${Math.abs(drift.trendSeconds)}s faster` : `${drift.trendSeconds}s slower`)
      : null;
    sections.push(
      `THRESHOLD PACE TREND (${drift.totalSessions || 0} sessions analyzed):` +
      `\n  Current estimate: ${paceStr}/mile at HR ${drift.thresholdZone?.low || 165}–${drift.thresholdZone?.high || 178}` +
      (ago30 ? `\n  30 days ago: ${ago30}/mile` : '') +
      (delta ? `\n  Trend: ${delta} over last 4 sessions (${drift.trendDirection})` : '') +
      (drift.bigShift ? `\n  Warning: significant shift detected in last 2 weeks` : '')
    );
  }

  if (ouraData && ouraData.available) {
    const readiness = ouraData.todayReadiness;
    const hrvPct    = ouraData.todayHrvPct;
    const lines = [`RECOVERY (Oura, today):`];
    if (readiness != null) {
      const label = readiness >= 80 ? 'Ready' : readiness >= 60 ? 'Moderate' : 'Low';
      lines.push(`  Readiness: ${readiness} (${label})`);
    }
    if (hrvPct != null) {
      const sign = hrvPct >= 0 ? '+' : '';
      lines.push(`  HRV vs baseline: ${sign}${Math.round(hrvPct)}%`);
    }
    sections.push(lines.join('\n'));
  }

  if (histAnalysis) {
    const { races, mileage } = histAnalysis;
    const lines = ['TRAINING CONTEXT:'];
    if (races && races.length) {
      const recent = races[0];
      lines.push(`  Most recent race: ${recent.name} ${recent.timeStr} (${recent.date})`);
      if (recent.preRace) lines.push(`  Pre-race avg: ${recent.preRace.avgWeeklyMi}mi/wk`);
    }
    if (mileage) {
      lines.push(`  Current 4-week avg: ${mileage.recent4wkAvg}mi/wk`);
      if (mileage.peakWeekMi) lines.push(`  Peak week ever: ${mileage.peakWeekMi}mi`);
    }
    sections.push(lines.join('\n'));
  }

  if (streamIndex) {
    const lines = ['STREAM ANALYSIS (recent activities):'];
    if (streamIndex.avgZ2Pct != null)    lines.push(`  Avg Z2 time: ${streamIndex.avgZ2Pct}% of workouts`);
    if (streamIndex.avgZ5Pct != null)    lines.push(`  Avg Z5 time: ${streamIndex.avgZ5Pct}%`);
    if (streamIndex.avgRecoveryS != null) lines.push(`  Avg cardiac recovery (HRR/60s): ${streamIndex.avgRecoveryS} bpm`);
    if (streamIndex.lowZ5Weeks != null && streamIndex.lowZ5Weeks >= 3)
      lines.push(`  Warning: Z5 time <5% for ${streamIndex.lowZ5Weeks} consecutive weeks — VO2max work may be needed`);
    if (streamIndex.decliningRecovery)   lines.push(`  Warning: cardiac recovery declining — possible fatigue accumulation`);
    if (streamIndex.avgDecouplingPct != null && streamIndex.avgDecouplingPct > 5)
      lines.push(`  Warning: avg aerobic decoupling ${streamIndex.avgDecouplingPct}% — aerobic base or hydration concern`);
    if (streamIndex.lowZ2Warning)        lines.push(`  Warning: Z2 time below 40% of weekly training — insufficient easy work`);
    if (lines.length > 1) sections.push(lines.join('\n'));
  }

  const vdot = parseFloat(req.query.vdot) || null;
  if (vdot) {
    const paces = computeTrainingPaces(vdot);
    if (paces) {
      sections.push(
        `VDOT: ${vdot.toFixed(1)}` +
        `\n  Easy: ${fmtPace(paces.easy[1])}–${fmtPace(paces.easy[0])}/mi` +
        `\n  Marathon: ${fmtPace(paces.marathon[1])}–${fmtPace(paces.marathon[0])}/mi` +
        `\n  Threshold: ${fmtPace(paces.threshold[1])}–${fmtPace(paces.threshold[0])}/mi` +
        `\n  Interval: ${fmtPace(paces.interval[1])}–${fmtPace(paces.interval[0])}/mi`
      );
    }
  }

  if (sections.length === 0) {
    return res.status(200).json({ available: false, error: 'Insufficient data to generate summary' });
  }

  const context = sections.join('\n\n');
  let summary = '';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-opus-4-6',
        max_tokens: 512,
        system:     COACHING_SYSTEM_PROMPT,
        messages:   [{ role: 'user', content: `Here is this athlete's current training data:\n\n${context}\n\nWrite a 150–200 word coaching assessment with a clear priority, data reference, workout recommendation, and one thing to watch.` }],
      }),
    });
    if (r.ok) {
      const data = await r.json();
      summary = (data.content?.[0]?.text || '').trim();
    }
  } catch (_) {}

  if (!summary) {
    return res.status(200).json({ available: false, error: 'Could not generate coaching summary' });
  }

  const result = {
    available:   true,
    generatedAt: Date.now(),
    summary,
    dataUsed: {
      intervals: !!(intervalsData?.available),
      threshold: Array.isArray(threshHistory) ? threshHistory.length : 0,
      oura:      !!(ouraData?.available),
      history:   !!(histAnalysis),
      vdot,
    },
  };

  if (kvUrl && kvToken) await kvSet(kvUrl, kvToken, cacheKey, result);

  return res.status(200).json(result);
}

function buildDriftSummary(history) {
  if (!Array.isArray(history) || !history.length) return null;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const now    = Date.now();
  const DECAY  = 0.85;
  let wSum = 0, wTotal = 0;
  for (const s of sorted) {
    const wk = (now - new Date(s.date + 'T12:00:00Z').getTime()) / (7 * 86400 * 1000);
    const w  = Math.pow(DECAY, wk);
    wSum   += s.paceMPM * w;
    wTotal += w;
  }
  return { currentEstimate: wTotal > 0 ? wSum / wTotal : null, totalSessions: sorted.length };
}

function vAtPct(vdot, pct) {
  const target = vdot * pct;
  const a = 0.000104, b = 0.182258, c = -(4.60 + target);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

function computeTrainingPaces(vdot) {
  try {
    const mpm = v => 1609.34 / v;
    return {
      easy:      [mpm(vAtPct(vdot, 0.64)), mpm(vAtPct(vdot, 0.59))],
      marathon:  [mpm(vAtPct(vdot, 0.80)), mpm(vAtPct(vdot, 0.76))],
      threshold: [mpm(vAtPct(vdot, 0.88)), mpm(vAtPct(vdot, 0.83))],
      interval:  [mpm(vAtPct(vdot, 1.00)), mpm(vAtPct(vdot, 0.95))],
    };
  } catch (_) { return null; }
}

/* ════════════════════════════════════════════════════════════════════════════
   TRAINING SUMMARY (lap sync + aggregate)
   ════════════════════════════════════════════════════════════════════════════ */

async function handleTrainingSummary(req, res) {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  if (req.method === 'GET') {
    const accessToken = req.query.accessToken;
    if (!accessToken) return res.status(401).json({ error: 'accessToken required' });
    if (!kvUrl || !kvToken) return res.status(200).json({ summary: null, lastSyncAt: null });

    const athleteId = await getAthleteId(accessToken);
    if (!athleteId)  return res.status(200).json({ summary: null, lastSyncAt: null });

    try {
      const stored = await kvGet(kvUrl, kvToken, `training_summary:${athleteId}`);
      const fresh  = stored?.v >= 2;
      return res.status(200).json({
        summary:     fresh ? (stored.text || null) : null,
        lastSyncAt:  fresh ? (stored.updatedAt   || null) : null,
        syncedUntil: fresh ? (stored.syncedUntil || null) : null,
      });
    } catch (_) {
      return res.status(200).json({ summary: null, lastSyncAt: null, syncedUntil: null });
    }
  }

  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken, activities = [], threshPaceMin } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const thresh = parseFloat(threshPaceMin) || null;
  if (!kvUrl || !kvToken) {
    return res.status(200).json({ processed: 0, cached: 0, total: activities.length, done: true, summary: null });
  }

  const athleteId = await getAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  const qualified = activities
    .filter(shouldFetchLaps)
    .sort((a, b) => priorityScore(a) - priorityScore(b));

  const batch     = qualified.slice(0, 25);
  let processed   = 0;
  let cached      = 0;
  let rateLimited = false;

  for (let bStart = 0; bStart < batch.length; bStart += 5) {
    const micro = batch.slice(bStart, bStart + 5);

    const results = await Promise.all(micro.map(async (act) => {
      const cacheKey = `laps:${athleteId}:${act.id}`;
      try {
        const hit = await kvGet(kvUrl, kvToken, cacheKey);
        if (hit && hit.v === 2) return { type: 'cached', data: hit };
      } catch (_) {}

      try {
        const r = await fetch(
          `https://www.strava.com/api/v3/activities/${act.id}/laps`,
          { headers: { Authorization: `Bearer ${accessToken}` } }
        );
        if (r.status === 429) return { type: 'rate_limited' };
        if (!r.ok) return { type: 'error' };
        const laps = await r.json();
        if (!Array.isArray(laps) || laps.length < 2) return { type: 'skip' };

        const actAvgPaceMPM = actPaceMPM(act);
        const totalDistMi   = act.distance ? act.distance / 1609.34 : null;
        const classifiedLaps = classifyLaps(laps, thresh);
        const pattern        = detectPattern(classifiedLaps);
        const paceVariance   = computePaceVariance(classifiedLaps);
        const hardEfforts    = extractHardEfforts(classifiedLaps, actAvgPaceMPM, totalDistMi);

        const lapData = {
          v:                 2,
          activityId:        act.id,
          date:              act.date,
          name:              act.name || act.type || 'Run',
          type:              act.type,
          distMi:            act.distance ? Math.round(act.distance / 1609.34 * 10) / 10 : null,
          laps:              classifiedLaps,
          pattern,
          paceVariance,
          hardEffortSummary: hardEfforts ? hardEfforts.summary : null,
          hardEfforts,
          analyzedAt:        Date.now(),
        };

        await kvSet(kvUrl, kvToken, cacheKey, lapData);
        return { type: 'fetched', data: lapData };
      } catch (_) {
        return { type: 'error' };
      }
    }));

    for (const r of results) {
      if (r.type === 'fetched')           processed++;
      else if (r.type === 'cached')       cached++;
      else if (r.type === 'rate_limited') { rateLimited = true; break; }
    }
    if (rateLimited) break;

    if (bStart + 5 < batch.length) {
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }

  const allAnalyses = (await Promise.all(
    activities.map(act => act.id
      ? kvGet(kvUrl, kvToken, `laps:${athleteId}:${act.id}`).catch(() => null)
      : Promise.resolve(null)
    )
  )).filter(Boolean);

  const summaryText = buildSummaryText(allAnalyses);
  const done = qualified.length <= 25 && !rateLimited;

  if (summaryText) {
    try {
      const newestTs = activities.reduce((max, a) => {
        if (!a.date) return max;
        const ts = new Date(a.date + 'T12:00:00').getTime();
        return ts > max ? ts : max;
      }, 0);
      let prevSyncedUntil = 0;
      try {
        const prev = await kvGet(kvUrl, kvToken, `training_summary:${athleteId}`);
        prevSyncedUntil = prev?.syncedUntil || 0;
      } catch (_) {}

      await kvSet(kvUrl, kvToken, `training_summary:${athleteId}`, {
        v:           2,
        text:        summaryText,
        updatedAt:   Date.now(),
        syncedUntil: Math.max(newestTs, prevSyncedUntil),
      });
    } catch (_) {}
  }

  return res.status(200).json({
    processed,
    cached,
    total:       activities.length,
    done,
    rateLimited,
    summary:     summaryText,
  });
}

function shouldFetchLaps(act) {
  if (!act.id || !act.movingTime || act.movingTime < 300) return false;
  const wt = act.workoutType || 0;
  if (wt === 2 || wt === 3) return true;
  if (!act.distance) return false;
  const paceMPM = actPaceMPM(act);
  return paceMPM > 0 && paceMPM <= 8.5;
}

function priorityScore(act) {
  const wt     = act.workoutType || 0;
  const pace   = actPaceMPM(act);
  const distMi = act.distance ? act.distance / 1609.34 : 0;
  if (wt === 3)        return 0;
  if (pace < 8.0)      return 1;
  if (distMi > 10)     return 2;
  if (wt === 2)        return 3;
  return 4;
}

function actPaceMPM(act) {
  if (!act.distance || !act.movingTime) return 0;
  return (act.movingTime / 60) / (act.distance / 1609.34);
}

function computePaceVariance(classifiedLaps) {
  const paces = classifiedLaps.map(l => l.paceMPM).filter(Boolean);
  if (paces.length < 2) return null;
  const fastest = Math.min(...paces);
  const slowest = Math.max(...paces);
  const ratio   = slowest / fastest;
  return { fastest: r3(fastest), slowest: r3(slowest), ratio: r3(ratio), isWorkout: ratio > 1.15 };
}

function extractHardEfforts(classifiedLaps, actAvgPaceMPM, totalDistMi) {
  if (!actAvgPaceMPM || actAvgPaceMPM <= 0 || !classifiedLaps || classifiedLaps.length < 2) return null;
  const hardThreshold = actAvgPaceMPM * 0.9;
  const labeled = classifiedLaps.map(l => ({ ...l, isHard: l.paceMPM ? l.paceMPM < hardThreshold : false }));
  const groups  = [];
  labeled.forEach(l => {
    const kind = l.isHard ? 'hard' : 'easy';
    const last = groups[groups.length - 1];
    if (last && last.kind === kind) last.laps.push(l);
    else groups.push({ kind, laps: [l] });
  });
  const hardGroups = groups.filter(g => g.kind === 'hard');
  if (!hardGroups.length) return null;

  const reps = hardGroups.map(g => {
    const paces   = g.laps.map(l => l.paceMPM).filter(Boolean);
    const avgPace = paces.length ? paces.reduce((a, b) => a + b, 0) / paces.length : null;
    const distMi  = g.laps.reduce((s, l) => s + (l.distMi || 0), 0);
    return { avgPaceMPM: avgPace, distMi };
  });

  const avgHardPace = (() => {
    const v = reps.map(r => r.avgPaceMPM).filter(Boolean);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  })();
  const avgRepDist = (() => {
    const v = reps.map(r => r.distMi).filter(d => d > 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  })();

  const hasLeadingEasy  = groups[0]?.kind === 'easy';
  const hasTrailingEasy = groups[groups.length - 1]?.kind === 'easy';
  const recovGroups = groups.filter((g, i) => {
    if (g.kind !== 'easy') return false;
    if (hasLeadingEasy  && i === 0)                return false;
    if (hasTrailingEasy && i === groups.length - 1) return false;
    return true;
  });
  const avgRecovPace = (() => {
    const allLaps = recovGroups.flatMap(g => g.laps).filter(l => l.paceMPM);
    return allLaps.length ? allLaps.reduce((s, l) => s + l.paceMPM, 0) / allLaps.length : null;
  })();

  const repCount = hardGroups.length;
  let parseWarning = null;
  if (totalDistMi && avgRepDist && repCount) {
    const totalHardDist = avgRepDist * repCount;
    if (totalHardDist > totalDistMi * 0.4) {
      parseWarning = `hard volume ${totalHardDist.toFixed(2)}mi > 40% of ${totalDistMi.toFixed(2)}mi`;
    }
  }

  const distStr = avgRepDist ? fmtRepDist(avgRepDist) : '';
  let summary   = repCount > 1 ? `${repCount}×${distStr || 'rep'}`.trim() : `${distStr || 'hard effort'}`;
  if (avgHardPace)  summary += ` @ ${fmtPace(avgHardPace)}/mi`;
  if (avgRecovPace) summary += ` · recovery ${fmtPace(avgRecovPace)}/mi`;
  if (parseWarning) summary += ` [warning: ${parseWarning}]`;

  return {
    repCount,
    repPaces:           reps.map(r => r.avgPaceMPM ? r3(r.avgPaceMPM) : null).filter(Boolean),
    repDistances:       reps.map(r => r3(r.distMi)),
    avgHardPaceMPM:     avgHardPace  ? r3(avgHardPace)  : null,
    avgRepDistMi:       avgRepDist   ? r3(avgRepDist)   : null,
    avgRecoveryPaceMPM: avgRecovPace ? r3(avgRecovPace) : null,
    parseWarning,
    summary,
  };
}

function buildSummaryText(analyses) {
  if (!analyses || !analyses.length) return null;
  const valid = analyses.filter(a => a.pattern && a.pattern.type !== 'Unknown');
  if (!valid.length) return null;

  const DAY_NAMES    = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const typeCounts   = {};
  const intervalRecs = [];
  const easyByMonth  = {};
  const hardByDow    = {};

  valid.forEach(a => {
    const type = a.pattern.type;
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (a.date) {
      const dow   = new Date(a.date + 'T12:00:00').getDay();
      const month = a.date.slice(0, 7);
      if (type !== 'Easy Steady') hardByDow[dow] = (hardByDow[dow] || 0) + 1;
      if (type === 'Easy Steady' && a.pattern.stats?.avgPaceMPM) {
        if (!easyByMonth[month]) easyByMonth[month] = [];
        easyByMonth[month].push(a.pattern.stats.avgPaceMPM);
      }
    }
    if (type === 'Intervals' && a.pattern.stats?.avgHardPaceMPM) {
      intervalRecs.push({ date: a.date || '', pace: a.pattern.stats.avgHardPaceMPM });
    }
  });

  const lines = [];
  const typeList = Object.entries(typeCounts).sort(([, a], [, b]) => b - a)
    .map(([t, n]) => `${n} ${t}`).join(', ');
  lines.push(`Workout breakdown (90 days): ${typeList}`);

  if (intervalRecs.length >= 2) {
    const sorted  = [...intervalRecs].sort((a, b) => a.date.localeCompare(b.date));
    const oldest  = sorted[0];
    const newest  = sorted[sorted.length - 1];
    const diffSec = Math.round((oldest.pace - newest.pace) * 60);
    const trend   = diffSec > 5 ? `improving ${diffSec}s/mi` : diffSec < -5 ? `slowing ${Math.abs(diffSec)}s/mi` : 'stable';
    lines.push(`Interval pace trend: ${fmtPace(oldest.pace)} → ${fmtPace(newest.pace)}/mi (${trend})`);
  }

  const easyMonths = Object.entries(easyByMonth).sort(([a], [b]) => a.localeCompare(b));
  if (easyMonths.length >= 2) {
    const avgFirst = tsAvg(easyMonths[0][1]);
    const avgLast  = tsAvg(easyMonths[easyMonths.length - 1][1]);
    const diffSec  = Math.round((avgFirst - avgLast) * 60);
    const trend    = diffSec > 5 ? `${diffSec}s/mi faster (aerobic improvement)` :
                     diffSec < -5 ? `${Math.abs(diffSec)}s/mi slower (possible fatigue)` : 'stable';
    lines.push(`Easy run pace trend: ${fmtPace(avgFirst)} → ${fmtPace(avgLast)}/mi (${trend})`);
  }

  const sortedDays = Object.entries(hardByDow)
    .filter(([, n]) => n >= 2).sort(([, a], [, b]) => b - a).slice(0, 3)
    .map(([d]) => DAY_NAMES[parseInt(d)]);
  if (sortedDays.length) lines.push(`Typical quality days: ${sortedDays.join(', ')}`);

  const byDate      = [...valid].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const lastInterval = byDate.find(a => a.pattern.type === 'Intervals');
  const lastTempo    = byDate.find(a => a.pattern.type === 'Tempo');

  if (lastInterval) {
    const detail = lastInterval.hardEffortSummary || lastInterval.pattern.description;
    lines.push(`Last interval session: ${lastInterval.date} · "${lastInterval.name}" · ${detail}`);
  }
  if (lastTempo) {
    const detail = lastTempo.hardEffortSummary || lastTempo.pattern.description;
    lines.push(`Last tempo run: ${lastTempo.date} · "${lastTempo.name}" · ${detail}`);
  }

  const recentHard = byDate.filter(a => a.hardEffortSummary && a.pattern.type !== 'Easy Steady').slice(0, 5);
  if (recentHard.length) {
    const hardLines = recentHard.map(a => {
      let detail = a.hardEffortSummary || '';
      if (a.hardEfforts?.repPaces?.length > 1) {
        const splits = a.hardEfforts.repPaces.map(fmtPace).join(', ');
        detail += ` (splits: ${splits})`;
      }
      return `  ${a.date} "${a.name}" (${a.distMi ? a.distMi + 'mi' : '?mi'}): ${detail}`;
    });
    lines.push(`Recent quality sessions:\n${hardLines.join('\n')}`);
  }

  return lines.join('\n');
}

function fmtRepDist(distMi) {
  if (!distMi || distMi <= 0) return '?';
  if (distMi >= 0.1) return `${distMi.toFixed(2)}mi`;
  const ft = Math.round(distMi * 5280 / 50) * 50;
  return `${ft}ft`;
}

function r3(v)  { return Math.round((v || 0) * 1000) / 1000; }
function tsAvg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ════════════════════════════════════════════════════════════════════════════
   STREAM (single activity)
   ════════════════════════════════════════════════════════════════════════════ */

async function handleStream(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const { accessToken, activityId, activityType } = req.query;
  const maxHR = parseInt(req.query.maxHR) || null;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });
  if (!activityId)  return res.status(400).json({ error: 'activityId required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  let athleteId;
  try {
    athleteId = await getAthleteId(accessToken);
    if (!athleteId) return res.status(401).json({ error: 'Could not resolve athlete ID' });
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  const cacheKey = `streams:${athleteId}:${activityId}`;
  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, cacheKey);
    if (cached) return res.status(200).json({ ...cached, fromCache: true });
  }

  let rawStreams;
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/streams` +
      `?keys=heartrate,time,distance,velocity_smooth,altitude&key_by_type=true`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit' });
    if (!r.ok) return res.status(502).json({ error: `Strava error ${r.status}` });
    rawStreams = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'Network error fetching stream' });
  }

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

  if (kvUrl && kvToken) await kvSet(kvUrl, kvToken, cacheKey, analysis);

  return res.status(200).json({ ...analysis, fromCache: false });
}

/* ════════════════════════════════════════════════════════════════════════════
   STREAMS BATCH
   ════════════════════════════════════════════════════════════════════════════ */

async function handleStreamsBatch(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken, activities = [], maxHR } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  let athleteId;
  try {
    athleteId = await getAthleteId(accessToken);
    if (!athleteId) return res.status(401).json({ error: 'Could not resolve athlete ID' });
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  const candidates = activities.filter(a => (a.average_heartrate || 0) > 130 || (a.suffer_score || 0) > 30);
  if (!candidates.length) {
    return res.status(200).json({ processed: 0, skipped: 0, total: 0, athleteId });
  }

  let alreadyCached = new Set();
  if (kvUrl && kvToken) {
    const commands     = candidates.map(a => ['GET', `streams:${athleteId}:${a.id}`]);
    const cacheResults = await kvPipeline(kvUrl, kvToken, commands);
    candidates.forEach((a, i) => {
      if (cacheResults[i]?.result) alreadyCached.add(String(a.id));
    });
  }

  const needsFetch = candidates.filter(a => !alreadyCached.has(String(a.id)));
  const batch      = needsFetch.slice(0, 10);

  let processed = 0;
  await Promise.all(batch.map(async (a) => {
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/activities/${a.id}/streams` +
        `?keys=heartrate,time,distance,velocity_smooth,altitude&key_by_type=true`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
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
      if (kvUrl && kvToken) await kvSet(kvUrl, kvToken, `streams:${athleteId}:${a.id}`, analysis);
      processed++;
    } catch (_) {}
  }));

  return res.status(200).json({
    processed,
    skipped:  alreadyCached.size,
    total:    candidates.length,
    athleteId,
  });
}

/* ════════════════════════════════════════════════════════════════════════════
   STREAMS SUMMARY
   ════════════════════════════════════════════════════════════════════════════ */

async function handleStreamsSummary(req, res) {
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

  let z2Sum = 0, z5Sum = 0, recovSum = 0, recovCount = 0, dcSum = 0, dcCount = 0;
  let count = 0;
  const weeklyZ5 = {};

  for (const sa of analyses) {
    if (!sa.zones) continue;
    count++;
    z2Sum += sa.zones.z2?.pct || 0;
    z5Sum += sa.zones.z5?.pct || 0;
    if (sa.avgRecoveryS != null) { recovSum += sa.avgRecoveryS; recovCount++; }
    if (sa.decoupling?.available) { dcSum += sa.decoupling.pct || 0; dcCount++; }
    if (sa.analyzedAt) {
      const wk = isoWeek(new Date(sa.analyzedAt));
      if (!weeklyZ5[wk]) weeklyZ5[wk] = { z5sum: 0, n: 0 };
      weeklyZ5[wk].z5sum += sa.zones.z5?.pct || 0;
      weeklyZ5[wk].n++;
    }
  }

  const avgZ2Pct         = count > 0 ? Math.round(z2Sum / count) : null;
  const avgZ5Pct         = count > 0 ? Math.round(z5Sum / count) : null;
  const avgRecoveryS     = recovCount > 0 ? Math.round(recovSum / recovCount) : null;
  const avgDecouplingPct = dcCount > 0 ? Math.round(dcSum / dcCount * 10) / 10 : null;

  const wkKeys = Object.keys(weeklyZ5).sort().slice(-8);
  let lowZ5Weeks = 0;
  for (let i = wkKeys.length - 1; i >= 0; i--) {
    const wk = weeklyZ5[wkKeys[i]];
    if (wk.n > 0 && wk.z5sum / wk.n < 5) lowZ5Weeks++;
    else break;
  }

  let decliningRecovery = false;
  const recovActivities = analyses.filter(sa => sa.avgRecoveryS != null)
    .sort((a, b) => (a.analyzedAt || 0) - (b.analyzedAt || 0));
  if (recovActivities.length >= 8) {
    const recent4 = recovActivities.slice(-4).map(sa => sa.avgRecoveryS);
    const prior4  = recovActivities.slice(-8, -4).map(sa => sa.avgRecoveryS);
    const recentAvg = recent4.reduce((a, b) => a + b, 0) / 4;
    const priorAvg  = prior4.reduce((a, b) => a + b, 0) / 4;
    decliningRecovery = recentAvg < priorAvg * 0.88;
  }

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
}

function isoWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  const wn    = 1 + Math.round(((d - week1) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return `${d.getFullYear()}-W${String(wn).padStart(2, '0')}`;
}

/* ════════════════════════════════════════════════════════════════════════════
   CRON: INTERVALS.ICU WELLNESS REFRESH
   ════════════════════════════════════════════════════════════════════════════ */

async function handleCronIntervals(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) return res.status(401).send('Unauthorized');
  }

  const apiKey    = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;
  if (!apiKey || !athleteId) {
    return res.status(200).json({ ok: false, reason: 'Intervals.icu not configured' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(200).json({ ok: false, reason: 'KV not configured' });
  }

  const today    = new Date().toISOString().split('T')[0];
  const cacheKey = `intervals:${athleteId}:wellness:${today}`;
  const oldest   = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const authHdr  = 'Basic ' + Buffer.from('API_KEY:' + apiKey).toString('base64');
  const headers  = { Authorization: authHdr, Accept: 'application/json' };
  const base     = `https://intervals.icu/api/v1/athlete/${athleteId}`;

  try {
    const [wRes] = await Promise.all([
      fetch(`${base}/wellness?oldest=${oldest}&newest=${today}`, { headers }),
    ]);

    if (!wRes.ok) {
      return res.status(200).json({ ok: false, reason: `Intervals.icu returned ${wRes.status}` });
    }

    const wellnessData = await wRes.json();
    if (!Array.isArray(wellnessData) || !wellnessData.length) {
      return res.status(200).json({ ok: false, reason: 'Empty wellness response' });
    }

    const sorted  = [...wellnessData].sort((a, b) => b.id.localeCompare(a.id));
    const current = sorted.find(w => w.ctl != null) || {};

    const ctl      = current.ctl      != null ? Math.round(current.ctl)      : null;
    const atl      = current.atl      != null ? Math.round(current.atl)      : null;
    const tsb      = current.form     != null ? Math.round(current.form)
                   : (ctl != null && atl != null) ? ctl - atl : null;
    const rampRate = current.rampRate != null ? Math.round(current.rampRate * 10) / 10 : null;
    const dataDate = current.id || today;

    const history = wellnessData
      .filter(w => w.ctl != null)
      .map(w => {
        const c = Math.round(w.ctl || 0);
        const a = Math.round(w.atl || 0);
        return { date: w.id, ctl: c, atl: a, tsb: w.form != null ? Math.round(w.form) : c - a };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const result = { available: true, ctl, atl, tsb, rampRate, dataDate, history };

    await fetch(`${kvUrl}/set/${encodeURIComponent(cacheKey)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(result),
    });

    return res.status(200).json({ ok: true, ctl, atl, tsb, rampRate, dataDate });
  } catch (err) {
    return res.status(200).json({ ok: false, reason: err.message });
  }
}
