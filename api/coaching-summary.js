'use strict';

/**
 * GET /api/coaching-summary?accessToken=xxx&vdot=52.4&maxHR=187
 *
 * Reads cached data from KV (CTL/ATL/TSB, threshold drift, Oura, history analysis),
 * calls Claude to generate a 150–200 word personalized coaching assessment.
 * Cached for 6 hours; cache busted after new activity (via webhook).
 *
 * KV key: coaching-summary:{athleteId}:v2
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken  = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'Anthropic API key not configured' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  /* ── Resolve athlete ID ── */
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

  /* ── Serve from cache if < 6 hours ── */
  if (kvUrl && kvToken) {
    const cached = await kvGet(kvUrl, kvToken, cacheKey);
    if (cached && Date.now() - (cached.generatedAt || 0) < 6 * 3600 * 1000) {
      return res.status(200).json(cached);
    }
  }

  /* ── Read all data sources from KV in parallel ── */
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

  /* ── Build data context for Claude ── */
  const sections = [];

  // Training load
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

  // Threshold drift
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
      (drift.bigShift ? `\n  ⚠ Significant shift detected in last 2 weeks` : '')
    );
  }

  // Oura recovery
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

  // History analysis highlights
  if (histAnalysis) {
    const { races, mileage } = histAnalysis;
    const lines = ['TRAINING CONTEXT:'];
    if (races && races.length) {
      const recent = races[0];
      lines.push(`  Most recent race: ${recent.name} ${recent.timeStr} (${recent.date})`);
      if (recent.preRace) {
        lines.push(`  Pre-race avg: ${recent.preRace.avgWeeklyMi}mi/wk`);
      }
    }
    if (mileage) {
      lines.push(`  Current 4-week avg: ${mileage.recent4wkAvg}mi/wk`);
      if (mileage.peakWeekMi) lines.push(`  Peak week ever: ${mileage.peakWeekMi}mi`);
    }
    sections.push(lines.join('\n'));
  }

  // Stream analysis aggregate (written by streams-summary cron or batch)
  if (streamIndex) {
    const lines = ['STREAM ANALYSIS (recent activities):'];
    if (streamIndex.avgZ2Pct != null)    lines.push(`  Avg Z2 time: ${streamIndex.avgZ2Pct}% of workouts`);
    if (streamIndex.avgZ5Pct != null)    lines.push(`  Avg Z5 time: ${streamIndex.avgZ5Pct}%`);
    if (streamIndex.avgRecoveryS != null) lines.push(`  Avg cardiac recovery (HRR/60s): ${streamIndex.avgRecoveryS} bpm`);
    if (streamIndex.lowZ5Weeks != null && streamIndex.lowZ5Weeks >= 3)
      lines.push(`  ⚠ Z5 time <5% for ${streamIndex.lowZ5Weeks} consecutive weeks — VO2max work may be needed`);
    if (streamIndex.decliningRecovery)   lines.push(`  ⚠ Cardiac recovery declining — possible fatigue accumulation`);
    if (streamIndex.avgDecouplingPct != null && streamIndex.avgDecouplingPct > 5)
      lines.push(`  ⚠ Avg aerobic decoupling ${streamIndex.avgDecouplingPct}% — aerobic base or hydration concern`);
    if (streamIndex.lowZ2Warning)        lines.push(`  ⚠ Z2 time below 40% of weekly training — insufficient easy work`);
    if (lines.length > 1) sections.push(lines.join('\n'));
  }

  // VDOT from query params (passed from frontend memory)
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

  /* ── Call Claude ── */
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
        messages:   [{ role: 'user', content: buildCoachingPrompt(context) }],
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
    available:    true,
    generatedAt:  Date.now(),
    summary,
    dataUsed: {
      intervals: !!(intervalsData?.available),
      threshold: Array.isArray(threshHistory) ? threshHistory.length : 0,
      oura:      !!(ouraData?.available),
      history:   !!(histAnalysis),
      vdot:      vdot,
    },
  };

  if (kvUrl && kvToken) {
    await kvSet(kvUrl, kvToken, cacheKey, result);
  }

  return res.status(200).json(result);
};

/* ── System prompt ── */

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

function buildCoachingPrompt(context) {
  return `Here is this athlete's current training data:\n\n${context}\n\nWrite a 150–200 word coaching assessment with a clear priority, data reference, workout recommendation, and one thing to watch.`;
}

/* ── VDOT math (Daniels' Running Formula, 3rd ed.) ── */

function vAtPct(vdot, pct) {
  const target = vdot * pct;
  const a = 0.000104, b = 0.182258, c = -(4.60 + target);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

function vVO2max(vdot) {
  const a = 0.000104, b = 0.182258, c = -(vdot + 4.60);
  return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
}

function computeTrainingPaces(vdot) {
  try {
    const vMax = vVO2max(vdot);
    const mpm  = v => 1609.34 / v;
    return {
      easy:      [mpm(vAtPct(vdot, 0.64)), mpm(vAtPct(vdot, 0.59))],
      marathon:  [mpm(vAtPct(vdot, 0.80)), mpm(vAtPct(vdot, 0.76))],
      threshold: [mpm(vAtPct(vdot, 0.88)), mpm(vAtPct(vdot, 0.83))],
      interval:  [mpm(vAtPct(vdot, 1.00)), mpm(vAtPct(vdot, 0.95))],
      rep:       [mpm(vMax * 1.15), mpm(vMax * 1.05)],
    };
  } catch (_) { return null; }
}

function fmtPace(mpm) {
  if (!mpm) return '?:??';
  const m = Math.floor(mpm);
  const s = Math.round((mpm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildDriftSummary(history) {
  if (!Array.isArray(history) || !history.length) return null;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const now = Date.now();
  const DECAY = 0.85;
  let wSum = 0, wTotal = 0;
  for (const s of sorted) {
    const wk = (now - new Date(s.date + 'T12:00:00Z').getTime()) / (7 * 86400 * 1000);
    const w  = Math.pow(DECAY, wk);
    wSum   += s.paceMPM * w;
    wTotal += w;
  }
  return { currentEstimate: wTotal > 0 ? wSum / wTotal : null, totalSessions: sorted.length };
}

/* ── KV helpers ── */

async function kvGet(url, token, key) {
  try {
    const r    = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch (_) { return null; }
}

async function kvSet(url, token, key, value) {
  try {
    await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['SET', key, JSON.stringify(value)]]),
    });
  } catch (_) {}
}
