/**
 * POST /api/history-sync
 * Body: { accessToken, reset?: boolean }
 *
 * Fetches one page (200 activities) of the athlete's full Strava history
 * using before= timestamp pagination. The frontend calls this repeatedly
 * until complete: true.
 *
 * Storage:
 *   history:{athleteId}:meta   — sync state
 *   history:{athleteId}:page:N — 200 compressed activities per page
 *
 * Cache: complete syncs are valid for 30 days (activities don't change).
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken, reset = false, action } = req.body || {};

  /* ── Dispatch: history-analysis merged here from former /api/history-analysis ── */
  if (action === 'analysis') return runHistoryAnalysis(req, res, accessToken, kvUrl, kvToken);
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ error: 'KV not configured', complete: false });

  // ── Resolve athlete ID ──
  const athleteId = await resolveAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  const metaKey = `history:${athleteId}:meta`;

  // ── Read current meta ──
  let meta = await kvGetJSON(kvUrl, kvToken, metaKey);

  // Return immediately only if synced in the last 24 hours — otherwise do incremental
  if (!reset && meta && meta.complete) {
    const ageMs = Date.now() - (meta.finishedAt || 0);
    if (ageMs < 24 * 60 * 60 * 1000) {
      return res.status(200).json({
        complete:    true,
        fromCache:   true,
        count:       meta.count,
        pages:       meta.pages,
        oldestDate:  meta.oldestDate,
        newestDate:  meta.newestDate,
        finishedAt:  meta.finishedAt,
      });
    }

    // Cache stale — do incremental sync: fetch only new activities since newestTs
    const newestTs = meta.newestTs || 0;
    const afterParams = new URLSearchParams({ per_page: '200', after: String(newestTs) });
    let newActs = [];
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?${afterParams}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
      if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit' });
      if (r.ok) newActs = await r.json();
    } catch (_) {}

    if (Array.isArray(newActs) && newActs.length > 0) {
      // Append new activities as a new page
      const compressed = newActs.map(compressActivity);
      const pageKey    = `history:${athleteId}:page:${meta.pages}`;
      await kvSetJSON(kvUrl, kvToken, pageKey, compressed);

      const timestamps = newActs.map(a =>
        Math.floor(new Date(a.start_date_local || a.start_date).getTime() / 1000)
      ).filter(Boolean);
      meta.count      += compressed.length;
      meta.pages      += 1;
      meta.newestTs    = Math.max(...timestamps);
      meta.newestDate  = new Date(meta.newestTs * 1000).toISOString().slice(0, 10);

      // Invalidate analysis cache so it gets rebuilt with new activities
      await kvPipeline(kvUrl, kvToken, [['DEL', `history:${athleteId}:analysis`]]);
    }

    meta.complete   = true;
    meta.finishedAt = Date.now();
    await kvSetJSON(kvUrl, kvToken, metaKey, meta);
    return res.status(200).json({
      complete:    true,
      incremental: true,
      added:       Array.isArray(newActs) ? newActs.length : 0,
      count:       meta.count,
      pages:       meta.pages,
      oldestDate:  meta.oldestDate,
      newestDate:  meta.newestDate,
      finishedAt:  meta.finishedAt,
    });
  }

  // Reset: wipe existing pages
  if (reset && meta && meta.pages > 0) {
    const deletes = [];
    for (let i = 0; i < meta.pages; i++) {
      deletes.push(['DEL', `history:${athleteId}:page:${i}`]);
    }
    await kvPipeline(kvUrl, kvToken, deletes);
    meta = null;
  }

  // Initialize meta for fresh sync
  if (!meta || reset) {
    meta = { v: 1, startedAt: Date.now(), finishedAt: null,
             count: 0, pages: 0, oldestTs: null, oldestDate: null,
             newestDate: null, complete: false };
  }

  // ── Fetch next page from Strava ──
  const params = new URLSearchParams({ per_page: '200' });
  if (meta.oldestTs) params.set('before', String(meta.oldestTs - 1));

  let stravaActs = [];
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit' });
    if (!r.ok)            return res.status(502).json({ error: `Strava error ${r.status}` });
    stravaActs = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'Network error fetching Strava' });
  }

  if (!Array.isArray(stravaActs) || stravaActs.length === 0) {
    // No more activities — sync complete
    meta.complete   = true;
    meta.finishedAt = Date.now();
    await kvSetJSON(kvUrl, kvToken, metaKey, meta);
    return res.status(200).json({
      complete:   true,
      count:      meta.count,
      pages:      meta.pages,
      oldestDate: meta.oldestDate,
      newestDate: meta.newestDate,
    });
  }

  // Compress and store this page
  const compressed = stravaActs.map(compressActivity);
  const pageKey    = `history:${athleteId}:page:${meta.pages}`;
  await kvSetJSON(kvUrl, kvToken, pageKey, compressed);

  // Update meta
  const timestamps = stravaActs.map(a =>
    Math.floor(new Date(a.start_date_local || a.start_date).getTime() / 1000)
  ).filter(Boolean);
  const oldestInPage = Math.min(...timestamps);
  const newestInPage = Math.max(...timestamps);

  meta.count    += compressed.length;
  meta.pages    += 1;
  meta.oldestTs  = oldestInPage;
  meta.oldestDate = new Date(oldestInPage * 1000).toISOString().slice(0, 10);
  if (!meta.newestDate) {
    meta.newestTs   = newestInPage;
    meta.newestDate = new Date(newestInPage * 1000).toISOString().slice(0, 10);
  }

  // Complete if this page had fewer than 200 (last page)
  const isLastPage = stravaActs.length < 200;
  if (isLastPage) {
    meta.complete   = true;
    meta.finishedAt = Date.now();
  }

  await kvSetJSON(kvUrl, kvToken, metaKey, meta);

  return res.status(200).json({
    complete:    meta.complete,
    count:       meta.count,
    pages:       meta.pages,
    pageFetched: meta.pages - 1,
    fetched:     compressed.length,
    oldestDate:  meta.oldestDate,
    newestDate:  meta.newestDate,
  });
};

/* ── Activity compression ───────────────────────────────────────────────── */

/**
 * Trim a Strava activity to minimal fields for long-term storage.
 * Target: ~120 bytes per activity.
 */
function compressActivity(a) {
  const isRun  = /run/i.test(a.type || '');
  const distMi = +((a.distance || 0) / 1609.34).toFixed(2);
  const pace   = (isRun && a.average_speed > 0.5)
    ? +(1609.34 / a.average_speed / 60).toFixed(2)
    : null;

  return {
    id:  a.id,
    d:   (a.start_date_local || a.start_date || '').slice(0, 10),
    ty:  (a.type || 'Other').slice(0, 10),
    nm:  (a.name || '').slice(0, 60),
    mi:  distMi,
    sec: a.moving_time || 0,
    pa:  pace,
    hr:  a.average_heartrate ? Math.round(a.average_heartrate) : null,
    mhr: a.max_heartrate     ? Math.round(a.max_heartrate)     : null,
    el:  a.total_elevation_gain ? Math.round(a.total_elevation_gain * 3.28084) : 0,
    wt:  a.workout_type || 0,
    ss:  a.suffer_score  ? Math.round(a.suffer_score) : null,
  };
}

/* ── Strava athlete ID ──────────────────────────────────────────────────── */

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

/* ── KV helpers ─────────────────────────────────────────────────────────── */

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

async function kvPipeline(url, token, commands) {
  await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(commands),
  }).catch(() => {});
}

/* ══════════════════════════════════════════════════════════════════════════
   History analysis — merged from former /api/history-analysis endpoint.
   Invoked via POST /api/history-sync with body { action: 'analysis', accessToken }.
   ══════════════════════════════════════════════════════════════════════════ */

async function runHistoryAnalysis(req, res, accessToken, kvUrl, kvToken) {
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });
  if (!kvUrl || !kvToken) return res.status(200).json({ error: 'KV not configured' });

  const athleteId = await resolveAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  const metaKey     = `history:${athleteId}:meta`;
  const analysisKey = `history:${athleteId}:analysis`;

  // Serve from KV cache if fresh (< 7 days) AND race-index exists
  const cachedAnalysis = await kvGetJSON(kvUrl, kvToken, analysisKey);
  if (cachedAnalysis && cachedAnalysis.builtAt) {
    const ageMs = Date.now() - cachedAnalysis.builtAt;
    if (ageMs < 7 * 24 * 60 * 60 * 1000) {
      const raceIndex = await kvGetJSON(kvUrl, kvToken, `history:${athleteId}:race-index`);
      if (raceIndex) return res.status(200).json(cachedAnalysis);
    }
  }

  const meta = await kvGetJSON(kvUrl, kvToken, metaKey);
  if (!meta || !meta.complete) {
    return res.status(200).json({ error: 'History sync not complete yet', notReady: true });
  }

  const historyAgeMs   = Date.now() - (meta.finishedAt || 0);
  const historyIsStale = historyAgeMs > 30 * 24 * 60 * 60 * 1000;

  const pageKeys = [];
  for (let i = 0; i < meta.pages; i++) pageKeys.push(`history:${athleteId}:page:${i}`);
  const pageResults  = await Promise.all(pageKeys.map(k => kvGetJSON(kvUrl, kvToken, k)));
  const activities   = pageResults.filter(Boolean).flat().filter(a => a && a.d && a.id);
  if (activities.length === 0) return res.status(200).json({ error: 'No activity data found' });

  activities.sort((a, b) => a.d.localeCompare(b.d));

  const runs      = activities.filter(a => /run/i.test(a.ty || ''));
  const races     = buildRaceHistory(runs, activities);
  const efficiency = computeAerobicEfficiency(runs);
  const mileage   = computeMileageStats(runs);
  const intervals = computeIntervalTrends(runs);
  const patterns  = derivePatterns(races, runs);

  const analysis = {
    v:       1,
    builtAt: Date.now(),
    staleHistory: historyIsStale || undefined,
    meta: {
      totalActivities: activities.length,
      totalRuns:       runs.length,
      oldestDate:      meta.oldestDate,
      newestDate:      meta.newestDate,
    },
    races, efficiency, mileage, intervals, patterns,
    text: buildCoachingText({ races, efficiency, mileage, intervals, patterns,
                              totalActivities: activities.length,
                              oldestDate: meta.oldestDate }),
  };

  const now          = Date.now();
  const qualityIndex = buildQualityIndex(runs);
  const raceIndex    = races.filter(r => r.id).map(r => ({
    id: r.id, date: r.date, name: r.name, label: r.label,
    distMi: r.distMi, timeStr: r.timeStr, paceStr: r.paceStr,
  }));
  const raceBlocks = buildRaceBlocks(races, runs).slice(0, 15);

  const pipeline = [
    ['SET', analysisKey,                              JSON.stringify(analysis)],
    ['SET', `history:${athleteId}:quality-index`,     JSON.stringify({ v: 1, builtAt: now, sessions: qualityIndex })],
    ['SET', `history:${athleteId}:race-index`,        JSON.stringify({ v: 1, builtAt: now, races: raceIndex })],
    ...raceBlocks.map(b => ['SET', `history:${athleteId}:race-block:${b.raceId}`, JSON.stringify(b)]),
  ];
  await kvPipeline(kvUrl, kvToken, pipeline);

  return res.status(200).json(analysis);
}

/* ── Race history ────────────────────────────────────────────────────────── */

function isRaceActivity(a) {
  if (a.wt === 1) return true;
  const nm = (a.nm || '').toLowerCase();
  return /\bmarathon\b|\b5 ?k\b|\b10 ?k\b|\bhalf\b|\brace\b|\bchampionship\b|\bprix\b/.test(nm)
      && a.mi >= 3;
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
  const nm = (a.nm || '').toLowerCase();
  const mi = a.mi || 0;
  if (mi >= 25 || /marathon/.test(nm)) return 'Marathon';
  if (mi >= 12 || /half/.test(nm))     return 'Half Marathon';
  if (mi >= 5.9 || /10k/.test(nm))     return '10K';
  if (mi >= 2.9 || /5k/.test(nm))      return '5K';
  return `${mi.toFixed(1)}mi race`;
}

function buildRaceHistory(runs, allActivities) {
  return runs.filter(isRaceActivity).map(race => {
    const timeSec    = race.sec || 0;
    const label      = guessRaceLabel(race);
    const raceDateTs = new Date(race.d).getTime();
    const blockStart = raceDateTs - 56 * 86400 * 1000;
    const block      = runs.filter(a => {
      const ts = new Date(a.d).getTime();
      return ts >= blockStart && ts < raceDateTs;
    });
    const weekMiles = {};
    block.forEach(a => {
      const weeksOut = Math.floor((raceDateTs - new Date(a.d).getTime()) / (7 * 86400 * 1000));
      weekMiles[weeksOut] = (weekMiles[weeksOut] || 0) + (a.mi || 0);
    });
    const weekValues    = Object.values(weekMiles).map(v => Math.round(v * 10) / 10);
    const peakWeekMi    = weekValues.length ? Math.max(...weekValues) : 0;
    const avgWeeklyMi   = weekValues.length
      ? Math.round(weekValues.reduce((a, b) => a + b, 0) / 8 * 10) / 10 : 0;
    const qualityCount  = block.filter(a => a.pa && a.pa < 8.0).length;
    const hardRuns      = block.filter(a => a.pa && a.pa < 7.5).sort((a, b) => b.d.localeCompare(a.d));
    const lastHardDaysOut = hardRuns.length
      ? Math.round((raceDateTs - new Date(hardRuns[0].d).getTime()) / 86400000) : null;
    return {
      id: race.id, date: race.d, name: race.nm || label, label,
      distMi: race.mi, timeSec, timeStr: fmtTimeSec(timeSec),
      pace: race.pa, paceStr: fmtPaceMPM(race.pa), hr: race.hr,
      preRace: { peakWeekMi: Math.round(peakWeekMi * 10) / 10, avgWeeklyMi, qualityCount, lastHardDaysOut },
    };
  }).reverse();
}

function computeAerobicEfficiency(runs) {
  const easy = runs.filter(a =>
    a.hr && a.hr >= 125 && a.hr <= 155 &&
    a.pa && a.pa >= 8.0 && a.pa <= 11.5 && a.mi >= 4
  );
  const byQ = {};
  easy.forEach(a => {
    const dt  = new Date(a.d);
    const key = `${dt.getFullYear()}-Q${Math.floor(dt.getMonth() / 3) + 1}`;
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

function computeMileageStats(runs) {
  if (!runs.length) return {};
  const byWeek = {};
  runs.forEach(a => {
    const d   = new Date(a.d);
    const day = d.getDay() || 7;
    const mon = new Date(d);
    mon.setDate(d.getDate() - (day - 1));
    const key = mon.toISOString().slice(0, 10);
    byWeek[key] = (byWeek[key] || 0) + (a.mi || 0);
  });
  const weeks  = Object.entries(byWeek)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, miles]) => ({ date, miles: Math.round(miles * 10) / 10 }));
  const peak   = weeks.reduce((best, w) => w.miles > best.miles ? w : best, { miles: 0, date: '' });
  let best8wk  = 0, best8wkDate = '';
  for (let i = 7; i < weeks.length; i++) {
    const slice = weeks.slice(i - 7, i + 1);
    const avg   = slice.reduce((s, w) => s + w.miles, 0) / 8;
    if (avg > best8wk) { best8wk = avg; best8wkDate = slice[0].date; }
  }
  const recent4w  = weeks.slice(-4);
  const recent4wk = recent4w.length
    ? Math.round(recent4w.reduce((s, w) => s + w.miles, 0) / recent4w.length * 10) / 10 : 0;
  const totalMiles = Math.round(runs.reduce((s, a) => s + (a.mi || 0), 0));
  const byYear = {};
  runs.forEach(a => { const yr = a.d.slice(0, 4); byYear[yr] = (byYear[yr] || 0) + (a.mi || 0); });
  const annualMiles = Object.entries(byYear)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([year, miles]) => ({ year, miles: Math.round(miles) }))
    .slice(-6);
  return {
    peakWeekMi: Math.round(peak.miles * 10) / 10, peakWeekDate: peak.date,
    best8wkAvg: Math.round(best8wk * 10) / 10, best8wkDate,
    recent4wkAvg: recent4wk, totalMiles, annualMiles, weekCount: weeks.length, weeks,
  };
}

function computeIntervalTrends(runs) {
  const hard = runs.filter(a => a.pa && a.pa < 7.5 && a.mi >= 3);
  const byMonth = {};
  hard.forEach(a => {
    const key = a.d.slice(0, 7);
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(a.pa);
  });
  return Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, paces]) => ({
      month,
      avgPace:     +(paces.reduce((a, b) => a + b, 0) / paces.length).toFixed(2),
      fastestPace: +(Math.min(...paces)).toFixed(2),
      count:       paces.length,
    }));
}

function derivePatterns(races, runs) {
  if (races.length < 2) return null;
  const marathons = races.filter(r => r.distMi >= 25);
  if (marathons.length < 2) return { note: 'Need 2+ marathons for pattern analysis' };
  const sorted  = [...marathons].sort((a, b) => (a.pace || 99) - (b.pace || 99));
  const best    = sorted[0];
  const worst   = sorted[sorted.length - 1];
  const insights = [];
  if (best.preRace.avgWeeklyMi > worst.preRace.avgWeeklyMi + 5)
    insights.push(`Higher mileage blocks produce better results: best marathon (${best.timeStr}) had ${best.preRace.avgWeeklyMi}mi/wk avg vs ${worst.preRace.avgWeeklyMi}mi/wk for ${worst.timeStr}.`);
  if (best.preRace.qualityCount > worst.preRace.qualityCount)
    insights.push(`Best marathon preceded by ${best.preRace.qualityCount} quality sessions in 8 weeks vs ${worst.preRace.qualityCount} for worst.`);
  if (best.preRace.lastHardDaysOut && worst.preRace.lastHardDaysOut)
    insights.push(`Optimal taper timing: last hard session ${best.preRace.lastHardDaysOut} days before your best marathon (${best.timeStr}).`);
  return { bestRace: best, worstRace: worst, insights };
}

function buildCoachingText({ races, efficiency, mileage, intervals, patterns, totalActivities, oldestDate }) {
  const lines = [];
  lines.push(`## LONGITUDINAL TRAINING INTELLIGENCE`);
  lines.push(`${totalActivities} activities · ${races.length} races · data since ${oldestDate}`);
  lines.push('');
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
  if (efficiency.length >= 2) {
    lines.push('### AEROBIC EFFICIENCY TREND (easy runs, HR 125–155):');
    efficiency.forEach(e => lines.push(`${e.period}: ${fmtPaceMPM(e.avgPace)}/mi at avg HR ${e.avgHR} (n=${e.n})`));
    const first = efficiency[0], last = efficiency[efficiency.length - 1];
    const improvePct = ((first.avgPace - last.avgPace) / first.avgPace * 100).toFixed(1);
    if (parseFloat(improvePct) > 2)
      lines.push(`→ ${improvePct}% faster at the same HR since ${first.period} — confirmed aerobic development`);
    else if (parseFloat(improvePct) < -2)
      lines.push(`→ Aerobic efficiency declining ${Math.abs(improvePct)}% since ${first.period} — investigate`);
    lines.push('');
  }
  if (mileage.peakWeekMi) {
    lines.push('### MILEAGE MILESTONES:');
    lines.push(`Peak week ever: ${mileage.peakWeekMi}mi (week of ${mileage.peakWeekDate})`);
    if (mileage.best8wkAvg) lines.push(`Best 8-week block: ${mileage.best8wkAvg}mi/wk avg (starting ${mileage.best8wkDate})`);
    lines.push(`Current 4-week avg: ${mileage.recent4wkAvg}mi/wk`);
    lines.push(`Career miles logged: ~${mileage.totalMiles.toLocaleString()}mi`);
    if (mileage.annualMiles && mileage.annualMiles.length > 1)
      lines.push(`Annual mileage: ${mileage.annualMiles.map(y => `${y.year}: ${y.miles}mi`).join(' | ')}`);
    lines.push('');
  }
  if (patterns && patterns.insights && patterns.insights.length > 0) {
    lines.push('### WHAT WORKS FOR THIS ATHLETE:');
    patterns.insights.forEach(p => lines.push(`• ${p}`));
    lines.push('');
  }
  if (patterns && patterns.bestRace) {
    const b = patterns.bestRace, blk = b.preRace;
    lines.push(`### BEST RACE CONTEXT (${b.timeStr} ${b.label} on ${b.date}):`);
    lines.push(`${blk.avgWeeklyMi}mi/wk for 8 weeks | peak ${blk.peakWeekMi}mi | ${blk.qualityCount} quality sessions`);
    if (blk.lastHardDaysOut) lines.push(`Last hard effort: ${blk.lastHardDaysOut} days before race`);
  }
  return lines.join('\n');
}

function buildQualityIndex(runs) {
  return runs
    .filter(a => a.pa && a.pa < 8.0 && (a.mi || 0) >= 3)
    .map(a => ({ id: a.id, d: a.d, nm: (a.nm || '').slice(0, 50), mi: a.mi, pa: a.pa, hr: a.hr, wt: a.wt }))
    .sort((a, b) => a.d.localeCompare(b.d));
}

function buildRaceBlocks(races, runs) {
  return races.filter(r => r.id && r.date).map(race => {
    const raceDateTs = new Date(race.date).getTime();
    const blockStart = raceDateTs - 12 * 7 * 86400000;
    const blockRuns  = runs.filter(a => {
      const ts = new Date(a.d).getTime();
      return ts >= blockStart && ts < raceDateTs;
    });
    const weekMap = {};
    blockRuns.forEach(a => {
      const msDiff   = raceDateTs - new Date(a.d).getTime();
      const weeksOut = Math.max(1, Math.min(12, Math.ceil(msDiff / (7 * 86400000))));
      if (!weekMap[weeksOut]) weekMap[weeksOut] = { miles: 0, runs: 0, quality: [] };
      weekMap[weeksOut].miles += a.mi || 0;
      weekMap[weeksOut].runs  += 1;
      if (a.pa && a.pa < 8.0 && (a.mi || 0) >= 3)
        weekMap[weeksOut].quality.push({ id: a.id, d: a.d, nm: (a.nm || '').slice(0, 50), mi: a.mi, pa: a.pa, hr: a.hr });
    });
    const weeks = Object.entries(weekMap)
      .map(([wk, v]) => ({ weeksOut: parseInt(wk), miles: Math.round(v.miles * 10) / 10, runs: v.runs, quality: v.quality }))
      .sort((a, b) => a.weeksOut - b.weeksOut);
    const allQuality = blockRuns
      .filter(a => a.pa && a.pa < 8.0 && (a.mi || 0) >= 3)
      .sort((a, b) => b.d.localeCompare(a.d))
      .slice(0, 20)
      .map(a => ({ id: a.id, d: a.d, nm: (a.nm || '').slice(0, 50), mi: a.mi, pa: a.pa, hr: a.hr }));
    return {
      v: 1, raceId: race.id, raceDate: race.date, raceName: race.name, raceLabel: race.label,
      distMi: race.distMi, timeStr: race.timeStr, paceStr: race.paceStr, preRace: race.preRace,
      weeks, allQuality,
    };
  });
}
