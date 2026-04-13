/**
 * GET /api/dashboard?accessToken=xxx
 *
 * Returns all data needed by the Brain modal tabs:
 *   weeklyStats, weeklyBalance, trainingLoad, injuryRisk,
 *   fitnessTrend, activities (last 30 days, simplified)
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required.' });

  // Fetch 42 days of activities (needed for full CTL window)
  const since42 = Math.floor((Date.now() - 42 * 24 * 60 * 60 * 1000) / 1000);
  let activities = [];

  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?after=${since42}&per_page=100`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired.' });
    if (!r.ok)           return res.status(502).json({ error: 'Could not fetch activities.' });
    activities = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'Network error fetching activities.' });
  }

  // Newest first
  activities.sort((a, b) =>
    new Date(b.start_date_local || b.start_date) - new Date(a.start_date_local || a.start_date)
  );

  classifyActivities(activities);

  const weeklyStats   = getWeeklyStats(activities);
  const weeklyBalance = getWeeklyBalance(activities);
  const trainingLoad  = calculateTrainingLoad(activities);
  const injuryRisk    = assessInjuryRisk(trainingLoad);
  const fitnessTrend  = computeFitnessTrend(activities);

  // Simplified list for Workout Log (last 30 days, max 40 entries)
  const cutoff30 = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const activityList = activities
    .filter(a => new Date(a.start_date_local || a.start_date).getTime() > cutoff30)
    .slice(0, 40)
    .map(formatActivity);

  return res.status(200).json({
    weeklyStats,
    weeklyBalance,
    trainingLoad,
    injuryRisk,
    fitnessTrend,
    activities: activityList,
  });
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function isRun(a) { return /run/i.test(a.type || ''); }

function classifyRun(a) {
  if (!isRun(a)) return null;
  const durationMin = (a.moving_time || 0) / 60;
  const distMi      = (a.distance    || 0) / 1609.34;
  const avgSpeed    = a.average_speed;
  const avgPaceMPM  = avgSpeed ? 1609.34 / avgSpeed / 60 : null;
  const avgHR       = a.average_heartrate;
  const maxSpeed    = a.max_speed;
  const wt          = a.workout_type;

  if (wt === 1) return 'Race';
  if (wt === 2) return 'Long Run';
  if (wt === 3) return 'Workout';
  if (maxSpeed && avgSpeed > 0 && maxSpeed / avgSpeed > 1.9) return 'Workout';
  if (durationMin >= 90) return 'Long Run';
  if (durationMin <= 35 && distMi <= 4) return 'Recovery Run';

  if (avgHR) {
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

function classifyActivities(activities) {
  activities.forEach(a => { a._classification = classifyRun(a); });
}

function getWeeklyStats(activities) {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const week   = activities.filter(a =>
    isRun(a) && new Date(a.start_date_local || a.start_date).getTime() > cutoff
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
    runCount:     week.filter(isRun).length,
  };
}

function getWeeklyBalance(activities) {
  const cutoff   = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const weekRuns = activities.filter(a =>
    isRun(a) && new Date(a.start_date_local || a.start_date).getTime() > cutoff
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

function calculateTSS(a) {
  const durationH = (a.moving_time || 0) / 3600;
  if (durationH < 5 / 60) return 0;
  const avgHR = a.average_heartrate;
  const maxHR = a.max_heartrate;
  const cls   = a._classification;
  const type  = (a.type || '').toLowerCase();
  let IF = 0.65;
  if (avgHR) {
    const threshHR = maxHR ? maxHR * 0.9 : avgHR * 1.1;
    IF = avgHR / threshHR;
  } else if (a.average_speed && /run/i.test(type)) {
    const mpm = 1609.34 / a.average_speed / 60;
    IF = 7.5 / mpm;
  } else {
    const map = { 'Recovery Run': 0.55, 'Easy Run': 0.65, 'Long Run': 0.65,
                  'Tempo Run': 0.85, 'Workout': 0.95, 'Race': 1.0 };
    if (map[cls])                           IF = map[cls];
    else if (/ride|cycling/i.test(type))    IF = 0.70;
    else if (/swim/i.test(type))            IF = 0.75;
    else if (/weight|strength/i.test(type)) IF = 0.55;
  }
  IF = Math.min(Math.max(IF, 0.4), 1.15);
  return durationH * IF * IF * 100;
}

function calculateTrainingLoad(activities) {
  const dailyTSS = {};
  activities.forEach(a => {
    const d = new Date(a.start_date_local || a.start_date).toISOString().split('T')[0];
    dailyTSS[d] = (dailyTSS[d] || 0) + calculateTSS(a);
  });
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  const history = [];
  let ctl = 0, atl = 0;
  for (let i = 41; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().split('T')[0];
    const tss = dailyTSS[key] || 0;
    ctl = ctl + (tss - ctl) / 42;
    atl = atl + (tss - atl) / 7;
    history.push({ date: key, tss: Math.round(tss),
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      tsb: Math.round((ctl - atl) * 10) / 10 });
  }
  const cur = history[history.length - 1];
  return { ctl: cur.ctl, atl: cur.atl, tsb: cur.tsb, history };
}

function assessInjuryRisk({ ctl, atl, tsb }) {
  const acwr = ctl > 0 ? atl / ctl : 1;
  if (acwr > 1.5 || tsb < -25) {
    return {
      level:  'HIGH',
      reason: acwr > 1.5
        ? `Fatigue ${Math.round((acwr - 1) * 100)}% above fitness baseline (ACWR ${acwr.toFixed(2)})`
        : `TSB ${Math.round(tsb)} — deep fatigue, back off`,
    };
  }
  if (acwr > 1.3 || tsb < -15) {
    return {
      level:  'MODERATE',
      reason: acwr > 1.3
        ? `Fatigue ${Math.round((acwr - 1) * 100)}% above fitness baseline — monitor recovery`
        : `TSB ${Math.round(tsb)} — accumulating fatigue`,
    };
  }
  return { level: 'LOW', reason: 'Training load is manageable' };
}

function computeFitnessTrend(activities) {
  const DAY = 24 * 60 * 60 * 1000;
  const now  = Date.now();
  const runs = activities.filter(a => isRun(a) && a.average_speed);

  const recent = runs.filter(a => {
    const t = new Date(a.start_date_local || a.start_date).getTime();
    return t > now - 7 * DAY;
  });
  const prior = runs.filter(a => {
    const t = new Date(a.start_date_local || a.start_date).getTime();
    return t > now - 28 * DAY && t < now - 21 * DAY;
  });

  if (!recent.length || !prior.length) return null;

  const avgPace = arr => arr.reduce((s, a) => s + 1609.34 / a.average_speed / 60, 0) / arr.length;
  const rp = avgPace(recent);
  const pp = avgPace(prior);
  const delta = rp - pp; // negative = faster = improving

  return {
    direction:  Math.abs(delta) < 0.2 ? 'stable' : delta < 0 ? 'improving' : 'declining',
    recentPace: Math.round(rp * 100) / 100,
    priorPace:  Math.round(pp * 100) / 100,
    delta:      Math.round(delta * 100) / 100,
  };
}

function formatActivity(a) {
  const date = new Date(a.start_date_local || a.start_date);
  const dateStr = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const distMi  = a.distance    ? Math.round(a.distance    / 1609.34 * 100) / 100 : null;
  const durMin  = a.moving_time ? Math.round(a.moving_time / 60) : null;
  let pace = null;
  if (a.average_speed && isRun(a)) {
    const mpm = 1609.34 / a.average_speed / 60;
    const m   = Math.floor(mpm);
    const s   = Math.round((mpm - m) * 60);
    pace = `${m}:${String(s).padStart(2, '0')}`;
  }
  return {
    date:           dateStr,
    name:           a.name || a.type,
    type:           a.type,
    distMi,
    durationMin:    durMin,
    pace,
    avgHR:          a.average_heartrate ? Math.round(a.average_heartrate) : null,
    classification: a._classification || null,
  };
}
