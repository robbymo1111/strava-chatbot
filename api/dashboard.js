/**
 * GET /api/dashboard?accessToken=xxx
 *
 * Returns all data needed by the Brain modal tabs:
 *   weeklyStats, weeklyBalance, trainingLoad, injuryRisk,
 *   fitnessTrend, activities (last 30 days, simplified)
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const accessToken   = req.query.accessToken;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required.' });

  // Optional personalisation params (passed from frontend via memory)
  const threshPaceMin = parseFloat(req.query.threshPaceMin) || null; // min/mile threshold pace
  const personMaxHR   = parseInt(req.query.maxHR)           || null; // athlete's max HR
  const hrZones       = getHRZones(personMaxHR);

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

  classifyActivities(activities, hrZones);

  const weeklyStats   = getWeeklyStats(activities);
  const weeklyBalance = getWeeklyBalance(activities);
  const trainingLoad  = calculateTrainingLoad(activities, threshPaceMin, personMaxHR);
  const injuryRisk    = assessInjuryRisk(trainingLoad);
  const fitnessTrend  = computeFitnessTrend(activities);

  // Parallel: fetch shoes + HR drift laps (silently ignore failures)
  const [shoes, hrDriftTrend] = await Promise.all([
    fetchShoes(accessToken),
    getHRDriftTrend(activities, accessToken),
  ]);

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
    shoes,
    hrDriftTrend,
  });
};

/* ── Helpers ──────────────────────────────────────────────────────────────── */

function isRun(a) { return /run/i.test(a.type || ''); }

/**
 * Derive HR zone boundaries from max HR using Swain et al. 1994:
 *   %VO₂max = 1.11 × %HRmax − 11  (inverted for zone boundaries)
 * Returns null if maxHR is unavailable or implausible.
 */
function getHRZones(maxHR) {
  if (!maxHR || maxHR < 100 || maxHR > 230) return null;
  return {
    recovery: maxHR * 0.63, // < 63% → Recovery
    easy:     maxHR * 0.77, // < 77% → Easy
    tempo:    maxHR * 0.85, // < 85% → Tempo
    thresh:   maxHR * 0.87, // < 87% → Threshold (top of Tempo zone)
  };
}

function classifyRun(a, hrZones) {
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
    if (hrZones) {
      if (avgHR < hrZones.recovery) return 'Recovery Run';
      if (avgHR < hrZones.easy)     return 'Easy Run';
      if (avgHR < hrZones.tempo)    return 'Tempo Run';
      return 'Workout';
    }
    // Generic fixed thresholds when no maxHR available
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

function classifyActivities(activities, hrZones) {
  activities.forEach(a => { a._classification = classifyRun(a, hrZones); });
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

/**
 * Estimate Training Stress Score (TSS).
 * @param {object} a            - Strava activity
 * @param {number|null} threshPaceMin - athlete's threshold pace in min/mile (from VDOT)
 * @param {number|null} personMaxHR  - athlete's max HR (from memory)
 */
function calculateTSS(a, threshPaceMin, personMaxHR) {
  const durationH = (a.moving_time || 0) / 3600;
  if (durationH < 5 / 60) return 0;
  const avgHR     = a.average_heartrate;
  const actMaxHR  = a.max_heartrate;
  const cls       = a._classification;
  const type      = (a.type || '').toLowerCase();
  let IF = 0.65;
  if (avgHR) {
    // Threshold HR: prefer athlete's known maxHR × 0.87, else activity maxHR × 0.90, else 1.1× avgHR
    const threshHR = personMaxHR
      ? personMaxHR * 0.87
      : (actMaxHR ? actMaxHR * 0.90 : avgHR * 1.1);
    IF = avgHR / threshHR;
  } else if (a.average_speed && /run/i.test(type)) {
    const mpm = 1609.34 / a.average_speed / 60;
    // Use athlete's VDOT threshold pace if available, else fall back to generic 7:30/mi
    const thresh = threshPaceMin || 7.5;
    IF = thresh / mpm;
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

function calculateTrainingLoad(activities, threshPaceMin, personMaxHR) {
  const dailyTSS = {};
  activities.forEach(a => {
    const d = new Date(a.start_date_local || a.start_date).toISOString().split('T')[0];
    dailyTSS[d] = (dailyTSS[d] || 0) + calculateTSS(a, threshPaceMin, personMaxHR);
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
    id:             a.id,            // needed for lap sync
    date:           dateStr,
    ts:             date.getTime(),  // unix ms — used for day-of-week logic in frontend
    name:           a.name || a.type,
    type:           a.type,
    movingTime:     a.moving_time || 0,
    distance:       a.distance    || 0,
    distMi,
    durationMin:    durMin,
    pace,
    avgHR:          a.average_heartrate ? Math.round(a.average_heartrate) : null,
    classification: a._classification || null,
  };
}

/* ── Shoes (from /athlete) ── */

async function fetchShoes(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return [];
    const athlete = await r.json();
    return (athlete.shoes || []).map(s => ({
      id:         s.id,
      name:       s.name || s.model_name || 'Unknown Shoe',
      brand:      s.brand_name || null,
      distanceMi: Math.round((s.distance || 0) / 1609.34),
    }));
  } catch (_) { return []; }
}

/* ── HR Drift (aerobic decoupling via HR stream) ── */

/**
 * Compute aerobic decoupling for a single activity using the HR + velocity stream.
 * Method (TrainingPeaks aerobic decoupling):
 *   EF = avg_velocity / avg_HR
 *   decoupling = (EF_first_half − EF_second_half) / EF_first_half × 100
 * Positive = cardiac drift (HR rising relative to pace) → flag if > 5%.
 */
async function calcAerobicDecoupling(activityId, accessToken) {
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/activities/${activityId}/streams` +
      `?keys=heartrate,velocity_smooth,time&key_by_type=true&resolution=medium`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (!r.ok) return null;
    const streams = await r.json();

    const hrData   = streams.heartrate       && streams.heartrate.data;
    const velData  = streams.velocity_smooth && streams.velocity_smooth.data;
    const timeData = streams.time            && streams.time.data;
    if (!hrData || !velData || !timeData || hrData.length < 20) return null;

    // Trim warmup (first 600 s) and cooldown (last 300 s)
    const totalDur = timeData[timeData.length - 1];
    let startIdx = 0, endIdx = timeData.length - 1;
    for (let i = 0; i < timeData.length; i++) {
      if (timeData[i] >= 600) { startIdx = i; break; }
    }
    for (let i = timeData.length - 1; i >= 0; i--) {
      if (timeData[i] <= totalDur - 300) { endIdx = i; break; }
    }
    if (endIdx - startIdx < 10) return null;

    const hrTrimmed  = hrData.slice(startIdx, endIdx + 1);
    const velTrimmed = velData.slice(startIdx, endIdx + 1);

    // Skip if pace CV > 0.08 (fartlek / intervals — not steady-state)
    const n = hrTrimmed.length;
    const velMean = velTrimmed.reduce((s, v) => s + v, 0) / n;
    if (velMean < 0.5) return null;
    const velStd = Math.sqrt(velTrimmed.reduce((s, v) => s + (v - velMean) ** 2, 0) / n);
    if (velStd / velMean > 0.08) return null;

    // Split in half; compute EF (efficiency factor) for each
    const mid    = Math.floor(n / 2);
    const sumVel1 = velTrimmed.slice(0, mid).reduce((s, v) => s + v, 0);
    const sumHR1  = hrTrimmed.slice(0, mid).reduce((s, v) => s + v, 0);
    const sumVel2 = velTrimmed.slice(mid).reduce((s, v) => s + v, 0);
    const sumHR2  = hrTrimmed.slice(mid).reduce((s, v) => s + v, 0);
    if (!sumHR1 || !sumHR2) return null;

    const ef1 = sumVel1 / sumHR1;
    const ef2 = sumVel2 / sumHR2;
    if (!ef1) return null;

    return Math.round((ef1 - ef2) / ef1 * 1000) / 10; // % with 1 dp
  } catch (_) { return null; }
}

async function getHRDriftTrend(activities, accessToken) {
  // Long runs ≥ 60 min, up to 5 most recent (stream calls are heavier than lap calls)
  const longRuns = activities
    .filter(a => isRun(a) && (a.moving_time || 0) >= 3600)
    .slice(0, 5);

  if (!longRuns.length) return [];

  const results = await Promise.all(longRuns.map(async (a) => {
    const driftPct = await calcAerobicDecoupling(a.id, accessToken);
    if (driftPct === null) return null;
    const date = new Date(a.start_date_local || a.start_date)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return {
      date,
      name:     a.name || 'Long Run',
      distMi:   Math.round((a.distance || 0) / 1609.34 * 10) / 10,
      driftPct,
      flag:     driftPct > 5,
    };
  }));

  // Oldest first, drop nulls
  return results.filter(Boolean).reverse();
}
