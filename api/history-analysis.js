/**
 * POST /api/history-analysis
 * Body: { accessToken }
 *
 * Reads all stored history pages from KV, runs pattern analysis, and stores
 * the result in history:{athleteId}:analysis.
 *
 * Analysis is computed from activity-level data (no lap data required):
 *   - Race history with pre-race training context
 *   - Aerobic efficiency trend (quarterly easy run pace/HR)
 *   - Mileage milestones and best training blocks
 *   - Pattern insights (what correlated with best races)
 *
 * Returns the full analysis object (also stored in KV for chat.js to read).
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ error: 'KV not configured' });

  const athleteId = await resolveAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  const metaKey      = `history:${athleteId}:meta`;
  const analysisKey  = `history:${athleteId}:analysis`;

  // ── Read meta ──
  const meta = await kvGetJSON(kvUrl, kvToken, metaKey);
  if (!meta || !meta.complete) {
    return res.status(200).json({ error: 'History sync not complete yet', notReady: true });
  }

  // ── Read all pages in parallel ──
  const pageKeys = [];
  for (let i = 0; i < meta.pages; i++) {
    pageKeys.push(`history:${athleteId}:page:${i}`);
  }

  const pageResults = await Promise.all(
    pageKeys.map(k => kvGetJSON(kvUrl, kvToken, k))
  );

  const activities = pageResults
    .filter(Boolean)
    .flat()
    .filter(a => a && a.d && a.id);

  if (activities.length === 0) {
    return res.status(200).json({ error: 'No activity data found' });
  }

  // Sort oldest → newest
  activities.sort((a, b) => a.d.localeCompare(b.d));

  // ── Run analysis ──
  const runs      = activities.filter(a => /run/i.test(a.ty || ''));
  const races     = buildRaceHistory(runs, activities);
  const efficiency = computeAerobicEfficiency(runs);
  const mileage   = computeMileageStats(runs);
  const intervals = computeIntervalTrends(runs);
  const patterns  = derivePatterns(races, runs);

  const analysis = {
    v:          1,
    builtAt:    Date.now(),
    meta: {
      totalActivities: activities.length,
      totalRuns:       runs.length,
      oldestDate:      meta.oldestDate,
      newestDate:      meta.newestDate,
    },
    races,
    efficiency,
    mileage,
    intervals,
    patterns,
    text: buildCoachingText({ races, efficiency, mileage, intervals, patterns,
                              totalActivities: activities.length,
                              oldestDate: meta.oldestDate }),
  };

  await kvSetJSON(kvUrl, kvToken, analysisKey, analysis);

  return res.status(200).json(analysis);
};

/* ── Race history ───────────────────────────────────────────────────────── */

function isRaceActivity(a) {
  if (a.wt === 1) return true;
  const nm = (a.nm || '').toLowerCase();
  return /\bmarathon\b|\b5 ?k\b|\b10 ?k\b|\bhalf\b|\brace\b|\bchampionship\b|\bprix\b/.test(nm)
      && a.mi >= 3; // avoid short races being false positives
}

function fmtTimeSec(secs) {
  if (!secs) return '?';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.round(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  return `${m}:${String(s).padStart(2,'0')}`;
}

function fmtPaceMPM(mpm) {
  if (!mpm) return '?:??';
  const m = Math.floor(mpm);
  const s = Math.round((mpm - m) * 60);
  return `${m}:${String(s).padStart(2,'0')}`;
}

function guessRaceLabel(a) {
  const nm  = (a.nm || '').toLowerCase();
  const mi  = a.mi || 0;
  if (mi >= 25 || /marathon/.test(nm)) return 'Marathon';
  if (mi >= 12 || /half/.test(nm))     return 'Half Marathon';
  if (mi >= 5.9 || /10k/.test(nm))     return '10K';
  if (mi >= 2.9 || /5k/.test(nm))      return '5K';
  return `${mi.toFixed(1)}mi race`;
}

function buildRaceHistory(runs, allActivities) {
  const raceRuns = runs.filter(isRaceActivity);
  return raceRuns.map(race => {
    const timeSec = race.sec || 0;
    const pace    = race.pa || null;
    const label   = guessRaceLabel(race);

    // Pre-race training block: 8 weeks (56 days) before the race
    const raceDateTs = new Date(race.d).getTime();
    const blockStart = raceDateTs - 56 * 86400 * 1000;
    const block = runs.filter(a => {
      const ts = new Date(a.d).getTime();
      return ts >= blockStart && ts < raceDateTs;
    });

    // Weekly mileage in the 8-week block
    const weekMiles = {};
    block.forEach(a => {
      const weeksOut = Math.floor((raceDateTs - new Date(a.d).getTime()) / (7 * 86400 * 1000));
      weekMiles[weeksOut] = (weekMiles[weeksOut] || 0) + (a.mi || 0);
    });
    const weekValues  = Object.values(weekMiles).map(v => Math.round(v * 10) / 10);
    const peakWeekMi  = weekValues.length ? Math.max(...weekValues) : 0;
    const avgWeeklyMi = weekValues.length
      ? Math.round(weekValues.reduce((a, b) => a + b, 0) / 8 * 10) / 10
      : 0;

    // Quality runs in block: pace < 8:00/mi
    const qualityCount = block.filter(a => a.pa && a.pa < 8.0).length;

    // Days since last hard run
    const hardRuns = block.filter(a => a.pa && a.pa < 7.5).sort((a, b) => b.d.localeCompare(a.d));
    const lastHardDaysOut = hardRuns.length
      ? Math.round((raceDateTs - new Date(hardRuns[0].d).getTime()) / 86400000)
      : null;

    return {
      date:    race.d,
      name:    race.nm || label,
      label,
      distMi:  race.mi,
      timeSec,
      timeStr: fmtTimeSec(timeSec),
      pace,
      paceStr: fmtPaceMPM(pace),
      hr:      race.hr,
      preRace: {
        peakWeekMi:    Math.round(peakWeekMi * 10) / 10,
        avgWeeklyMi,
        qualityCount,
        lastHardDaysOut,
      },
    };
  }).reverse(); // most recent first
}

/* ── Aerobic efficiency ─────────────────────────────────────────────────── */

function computeAerobicEfficiency(runs) {
  // Easy runs: HR 125-155, pace 8:00-11:30/mi, distance ≥ 4mi
  const easy = runs.filter(a =>
    a.hr  && a.hr  >= 125 && a.hr  <= 155 &&
    a.pa  && a.pa  >= 8.0 && a.pa  <= 11.5 &&
    a.mi  >= 4
  );

  // Group by year-quarter
  const byQ = {};
  easy.forEach(a => {
    const dt   = new Date(a.d);
    const key  = `${dt.getFullYear()}-Q${Math.floor(dt.getMonth() / 3) + 1}`;
    if (!byQ[key]) byQ[key] = { paces: [], hrs: [] };
    byQ[key].paces.push(a.pa);
    byQ[key].hrs.push(a.hr);
  });

  return Object.entries(byQ)
    .sort(([a], [b]) => a.localeCompare(b))
    .filter(([, v]) => v.paces.length >= 2)
    .map(([period, v]) => ({
      period,
      avgPace: +(v.paces.reduce((a, b) => a + b, 0) / v.paces.length).toFixed(2),
      avgHR:   Math.round(v.hrs.reduce((a, b) => a + b, 0) / v.hrs.length),
      n:       v.paces.length,
    }));
}

/* ── Mileage stats ──────────────────────────────────────────────────────── */

function computeMileageStats(runs) {
  if (!runs.length) return {};

  // Group by ISO week (Mon–Sun)
  const byWeek = {};
  runs.forEach(a => {
    const d   = new Date(a.d);
    // Monday of the ISO week
    const day = d.getDay() || 7; // convert Sunday=0 → 7
    const mon = new Date(d);
    mon.setDate(d.getDate() - (day - 1));
    const key = mon.toISOString().slice(0, 10);
    byWeek[key] = (byWeek[key] || 0) + (a.mi || 0);
  });

  const weeks = Object.entries(byWeek)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, miles]) => ({ date, miles: Math.round(miles * 10) / 10 }));

  // Peak week
  const peak     = weeks.reduce((best, w) => w.miles > best.miles ? w : best, { miles: 0, date: '' });

  // Best 8-week rolling avg
  let best8wk = 0, best8wkDate = '';
  for (let i = 7; i < weeks.length; i++) {
    const slice = weeks.slice(i - 7, i + 1);
    const avg   = slice.reduce((s, w) => s + w.miles, 0) / 8;
    if (avg > best8wk) { best8wk = avg; best8wkDate = slice[0].date; }
  }

  // Recent 4-week avg
  const recent4w  = weeks.slice(-4);
  const recent4wk = recent4w.length
    ? Math.round(recent4w.reduce((s, w) => s + w.miles, 0) / recent4w.length * 10) / 10
    : 0;

  // Career total
  const totalMiles = Math.round(runs.reduce((s, a) => s + (a.mi || 0), 0));

  // Annual mileage (last 5 years with data)
  const byYear = {};
  runs.forEach(a => {
    const yr = a.d.slice(0, 4);
    byYear[yr] = (byYear[yr] || 0) + (a.mi || 0);
  });
  const annualMiles = Object.entries(byYear)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, miles]) => ({ year, miles: Math.round(miles) }))
    .slice(-6);

  return {
    peakWeekMi:    Math.round(peak.miles * 10) / 10,
    peakWeekDate:  peak.date,
    best8wkAvg:    Math.round(best8wk * 10) / 10,
    best8wkDate,
    recent4wkAvg:  recent4wk,
    totalMiles,
    annualMiles,
    weekCount:     weeks.length,
    weeks,          // full weekly history for chart
  };
}

/* ── Interval pace trends ───────────────────────────────────────────────── */

/**
 * Identify likely interval/tempo/race-pace sessions from activity metadata.
 * Without lap data, we use avg pace < 7:30/mi as proxy for quality effort.
 */
function computeIntervalTrends(runs) {
  // Hard sessions: avg pace < 7:30/mi, ≥ 3mi
  const hard = runs.filter(a => a.pa && a.pa < 7.5 && a.mi >= 3);

  // Group by month
  const byMonth = {};
  hard.forEach(a => {
    const key = a.d.slice(0, 7); // YYYY-MM
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(a.pa);
  });

  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, paces]) => ({
      month,
      avgPace:  +(paces.reduce((a, b) => a + b, 0) / paces.length).toFixed(2),
      fastestPace: +(Math.min(...paces)).toFixed(2),
      count:    paces.length,
    }));
}

/* ── Pattern insights ───────────────────────────────────────────────────── */

function derivePatterns(races, runs) {
  if (races.length < 2) return null;

  const marathons = races.filter(r => r.distMi >= 25);

  if (marathons.length < 2) return { note: 'Need 2+ marathons for pattern analysis' };

  const sorted   = [...marathons].sort((a, b) => (a.pace || 99) - (b.pace || 99));
  const best     = sorted[0];
  const worst    = sorted[sorted.length - 1];

  const bestBlock  = best.preRace;
  const worstBlock = worst.preRace;

  const insights = [];

  // Mileage correlation
  if (bestBlock.avgWeeklyMi > worstBlock.avgWeeklyMi + 5) {
    insights.push(`Higher mileage blocks produce better results: best marathon (${best.timeStr}) had ${bestBlock.avgWeeklyMi}mi/wk avg vs ${worstBlock.avgWeeklyMi}mi/wk for ${worst.timeStr}.`);
  }

  // Quality session correlation
  if (bestBlock.qualityCount > worstBlock.qualityCount) {
    insights.push(`Best marathon preceded by ${bestBlock.qualityCount} quality sessions in 8 weeks vs ${worstBlock.qualityCount} for worst.`);
  }

  // Taper timing
  if (bestBlock.lastHardDaysOut && worstBlock.lastHardDaysOut) {
    insights.push(`Optimal taper timing: last hard session ${bestBlock.lastHardDaysOut} days before your best marathon (${best.timeStr}).`);
  }

  return {
    bestRace:  best,
    worstRace: worst,
    insights,
  };
}

/* ── Coaching text for Claude ───────────────────────────────────────────── */

function buildCoachingText({ races, efficiency, mileage, intervals, patterns, totalActivities, oldestDate }) {
  const lines = [];

  lines.push(`## LONGITUDINAL TRAINING INTELLIGENCE`);
  lines.push(`${totalActivities} activities · ${races.length} races · data since ${oldestDate}`);
  lines.push('');

  // Race history (most recent 8)
  if (races.length > 0) {
    lines.push('### RACE HISTORY (most recent first):');
    races.slice(0, 8).forEach(r => {
      const b = r.preRace;
      lines.push(
        `${r.date} | ${r.name} | ${r.timeStr} | ${r.paceStr}/mi | HR ${r.hr || '?'} | ` +
        `8wk avg ${b.avgWeeklyMi}mi | peak ${b.peakWeekMi}mi | ${b.qualityCount} quality sessions` +
        (b.lastHardDaysOut ? ` | last hard run ${b.lastHardDaysOut}d out` : '')
      );
    });
    lines.push('');
  }

  // Aerobic efficiency trend
  if (efficiency.length >= 2) {
    lines.push('### AEROBIC EFFICIENCY TREND (easy runs, HR 125–155):');
    efficiency.forEach(e => {
      lines.push(`${e.period}: ${fmtPaceMPM(e.avgPace)}/mi at avg HR ${e.avgHR} (n=${e.n})`);
    });
    const first = efficiency[0];
    const last  = efficiency[efficiency.length - 1];
    const improvePct = ((first.avgPace - last.avgPace) / first.avgPace * 100).toFixed(1);
    if (parseFloat(improvePct) > 2) {
      lines.push(`→ ${improvePct}% faster at the same HR since ${first.period} — confirmed aerobic development`);
    } else if (parseFloat(improvePct) < -2) {
      lines.push(`→ Aerobic efficiency declining ${Math.abs(improvePct)}% since ${first.period} — investigate`);
    }
    lines.push('');
  }

  // Mileage milestones
  if (mileage.peakWeekMi) {
    lines.push('### MILEAGE MILESTONES:');
    lines.push(`Peak week ever: ${mileage.peakWeekMi}mi (week of ${mileage.peakWeekDate})`);
    if (mileage.best8wkAvg) {
      lines.push(`Best 8-week block: ${mileage.best8wkAvg}mi/wk avg (starting ${mileage.best8wkDate})`);
    }
    lines.push(`Current 4-week avg: ${mileage.recent4wkAvg}mi/wk`);
    lines.push(`Career miles logged: ~${mileage.totalMiles.toLocaleString()}mi`);
    if (mileage.annualMiles && mileage.annualMiles.length > 1) {
      const annualStr = mileage.annualMiles.map(y => `${y.year}: ${y.miles}mi`).join(' | ');
      lines.push(`Annual mileage: ${annualStr}`);
    }
    lines.push('');
  }

  // Pattern insights
  if (patterns && patterns.insights && patterns.insights.length > 0) {
    lines.push('### WHAT WORKS FOR THIS ATHLETE:');
    patterns.insights.forEach(p => lines.push(`• ${p}`));
    lines.push('');
  }

  // Best race context
  if (patterns && patterns.bestRace) {
    const b = patterns.bestRace;
    const blk = b.preRace;
    lines.push(`### BEST RACE CONTEXT (${b.timeStr} ${b.label} on ${b.date}):`);
    lines.push(`${blk.avgWeeklyMi}mi/wk for 8 weeks | peak ${blk.peakWeekMi}mi | ${blk.qualityCount} quality sessions`);
    if (blk.lastHardDaysOut) {
      lines.push(`Last hard effort: ${blk.lastHardDaysOut} days before race`);
    }
  }

  return lines.join('\n');
}

/* ── KV helpers ─────────────────────────────────────────────────────────── */

async function resolveAthleteId(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const a = await r.json();
    return a.id ? String(a.id) : null;
  } catch (_) { return null; }
}

async function kvGetJSON(url, token, key) {
  try {
    const r    = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch (_) { return null; }
}

async function kvSetJSON(url, token, key, value) {
  await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify([['SET', key, JSON.stringify(value)]]),
  }).catch(() => {});
}
