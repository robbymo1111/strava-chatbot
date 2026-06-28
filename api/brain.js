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
 * GET  ?action=weather            &accessToken=&lat=&lon=  (lat/lon optional — browser geolocation)
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
    case 'correlations':     return handleCorrelations(req, res);
    case 'weather':          return handleWeather(req, res);
    case 'dashboard':        return handleDashboard(req, res);
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
    if (speedRatio > 1.08) continue; // 8% max speed variance — keeps only steady-state threshold efforts
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
    athleteMemory,
  ] = await (kvUrl && kvToken ? Promise.all([
    kvGet(kvUrl, kvToken, `intervals:${athleteId}:wellness:${today}`),
    kvGet(kvUrl, kvToken, `threshold:${athleteId}:drift-history`),
    kvGet(kvUrl, kvToken, `threshold:${athleteId}:drift-cache`),
    kvGet(kvUrl, kvToken, `oura:${athleteId}:summary:v2:${today}`),
    kvGet(kvUrl, kvToken, `history:${athleteId}:analysis`),
    kvGet(kvUrl, kvToken, `streams:${athleteId}:summary`),
    kvGet(kvUrl, kvToken, `memory:${athleteId}`),
  ]) : Promise.resolve([null, null, null, null, null, null, null]));

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

  // Debrief pattern analysis
  const debriefPatterns = analyzeDebriefPatterns(athleteMemory, ouraData);
  if (debriefPatterns.length > 0) {
    sections.push(
      `VOICE DEBRIEF PATTERNS (last 2 weeks):\n` +
      debriefPatterns.map(p => `  - ${p}`).join('\n')
    );
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

/**
 * Analyze voice debrief history stored in memory for recurring patterns.
 * Looks for debrief_<activityId> keys within the last 14 days.
 * Returns an array of plain-English pattern insight strings.
 *
 * Pattern rules:
 * - Hip/knee/achilles tightness flagged 2+ times → surface injury risk
 * - Mental state consistently flat 2+ times → flag potential overtraining
 * - Cross-reference coachingFlags with Oura recovery when available
 *
 * @param {object|null} memoryData  - Full athlete memory object from KV
 * @param {object|null} ouraData    - Oura summary for today (may be null)
 * @returns {string[]}
 */
function analyzeDebriefPatterns(memoryData, ouraData) {
  if (!memoryData) return [];

  const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const insights = [];

  // Collect debriefs within the last 2 weeks
  const recentDebriefs = [];
  for (const [key, value] of Object.entries(memoryData)) {
    if (!key.startsWith('debrief_')) continue;
    if (!value || !value.storedAt) continue;
    if (value.storedAt < twoWeeksAgo) continue;
    recentDebriefs.push(value);
  }

  if (recentDebriefs.length === 0) return [];

  // Pattern 1: Injury risk — recurring tightness/pain in key joints
  const injuryKeywords = ['hip', 'knee', 'achilles', 'calf', 'it band', 'hamstring', 'shin', 'ankle', 'plantar'];
  const injuryCounts = {};
  for (const d of recentDebriefs) {
    const signals = (d.physicalSignals || []).concat(d.coachingFlags || []);
    for (const signal of signals) {
      const lower = signal.toLowerCase();
      for (const kw of injuryKeywords) {
        if (lower.includes(kw)) {
          injuryCounts[kw] = (injuryCounts[kw] || 0) + 1;
        }
      }
    }
  }
  for (const [kw, count] of Object.entries(injuryCounts)) {
    if (count >= 2) {
      insights.push(`Injury risk flag: "${kw}" mentioned in ${count} of the last ${recentDebriefs.length} debriefs — monitor closely`);
    }
  }

  // Pattern 2: Overtraining signal — flat/low mental state 2+ times
  const flatKeywords = ['flat', 'tired', 'exhausted', 'unmotivated', 'low', 'drained', 'heavy', 'sluggish'];
  let flatCount = 0;
  for (const d of recentDebriefs) {
    const state = (d.mentalState || '').toLowerCase();
    if (flatKeywords.some(kw => state.includes(kw))) flatCount++;
  }
  if (flatCount >= 2) {
    let overtrain = `Possible overtraining: mental state was flat/low in ${flatCount}/${recentDebriefs.length} recent debriefs`;
    if (ouraData?.available && ouraData.todayReadiness != null && ouraData.todayReadiness < 65) {
      overtrain += ` — Oura readiness is also low (${ouraData.todayReadiness}), corroborates fatigue signal`;
    }
    insights.push(overtrain);
  }

  // Pattern 3: Positive momentum — breakthrough flags
  const breakthroughFlags = recentDebriefs.flatMap(d =>
    (d.coachingFlags || []).filter(f => /breakthrough|pr|personal|strong|best/i.test(f))
  );
  if (breakthroughFlags.length > 0) {
    insights.push(`Breakthrough signal: athlete self-reported positive performance markers in recent debriefs — may indicate fitness peak`);
  }

  return insights;
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
  const weeklyZ5       = {};
  const weeklyRecovery = {};
  const weeklyZ2Pace   = {};

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
      if (sa.avgRecoveryS != null) {
        if (!weeklyRecovery[wk]) weeklyRecovery[wk] = { sum: 0, n: 0 };
        weeklyRecovery[wk].sum += sa.avgRecoveryS;
        weeklyRecovery[wk].n++;
      }
      if (sa.z2AvgPaceMPM) {
        if (!weeklyZ2Pace[wk]) weeklyZ2Pace[wk] = { sum: 0, n: 0 };
        weeklyZ2Pace[wk].sum += sa.z2AvgPaceMPM;
        weeklyZ2Pace[wk].n++;
      }
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
    weeklyRecovery: Object.fromEntries(
      wkKeys.map(k => [k, weeklyRecovery[k]
        ? Math.round(weeklyRecovery[k].sum / weeklyRecovery[k].n)
        : null])
    ),
    weeklyZ2Pace: Object.fromEntries(
      wkKeys.map(k => [k, weeklyZ2Pace[k]
        ? Math.round(weeklyZ2Pace[k].sum / weeklyZ2Pace[k].n * 100) / 100
        : null])
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
   OURA PERFORMANCE CORRELATIONS
   ════════════════════════════════════════════════════════════════════════════ */

async function handleCorrelations(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ available: false, reason: 'kv_not_configured' });

  let athleteId;
  try {
    athleteId = await getAthleteId(accessToken);
    if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  const cacheKey = `oura:${athleteId}:correlations`;
  const cached   = await kvGet(kvUrl, kvToken, cacheKey);
  if (cached && Date.now() - (cached.generatedAt || 0) < 24 * 3600 * 1000) {
    return res.status(200).json(cached);
  }

  // Load history meta
  const meta = await kvGet(kvUrl, kvToken, `history:${athleteId}:meta`);
  if (!meta || !meta.pages) {
    return res.status(200).json({ available: false, reason: 'no_history' });
  }

  // Load all pages (up to 20 × 200 = 4000 activities)
  const pageCount   = Math.min(meta.pages, 20);
  const pageResults = await kvPipeline(
    kvUrl, kvToken,
    Array.from({ length: pageCount }, (_, i) => ['GET', `history:${athleteId}:page:${i}`])
  );

  const sinceMs = Date.now() - 180 * 24 * 60 * 60 * 1000; // 6 months
  const allActs = [];
  for (const r of pageResults) {
    if (!r?.result) continue;
    try {
      const page = JSON.parse(r.result);
      if (Array.isArray(page)) {
        for (const a of page) {
          if (new Date(a.d + 'T12:00:00Z').getTime() >= sinceMs) allActs.push(a);
        }
      }
    } catch (_) {}
  }

  // Quality filter: meaningful training sessions with effort
  const quality = allActs.filter(a => {
    const isRun = /run/i.test(a.ty || '');
    if (isRun) return a.sec > 1200 && a.pa && a.pa < 10.0;
    return (a.hr || 0) > 130 || (a.ss || 0) > 30;
  });

  if (quality.length < 10) {
    return res.status(200).json({ available: false, reason: 'insufficient_data', pairCount: 0 });
  }

  quality.sort((a, b) => a.d.localeCompare(b.d));
  const activeDaySet = new Set(allActs.map(a => a.d));

  // Batch load Oura readiness + sleep + stream analysis (3 keys per activity)
  const cmds = [];
  for (const a of quality) {
    cmds.push(['GET', `oura:${athleteId}:readiness:${a.d}`]);
    cmds.push(['GET', `oura:${athleteId}:sleep:${a.d}`]);
    cmds.push(['GET', `streams:${athleteId}:${a.id}`]);
  }

  let batchRes = [];
  try { batchRes = await kvPipeline(kvUrl, kvToken, cmds); } catch (_) {}

  const makeGroup = () => ({ n: 0, paceSum: 0, paceN: 0, hrSum: 0, hrN: 0, recovSum: 0, recovN: 0 });
  const buckets = {
    hrv:       { above: makeGroup(), at: makeGroup(), below: makeGroup() },
    readiness: { high: makeGroup(), moderate: makeGroup(), low: makeGroup() },
    sleep:     { good: makeGroup(), moderate: makeGroup(), poor: makeGroup() },
    consec:    { one: makeGroup(), two: makeGroup(), three: makeGroup() },
  };
  let pairCount = 0;

  for (let i = 0; i < quality.length; i++) {
    const a      = quality[i];
    const ri     = i * 3;
    const rdData = _parseKV(batchRes[ri]);
    const slData = _parseKV(batchRes[ri + 1]);
    const stData = _parseKV(batchRes[ri + 2]);

    if (!rdData && !slData) continue;
    pairCount++;

    const isRun = /run/i.test(a.ty || '');
    const pace  = (isRun && a.pa) ? a.pa : null;
    const hr    = a.hr || null;
    const recov = stData?.avgRecoveryS ?? null;

    // HRV balance contributor (Oura readiness contributor score, 0–100)
    const hrvScore = rdData?.contributors?.hrv_balance;
    if (hrvScore != null) {
      const bkt = hrvScore >= 75 ? 'above' : hrvScore >= 50 ? 'at' : 'below';
      _accum(buckets.hrv[bkt], pace, hr, recov);
    }

    // Readiness score
    const rScore = rdData?.score;
    if (rScore != null) {
      const bkt = rScore >= 85 ? 'high' : rScore >= 70 ? 'moderate' : 'low';
      _accum(buckets.readiness[bkt], pace, hr, recov);
    }

    // Sleep duration
    const sleepMin = slData?.durationMin;
    if (sleepMin != null) {
      const hrs = sleepMin / 60;
      const bkt = hrs >= 7.5 ? 'good' : hrs >= 6 ? 'moderate' : 'poor';
      _accum(buckets.sleep[bkt], pace, hr, recov);
    }

    // Consecutive training days
    const prev1 = _shiftDay(a.d, -1);
    const prev2 = _shiftDay(a.d, -2);
    const cbkt  = activeDaySet.has(prev2) ? 'three' : activeDaySet.has(prev1) ? 'two' : 'one';
    _accum(buckets.consec[cbkt], pace, hr, recov);
  }

  if (pairCount < 10) {
    return res.status(200).json({ available: false, reason: 'insufficient_data', pairCount });
  }

  const result = {
    available:   true,
    generatedAt: Date.now(),
    pairCount,
    hrv:         _finalize(buckets.hrv),
    readiness:   _finalize(buckets.readiness),
    sleep:       _finalize(buckets.sleep),
    consecutive: _finalize(buckets.consec),
  };

  await kvPipeline(kvUrl, kvToken, [['SET', cacheKey, JSON.stringify(result), 'EX', 86400]]);

  return res.status(200).json(result);
}

function _parseKV(r) {
  if (!r?.result) return null;
  try { return JSON.parse(r.result); } catch (_) { return null; }
}

function _accum(g, pace, hr, recov) {
  g.n++;
  if (pace  != null) { g.paceSum  += pace;  g.paceN++;  }
  if (hr    != null) { g.hrSum    += hr;    g.hrN++;    }
  if (recov != null) { g.recovSum += recov; g.recovN++; }
}

function _finalize(groups) {
  const out = {};
  for (const [k, g] of Object.entries(groups)) {
    out[k] = {
      n:           g.n,
      avgPace:     g.paceN  >= 3 ? Math.round(g.paceSum  / g.paceN  * 100) / 100 : null,
      avgHR:       g.hrN    >= 3 ? Math.round(g.hrSum    / g.hrN)                 : null,
      avgRecovery: g.recovN >= 3 ? Math.round(g.recovSum / g.recovN)               : null,
    };
  }
  return out;
}

function _shiftDay(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split('T')[0];
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

/* ════════════════════════════════════════════════════════════════════════════
   WEATHER  (Open-Meteo — no API key required)
   ════════════════════════════════════════════════════════════════════════════ */

/**
 * GET /api/brain?action=weather&accessToken=xxx[&lat=42.36&lon=-71.06]
 *
 * Returns current conditions + hourly forecast + dewpoint-based coaching
 * recommendations tuned for a heavy sweater.
 *
 * Location resolution order:
 *   1. lat/lon query params (browser geolocation — most accurate)
 *   2. KV cache: weather:{athleteId}:location
 *   3. Strava athlete profile city → Open-Meteo geocoding
 *
 * Weather cache: weather:{athleteId}:current — 30-minute TTL
 */
async function handleWeather(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  // Resolve athlete ID
  let athleteId, athleteCity;
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (!r.ok)           return res.status(502).json({ error: 'Could not verify Strava session' });
    const a = await r.json();
    athleteId   = String(a.id);
    athleteCity = [a.city, a.state, a.country].filter(Boolean).join(', ');
  } catch (_) {
    return res.status(502).json({ error: 'Network error' });
  }

  // ── 30-minute KV cache for current conditions ──────────────────────────────
  const weatherCacheKey = `weather:${athleteId}:current`;
  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, weatherCacheKey);
    if (cached && Date.now() - (cached.fetchedAt || 0) < 30 * 60 * 1000) {
      return res.status(200).json({ ...cached, fromCache: true });
    }
  }

  // ── Resolve lat/lon ────────────────────────────────────────────────────────
  const locKey = `weather:${athleteId}:location`;
  let lat = parseFloat(req.query.lat) || null;
  let lon = parseFloat(req.query.lon) || null;

  if (!lat || !lon) {
    // Try KV-cached location first
    if (kvUrl && kvToken) {
      const loc = await kvGet(kvUrl, kvToken, locKey);
      if (loc?.lat && loc?.lon) { lat = loc.lat; lon = loc.lon; }
    }
    // Fall back to geocoding the Strava city
    if ((!lat || !lon) && athleteCity) {
      try {
        const geoRes = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(athleteCity)}&count=1`
        );
        if (geoRes.ok) {
          const geoData = await geoRes.json();
          const place   = geoData.results?.[0];
          if (place) {
            lat = place.latitude;
            lon = place.longitude;
            if (kvUrl && kvToken) {
              kvSet(kvUrl, kvToken, locKey, { lat, lon, name: place.name, country: place.country_code });
            }
          }
        }
      } catch (_) {}
    }
  } else {
    // Browser-provided lat/lon — update KV location cache
    if (kvUrl && kvToken) {
      kvSet(kvUrl, kvToken, locKey, { lat, lon, source: 'browser' });
    }
  }

  if (!lat || !lon) {
    return res.status(200).json({
      available: false,
      reason:    'location_unknown',
      message:   athleteCity
        ? `Could not geocode "${athleteCity}". Allow browser location for instant weather.`
        : 'No location found. Allow browser location or add your city to Strava.',
    });
  }

  // ── Fetch Open-Meteo ────────────────────────────────────────────────────────
  let weatherRaw;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,windspeed_10m,weathercode` +
      `&hourly=temperature_2m,relative_humidity_2m,dewpoint_2m,apparent_temperature` +
      `&temperature_unit=fahrenheit&windspeed_unit=mph&timezone=auto&forecast_days=1`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: `Open-Meteo returned ${r.status}` });
    weatherRaw = await r.json();
  } catch (_) {
    return res.status(502).json({ error: 'Could not reach Open-Meteo' });
  }

  // ── Extract current conditions ─────────────────────────────────────────────
  const cur  = weatherRaw.current || {};
  const hly  = weatherRaw.hourly  || {};

  const tempF     = cur.temperature_2m       != null ? Math.round(cur.temperature_2m)       : null;
  const feelsLike = cur.apparent_temperature != null ? Math.round(cur.apparent_temperature) : null;
  const humidity  = cur.relative_humidity_2m != null ? Math.round(cur.relative_humidity_2m) : null;
  const wind      = cur.windspeed_10m        != null ? Math.round(cur.windspeed_10m)        : null;
  const wcode     = cur.weathercode          != null ? cur.weathercode                       : 0;

  // Dewpoint from hourly data (pick the current hour index)
  const nowISO     = weatherRaw.current_weather?.time || new Date().toISOString().slice(0, 16);
  const hourTimes  = hly.time || [];
  let   hourIdx    = hourTimes.findIndex(t => t >= nowISO);
  if (hourIdx < 0) hourIdx = 0;

  let dewpointF = null;
  if (hly.dewpoint_2m?.[hourIdx] != null) {
    dewpointF = Math.round(hly.dewpoint_2m[hourIdx]);
  } else if (tempF != null && humidity != null) {
    // Magnus formula fallback: dp_C = T_C - (100 - RH) / 5, then convert to °F
    const tempC = (tempF - 32) * 5 / 9;
    const dpC   = tempC - (100 - humidity) / 5;
    dewpointF   = Math.round(dpC * 9 / 5 + 32);
  }

  // Weather code → human-readable condition
  const condition = weatherCondition(wcode);

  // ── Hourly forecast (next 8 hours) ────────────────────────────────────────
  const hourly = [];
  for (let i = hourIdx; i < Math.min(hourIdx + 8, hourTimes.length); i++) {
    const t  = hourTimes[i];
    const hr = t ? new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: weatherRaw.timezone || 'auto' }) : `${i}h`;
    const dpF = hly.dewpoint_2m?.[i] != null ? Math.round(hly.dewpoint_2m[i]) : null;
    const tF  = hly.temperature_2m?.[i] != null ? Math.round(hly.temperature_2m[i]) : null;
    const flF = hly.apparent_temperature?.[i] != null ? Math.round(hly.apparent_temperature[i]) : null;
    hourly.push({ hour: hr, temp: tF, feelsLike: flF, dewpoint: dpF });
  }

  // ── Best window: 2-hr block with lowest avg dewpoint ───────────────────────
  let bestWindow = null;
  const allHours = [];
  for (let i = 0; i < hourTimes.length; i++) {
    const dpF = hly.dewpoint_2m?.[i];
    const tF  = hly.temperature_2m?.[i];
    if (dpF == null || tF == null) continue;
    const t = hourTimes[i];
    const hNum = t ? new Date(t).getHours() : i;
    allHours.push({ idx: i, hNum, dpF: Math.round(dpF), tF: Math.round(tF), t });
  }
  let bestAvgDp = Infinity, bestIdx = 0;
  for (let i = 0; i + 1 < allHours.length; i++) {
    const avg = (allHours[i].dpF + allHours[i + 1].dpF) / 2;
    if (avg < bestAvgDp) { bestAvgDp = avg; bestIdx = i; }
  }
  if (allHours[bestIdx]) {
    const bh  = allHours[bestIdx];
    const lbl = new Date(bh.t).toLocaleTimeString('en-US', { hour: 'numeric', hour12: true, timeZone: weatherRaw.timezone || 'auto' });
    const flag = (bh.hNum < 8 || bh.hNum >= 19) ? ' (early/late — ideal timing)' : '';
    bestWindow = `${lbl} (dewpoint ${bh.dpF}°F, temp ${bh.tF}°F)${flag}`;
  }

  // ── Coaching recommendations ───────────────────────────────────────────────
  const coaching = dewpointCoaching(dewpointF, tempF, bestWindow);

  const result = {
    available:   true,
    fetchedAt:   Date.now(),
    lat, lon,
    temp:        tempF,
    dewpoint:    dewpointF,
    feelsLike,
    humidity,
    wind,
    condition,
    hourly,
    coaching,
  };

  if (kvUrl && kvToken) {
    await kvSet(kvUrl, kvToken, weatherCacheKey, result);
  }

  return res.status(200).json({ ...result, fromCache: false });
}

/* ── Dewpoint coaching for heavy sweater ─────────────────────────────────── */

/**
 * Build coaching recommendations keyed to the athlete's sweat profile.
 * All dewpoint thresholds are shifted 3°F lower vs standard because this
 * athlete is a heavy sweater who gets hot easily.
 *
 * Standard → Heavy-sweater (−3°F):
 *   <55 IDEAL      → <52
 *   55–60 COMF     → 52–57
 *   60–65 NOTICE   → 57–62
 *   65–70 UNCOMF   → 62–67
 *   70–75 OPPRESS  → 67–72
 *   >75  DANGER    → >72
 */
function dewpointCoaching(dewpointF, tempF, bestWindow) {
  if (dewpointF == null) {
    return { category: 'unknown', dewpointF: null, paceAdjustment: 'unknown',
             recommendation: 'Dewpoint data unavailable.', bestWindowToday: bestWindow };
  }

  // Extra temp adjustment
  let extraSec = 0;
  let tempWarning = '';
  if (tempF != null && tempF > 85) {
    extraSec    = 15;
    tempWarning = ' Morning-only strongly recommended (temp >85°F).';
  } else if (tempF != null && tempF > 80) {
    extraSec    = 10;
    tempWarning = ' High temperature adds another +10 sec/mile.';
  }

  let category, paceAdjustment, recommendation;

  if (dewpointF < 52) {
    category        = 'ideal';
    paceAdjustment  = extraSec > 0 ? `+${extraSec} sec/mile (temp only)` : 'none';
    recommendation  = `Perfect conditions for a heavy sweater. Run at full effort.${extraSec > 0 ? ` Despite the great dewpoint, the heat adds about +${extraSec} sec/mile.${tempWarning}` : ''}`;
  } else if (dewpointF < 57) {
    category        = 'comfortable';
    const base      = extraSec > 0 ? 5 + extraSec : 5;
    paceAdjustment  = `+${base}–${base + 5} sec/mile`;
    recommendation  = `Comfortable — light effect for a heavy sweater. Optional +${base}–${base + 5} sec/mile on easy runs. Quality workouts on target.${tempWarning}`;
  } else if (dewpointF < 62) {
    category        = 'noticeable';
    const lo        = 15 + extraSec, hi = 20 + extraSec;
    paceAdjustment  = `+${lo}–${hi} sec/mile`;
    recommendation  = `Noticeable for a heavy sweater (dewpoint ${dewpointF}°F). Add ${lo}–${hi} sec/mile on easy runs. Quality workouts at 90% target volume. Stay extra hydrated.${tempWarning}`;
  } else if (dewpointF < 67) {
    category        = 'uncomfortable';
    const lo        = 25 + extraSec, hi = 35 + extraSec;
    paceAdjustment  = `+${lo}–${hi} sec/mile`;
    recommendation  = `Uncomfortable for a heavy sweater (dewpoint ${dewpointF}°F). Add ${lo}–${hi} sec/mile. Reduce intervals by 1–2 reps and extend rest by 30–60 sec. Pre-load 20 oz fluids. Consider splitting long run.${tempWarning}`;
  } else if (dewpointF < 72) {
    category        = 'oppressive';
    const lo        = 35 + extraSec, hi = 50 + extraSec;
    paceAdjustment  = `+${lo}–${hi} sec/mile`;
    recommendation  = `Oppressive for a heavy sweater (dewpoint ${dewpointF}°F). Hard workouts not recommended — shift to evening/morning if possible. If you must run, cut volume 30–40%, add ${lo}–${hi} sec/mile, and abort if HR climbs >15 bpm above target for the effort.${tempWarning}`;
  } else {
    category        = 'dangerous';
    paceAdjustment  = 'easy/recovery only';
    recommendation  = `Dangerous dewpoint for a heavy sweater (${dewpointF}°F). Easy running ONLY — no quality work today regardless of plan. Run in the coolest window, carry water, run loops near home. Skip entirely if temp is also >85°F.${tempWarning}`;
  }

  return { category, dewpointF, paceAdjustment, recommendation, bestWindowToday: bestWindow };
}

/* ── Open-Meteo weather code → condition label ───────────────────────────── */

function weatherCondition(code) {
  if (code === 0)            return 'Clear';
  if (code <= 3)             return code === 1 ? 'Mostly Clear' : code === 2 ? 'Partly Cloudy' : 'Overcast';
  if (code === 45 || code === 48) return 'Foggy';
  if (code >= 51 && code <= 55)   return 'Drizzle';
  if (code >= 61 && code <= 65)   return 'Rain';
  if (code >= 71 && code <= 75)   return 'Snow';
  if (code >= 80 && code <= 82)   return 'Rain Showers';
  if (code >= 95)                 return 'Thunderstorm';
  return 'Mixed';
}

/* ════════════════════════════════════════════════════════════════════════════
   DASHBOARD — consolidated from api/dashboard.js
   GET /api/brain?action=dashboard&accessToken=xxx[&maxHR=&threshPaceMin=]
   Returns weeklyStats, weeklyBalance, trainingLoad, injuryRisk, fitnessTrend,
   activities (last 30 days), shoes, hrDriftTrend, bestEfforts.
   ════════════════════════════════════════════════════════════════════════════ */

async function handleDashboard(req, res) {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken   = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required.' });

  const threshPaceMin = parseFloat(req.query.threshPaceMin) || null;
  const personMaxHR   = parseInt(req.query.maxHR)           || null;
  const hrZonesDash   = dashGetHRZones(personMaxHR);

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  const actCacheKey = `dashboard:${accessToken.slice(-16)}:activities`;
  const since90 = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
  let activities = [];

  if (kvUrl && kvToken) {
    try {
      const cached = await dashKvGet(kvUrl, kvToken, actCacheKey);
      if (Array.isArray(cached) && cached.length > 0) activities = cached;
    } catch (_) {}
  }

  if (!activities.length) {
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?after=${since90}&per_page=200`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (r.status === 401) return res.status(401).json({ error: 'Strava session expired.' });
      if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit reached.' });
      if (!r.ok)           return res.status(502).json({ error: 'Could not fetch activities.' });
      activities = await r.json();
      if (kvUrl && kvToken && activities.length) {
        dashKvSetEx(kvUrl, kvToken, actCacheKey, activities, 600).catch(() => {});
      }
    } catch (err) {
      return res.status(502).json({ error: 'Network error fetching activities.' });
    }
  }

  activities.sort((a, b) =>
    new Date(b.start_date_local || b.start_date) - new Date(a.start_date_local || a.start_date)
  );

  dashClassifyActivities(activities, hrZonesDash);

  const weeklyStats   = dashGetWeeklyStats(activities);
  const weeklyBalance = dashGetWeeklyBalance(activities);
  const estimatedLoad = dashCalculateTrainingLoad(activities, threshPaceMin, personMaxHR);
  const fitnessTrend  = dashComputeFitnessTrend(activities);

  const [shoes, hrDriftTrend, intervalsWellness] = await Promise.all([
    dashFetchShoes(accessToken),
    dashGetHRDriftTrend(activities, accessToken),
    dashFetchIntervalsWellness(kvUrl, kvToken),
  ]);

  const trainingLoad = (intervalsWellness && intervalsWellness.available)
    ? {
        ctl:      intervalsWellness.ctl,
        atl:      intervalsWellness.atl,
        tsb:      intervalsWellness.tsb,
        rampRate: intervalsWellness.rampRate,
        acwr:     intervalsWellness.ctl > 0
                    ? Math.round((intervalsWellness.atl / intervalsWellness.ctl) * 100) / 100
                    : null,
        history:  intervalsWellness.history,
        source:   'intervals.icu',
        dataDate: intervalsWellness.dataDate,
      }
    : {
        ...estimatedLoad,
        acwr: estimatedLoad.ctl > 0
                ? Math.round((estimatedLoad.atl / estimatedLoad.ctl) * 100) / 100
                : null,
        source: 'estimated',
      };

  const injuryRisk  = dashAssessInjuryRisk(trainingLoad);
  const bestEfforts = intervalsWellness?.available ? (intervalsWellness.bestEfforts || null) : null;

  const cutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const activityList = activities
    .filter(a => new Date(a.start_date_local || a.start_date).getTime() > cutoff30)
    .slice(0, 40)
    .map(dashFormatActivity);

  return res.status(200).json({
    weeklyStats,
    weeklyBalance,
    trainingLoad,
    injuryRisk,
    fitnessTrend,
    bestEfforts,
    activities: activityList,
    shoes,
    hrDriftTrend,
  });
}

/* ── Dashboard helpers (namespaced to avoid collisions with brain.js helpers) ── */

function dashIsRun(a) { return /run/i.test(a.type || ''); }

function dashGetHRZones(maxHR) {
  if (!maxHR || maxHR < 100 || maxHR > 230) return null;
  return { recovery: maxHR * 0.63, easy: maxHR * 0.77, tempo: maxHR * 0.85, thresh: maxHR * 0.87 };
}

function dashClassifyRun(a, hrZones) {
  if (!dashIsRun(a)) return null;
  const durationMin = (a.moving_time || 0) / 60;
  const distMi      = (a.distance    || 0) / 1609.34;
  const avgSpeed    = a.average_speed;
  const avgPaceMPM  = avgSpeed ? 1609.34 / avgSpeed / 60 : null;
  const avgHR       = a.average_heartrate;
  const wt          = a.workout_type;
  if (wt === 1) return 'Race';
  if (wt === 2) return 'Long Run';
  if (wt === 3) return 'Workout';
  if (a.max_speed && avgSpeed > 0 && a.max_speed / avgSpeed > 1.9) return 'Workout';
  if (durationMin >= 90) return 'Long Run';
  if (durationMin <= 35 && distMi <= 4) return 'Recovery Run';
  if (avgHR) {
    if (hrZones) {
      if (avgHR < hrZones.recovery) return 'Recovery Run';
      if (avgHR < hrZones.easy)     return 'Easy Run';
      if (avgHR < hrZones.tempo)    return 'Tempo Run';
      return 'Workout';
    }
    if (avgHR < 135) return 'Recovery Run';
    if (avgHR < 150) return 'Easy Run';
    if (avgHR < 168) return 'Tempo Run';
    return 'Workout';
  }
  if (avgPaceMPM) {
    if (avgPaceMPM > 12.0) return 'Recovery Run';
    if (avgPaceMPM >  9.5) return 'Easy Run';
    if (avgPaceMPM >  7.5) return 'Tempo Run';
    return 'Workout';
  }
  return 'Easy Run';
}

function dashClassifyActivities(activities, hrZones) {
  activities.forEach(a => { a._classification = dashClassifyRun(a, hrZones); });
}

function dashGetWeeklyStats(activities) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week   = activities.filter(a =>
    dashIsRun(a) && new Date(a.start_date_local || a.start_date).getTime() > cutoff
  );
  let miles = 0, timeMin = 0, elevFt = 0;
  week.forEach(a => {
    miles   += (a.distance             || 0) / 1609.34;
    timeMin += (a.moving_time          || 0) / 60;
    elevFt  += (a.total_elevation_gain || 0) * 3.28084;
  });
  return {
    totalMiles:   Math.round(miles   * 10) / 10,
    totalTimeMin: Math.round(timeMin),
    totalElevFt:  Math.round(elevFt),
    runCount:     week.filter(dashIsRun).length,
  };
}

function dashGetWeeklyBalance(activities) {
  const cutoff   = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekRuns = activities.filter(a =>
    dashIsRun(a) && new Date(a.start_date_local || a.start_date).getTime() > cutoff
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
  const quality  = tempo + workout + race;
  const warnings = [];
  if (total >= 3) {
    if (quality > 2)   warnings.push('High intensity — more easy days would aid recovery');
    if (long === 0)    warnings.push('No long run this week');
    if (quality === 0 && total >= 4) warnings.push('All easy miles — consider one quality session');
    if (recovery > Math.ceil(total / 2) && total > 2) warnings.push('High recovery run count — possible accumulated fatigue');
  }
  return { total, quality, easy, long, tempo, workout, recovery, race, warnings };
}

function dashCalculateTSS(a, threshPaceMin, personMaxHR) {
  const durationH = (a.moving_time || 0) / 3600;
  if (durationH < 5 / 60) return 0;
  const avgHR = a.average_heartrate, actMaxHR = a.max_heartrate;
  const type = (a.type || '').toLowerCase(), cls = a._classification;
  let IF = 0.65;
  if (avgHR) {
    const threshHR = personMaxHR ? personMaxHR * 0.87 : (actMaxHR ? actMaxHR * 0.90 : avgHR * 1.1);
    IF = avgHR / threshHR;
  } else if (a.average_speed && /run/i.test(type)) {
    const mpm = 1609.34 / a.average_speed / 60;
    IF = (threshPaceMin || 7.5) / mpm;
  } else {
    const map = { 'Recovery Run': 0.55, 'Easy Run': 0.65, 'Long Run': 0.65, 'Tempo Run': 0.85, 'Workout': 0.95, 'Race': 1.0 };
    if (map[cls]) IF = map[cls];
    else if (/ride|cycling/i.test(type)) IF = 0.70;
    else if (/swim/i.test(type))         IF = 0.75;
    else if (/weight|strength/i.test(type)) IF = 0.55;
  }
  IF = Math.min(Math.max(IF, 0.4), 1.15);
  return durationH * IF * IF * 100;
}

function dashCalculateTrainingLoad(activities, threshPaceMin, personMaxHR) {
  const dailyTSS = {};
  activities.forEach(a => {
    const d = new Date(a.start_date_local || a.start_date).toISOString().split('T')[0];
    dailyTSS[d] = (dailyTSS[d] || 0) + dashCalculateTSS(a, threshPaceMin, personMaxHR);
  });
  const today = new Date(); today.setHours(23, 59, 59, 999);
  const history = [];
  let ctl = 0, atl = 0;
  for (let i = 89; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    const tss = dailyTSS[key] || 0;
    ctl = ctl + (tss - ctl) / 42;
    atl = atl + (tss - atl) / 7;
    history.push({ date: key, tss: Math.round(tss), ctl: Math.round(ctl * 10) / 10, atl: Math.round(atl * 10) / 10, tsb: Math.round((ctl - atl) * 10) / 10 });
  }
  const cur = history[history.length - 1];
  return { ctl: cur.ctl, atl: cur.atl, tsb: cur.tsb, history };
}

function dashAssessInjuryRisk({ ctl, atl, tsb }) {
  const acwr = ctl > 0 ? atl / ctl : 1;
  if (acwr > 1.5 || tsb < -25) {
    return { level: 'HIGH', reason: acwr > 1.5 ? `Fatigue ${Math.round((acwr - 1) * 100)}% above fitness baseline (ACWR ${acwr.toFixed(2)})` : `TSB ${Math.round(tsb)} — deep fatigue, back off` };
  }
  if (acwr > 1.3 || tsb < -15) {
    return { level: 'MODERATE', reason: acwr > 1.3 ? `Fatigue ${Math.round((acwr - 1) * 100)}% above fitness baseline — monitor recovery` : `TSB ${Math.round(tsb)} — accumulating fatigue` };
  }
  return { level: 'LOW', reason: 'Training load is manageable' };
}

function dashComputeFitnessTrend(activities) {
  const DAY = 24 * 60 * 60 * 1000, now = Date.now();
  const runs = activities.filter(a => dashIsRun(a) && a.average_speed);
  const recent = runs.filter(a => new Date(a.start_date_local || a.start_date).getTime() > now - 7 * DAY);
  const prior  = runs.filter(a => {
    const t = new Date(a.start_date_local || a.start_date).getTime();
    return t > now - 28 * DAY && t < now - 21 * DAY;
  });
  if (!recent.length || !prior.length) return null;
  const avgPace = arr => arr.reduce((s, a) => s + 1609.34 / a.average_speed / 60, 0) / arr.length;
  const rp = avgPace(recent), pp = avgPace(prior), delta = rp - pp;
  return {
    direction:  Math.abs(delta) < 0.2 ? 'stable' : delta < 0 ? 'improving' : 'declining',
    recentPace: Math.round(rp * 100) / 100,
    priorPace:  Math.round(pp * 100) / 100,
    delta:      Math.round(delta * 100) / 100,
  };
}

function dashFormatActivity(a) {
  const date = new Date(a.start_date_local || a.start_date);
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const distMi = a.distance ? Math.round(a.distance / 1609.34 * 100) / 100 : null;
  const durMin = a.moving_time ? Math.round(a.moving_time / 60) : null;
  let pace = null;
  if (a.average_speed && dashIsRun(a)) {
    const mpm = 1609.34 / a.average_speed / 60;
    pace = `${Math.floor(mpm)}:${String(Math.round((mpm - Math.floor(mpm)) * 60)).padStart(2, '0')}`;
  }
  return {
    id: a.id, date: dateStr, ts: date.getTime(),
    name: a.name || a.type, type: a.type,
    movingTime: a.moving_time || 0, distance: a.distance || 0, distMi, durationMin: durMin,
    pace, avgHR: a.average_heartrate ? Math.round(a.average_heartrate) : null,
    elevFt: a.total_elevation_gain ? Math.round(a.total_elevation_gain * 3.28084) : 0,
    classification: a._classification || null,
  };
}

async function dashFetchShoes(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return [];
    const athlete = await r.json();
    return (athlete.shoes || []).map(s => ({
      id: s.id, name: s.name || s.nickname || 'Unknown Shoe',
      brand: s.brand_name || null, distanceMi: Math.round((s.distance || 0) / 1609.34),
    }));
  } catch (_) { return []; }
}

async function dashCalcAerobicDecoupling(activityId, accessToken) {
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=heartrate,velocity_smooth,time&key_by_type=true&resolution=medium`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) return null;
    const streams = await r.json();
    const hrData = streams.heartrate?.data, velData = streams.velocity_smooth?.data, timeData = streams.time?.data;
    if (!hrData || !velData || !timeData || hrData.length < 20) return null;
    const totalDur = timeData[timeData.length - 1];
    let startIdx = 0, endIdx = timeData.length - 1;
    for (let i = 0; i < timeData.length; i++) { if (timeData[i] >= 600) { startIdx = i; break; } }
    for (let i = timeData.length - 1; i >= 0; i--) { if (timeData[i] <= totalDur - 300) { endIdx = i; break; } }
    if (endIdx - startIdx < 10) return null;
    const hrT = hrData.slice(startIdx, endIdx + 1), velT = velData.slice(startIdx, endIdx + 1);
    const n = hrT.length, velMean = velT.reduce((s, v) => s + v, 0) / n;
    if (velMean < 0.5) return null;
    const velStd = Math.sqrt(velT.reduce((s, v) => s + (v - velMean) ** 2, 0) / n);
    if (velStd / velMean > 0.08) return null;
    const mid = Math.floor(n / 2);
    const ef1 = velT.slice(0, mid).reduce((s, v) => s + v, 0) / hrT.slice(0, mid).reduce((s, v) => s + v, 0);
    const ef2 = velT.slice(mid).reduce((s, v) => s + v, 0) / hrT.slice(mid).reduce((s, v) => s + v, 0);
    if (!ef1) return null;
    return Math.round((ef1 - ef2) / ef1 * 1000) / 10;
  } catch (_) { return null; }
}

async function dashGetHRDriftTrend(activities, accessToken) {
  const longRuns = activities.filter(a => dashIsRun(a) && (a.moving_time || 0) >= 3600).slice(0, 5);
  if (!longRuns.length) return [];
  const results = await Promise.all(longRuns.map(async (a) => {
    const driftPct = await dashCalcAerobicDecoupling(a.id, accessToken);
    if (driftPct === null) return null;
    return {
      date:     new Date(a.start_date_local || a.start_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      name:     a.name || 'Long Run',
      distMi:   Math.round((a.distance || 0) / 1609.34 * 10) / 10,
      driftPct, flag: driftPct > 5,
    };
  }));
  return results.filter(Boolean).reverse();
}

async function dashFetchIntervalsWellness(kvUrl, kvToken) {
  const apiKey = process.env.INTERVALS_API_KEY, athleteId = process.env.INTERVALS_ATHLETE_ID;
  if (!apiKey || !athleteId) return null;
  const today = new Date().toISOString().split('T')[0];
  const cacheKey = `intervals:${athleteId}:wellness:${today}`;
  if (kvUrl && kvToken) {
    try { const c = await dashKvGet(kvUrl, kvToken, cacheKey); if (c?.available) return c; } catch (_) {}
  }
  const auth = Buffer.from('API_KEY:' + apiKey).toString('base64');
  const oldest = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  try {
    const [wRes, pcRes] = await Promise.all([
      fetch(`https://intervals.icu/api/v1/athlete/${athleteId}/wellness?oldest=${oldest}&newest=${today}`, { headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } }),
      fetch(`https://intervals.icu/api/v1/athlete/${athleteId}/power-curves?type=Run&curves=year`, { headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' } }).catch(() => null),
    ]);
    if (!wRes.ok) return null;
    const wd = await wRes.json();
    if (!Array.isArray(wd) || !wd.length) return null;
    const sorted = [...wd].sort((a, b) => b.id.localeCompare(a.id));
    const cur = sorted.find(w => w.ctl != null) || {};
    const ctl = cur.ctl != null ? Math.round(cur.ctl) : null;
    const atl = cur.atl != null ? Math.round(cur.atl) : null;
    const tsb = cur.form != null ? Math.round(cur.form) : (ctl != null && atl != null ? ctl - atl : null);
    const history = wd.filter(w => w.ctl != null).map(w => {
      const c = Math.round(w.ctl || 0), a = Math.round(w.atl || 0);
      return { date: w.id, ctl: c, atl: a, tsb: w.form != null ? Math.round(w.form) : c - a };
    }).sort((a, b) => a.date.localeCompare(b.date));
    let bestEfforts = null;
    if (pcRes?.ok) { try { bestEfforts = dashParseRunPowerCurves(await pcRes.json()); } catch (_) {} }
    const result = { available: true, dataDate: cur.id || today, ctl, atl, tsb, rampRate: cur.rampRate != null ? Math.round(cur.rampRate * 10) / 10 : null, history, bestEfforts };
    if (kvUrl && kvToken) { try { await dashKvSetEx(kvUrl, kvToken, cacheKey, result, 3600); } catch (_) {} }
    return result;
  } catch (_) { return null; }
}

function dashParseRunPowerCurves(pcData) {
  try {
    const sets = Array.isArray(pcData) ? pcData : [pcData];
    const cs = sets.find(s => s && (s.secs || (s.run && s.run.secs))) || sets[0];
    if (!cs) return null;
    const secsArr = cs.secs || (cs.run && cs.run.secs) || null;
    const velArr  = cs.velocity || (cs.run && cs.run.velocity) || null;
    if (!secsArr || !velArr || secsArr.length !== velArr.length) return null;
    const lookup = {};
    for (let i = 0; i < secsArr.length; i++) { if (velArr[i] != null) lookup[secsArr[i]] = velArr[i]; }
    const targets = [
      { label: '1 Mile', distM: 1609.34, candidates: [240, 270, 300, 360, 420] },
      { label: '5K',     distM: 5000,    candidates: [780, 840, 900, 960, 1080, 1200] },
      { label: '10K',    distM: 10000,   candidates: [1680, 1800, 1920, 2100, 2400] },
    ];
    const results = [];
    for (const t of targets) {
      let bestVel = null, bestDur = null;
      for (const dur of t.candidates) { const v = lookup[dur]; if (v && v > 0 && (bestVel === null || v > bestVel)) { bestVel = v; bestDur = dur; } }
      if (!bestVel) continue;
      const paceMPM = 1609.34 / bestVel / 60;
      const m = Math.floor(paceMPM), s = Math.round((paceMPM - m) * 60);
      const timeSec = Math.round(t.distM / bestVel);
      const h = Math.floor(timeSec / 3600), mm = Math.floor((timeSec % 3600) / 60), ss = timeSec % 60;
      results.push({ label: t.label, timeSec, timeStr: h > 0 ? `${h}:${String(mm).padStart(2,'0')}:${String(ss).padStart(2,'0')}` : `${mm}:${String(ss).padStart(2,'0')}`, paceStr: `${m}:${String(s).padStart(2,'0')}` });
    }
    return results.length ? results : null;
  } catch (_) { return null; }
}

async function dashKvGet(url, token, key) {
  try {
    const r = await fetch(`${url}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${token}` } });
    const d = await r.json();
    if (!d.result) return null;
    return JSON.parse(d.result);
  } catch (_) { return null; }
}

async function dashKvSetEx(url, token, key, value, ttl) {
  await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttl]]),
  });
}
