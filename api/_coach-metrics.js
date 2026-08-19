'use strict';

/**
 * COACH METRICS — the deterministic layer.
 *
 * Pure functions. The model never does arithmetic on training load; it receives
 * these numbers as facts and explains them (build spec §1).
 *
 * Two families:
 *   Per-activity  — absolute-band HR classification, gray zone, rep analysis
 *   Rolling       — trailing averages, ramp, spacing, block position
 *
 * IMPORTANT — absolute vs relative HR bands:
 * `_stream-analysis.js` computes maxHR-relative Coggan zones (z1–z5). That is
 * the wrong frame for this athlete: max HR is unresolved (observed 169 vs
 * assumed 181), so relative zones shift under an unknown. The knowledge base
 * specifies ABSOLUTE bands. These are those bands.
 */

/* ── Absolute HR bands (knowledge base §2) ─────────────────────────────────── */

const HR_BANDS = {
  easy:      { lo:   0, hi: 136, label: 'Easy'            },
  gray:      { lo: 136, hi: 152, label: 'GRAY ZONE'       }, // ⚠️ flagship error
  mp:        { lo: 152, hi: 155, label: 'Marathon pace'   },
  subt:      { lo: 155, hi: 163, label: 'Sub-threshold'   },
  threshold: { lo: 163, hi: 168, label: 'Threshold'       },
  vo2:       { lo: 168, hi: 999, label: '5K / VO2'        },
};

// Named ranges from the KB that overlap the partition above — reported separately.
const MP_BAND_LO   = 152, MP_BAND_HI   = 160;  // KB: MP sits 152–160
const SUBT_BAND_LO = 155, SUBT_BAND_HI = 162;  // KB: sub-T reps 155–162
const RECOVERY_CLEAR_HR = 140;                 // KB §8.2: recoveries should drop below ~140
const EASY_HR_CEILING   = 136;

/* ── helpers ───────────────────────────────────────────────────────────────── */

function r1(n) { return Math.round(n * 10) / 10; }
function pct(part, whole) { return whole > 0 ? Math.round(part / whole * 1000) / 10 : 0; }
function isRun(a) { return /run/i.test(a.type || a.ty || ''); }

function activityDate(a) {
  return (a.start_date_local || a.start_date || a.d || '').slice(0, 10);
}
function activityMiles(a) {
  if (a.mi != null) return a.mi;
  return (a.distance || 0) / 1609.34;
}
function activityMovingSec(a) {
  return a.moving_time || a.sec || 0;
}
function activityElapsedSec(a) {
  return a.elapsed_time || a.el_s || 0;
}

/**
 * The athlete's local calendar date as YYYY-MM-DD.
 *
 * Vercel runs in UTC. Between 20:00 and 23:59 Brooklyn time the UTC date is
 * already tomorrow, so a UTC-derived "today" makes the coach a day ahead every
 * evening — wrong day-of-week, wrong days-to-race, wrong week bucketing.
 * Every date in the system derives from this one function.
 */
const DEFAULT_TZ = 'America/New_York';

function athleteToday(tz, now) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz || DEFAULT_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now || new Date());
}

/**
 * Format a YYYY-MM-DD as a long human date. Anchored at noon UTC so the
 * weekday never shifts under a timezone conversion.
 */
function formatLongDate(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  });
}

/** Signed day count from `from` to `to`. Positive = `to` is in the future. */
function daysUntil(from, to) {
  if (!from || !to) return null;
  return Math.round(
    (new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000
  );
}

/** Monday-start week key for a YYYY-MM-DD date. */
function weekStart(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  if (!a || !b) return null;
  return Math.round(Math.abs(new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000);
}

/* ══════════════════════════════════════════════════════════════════════════════
   PER-ACTIVITY METRICS
   ══════════════════════════════════════════════════════════════════════════════ */

/**
 * Bin an HR stream into the absolute KB bands.
 * @param {number[]} hrStream - per-second heart rate samples
 * @returns {{seconds, pcts, mpBandSec, subtBandSec, totalSec, avgHR, peakHR}|null}
 */
function classifyHRSeconds(hrStream) {
  if (!Array.isArray(hrStream) || hrStream.length < 10) return null;

  const valid = hrStream.filter(h => h > 40 && h < 230);
  if (!valid.length) return null;

  const seconds = { easy: 0, gray: 0, mp: 0, subt: 0, threshold: 0, vo2: 0 };
  let mpBandSec = 0, subtBandSec = 0;

  for (const h of valid) {
    if      (h < HR_BANDS.easy.hi)      seconds.easy++;
    else if (h < HR_BANDS.gray.hi)      seconds.gray++;
    else if (h < HR_BANDS.mp.hi)        seconds.mp++;
    else if (h < HR_BANDS.subt.hi)      seconds.subt++;
    else if (h < HR_BANDS.threshold.hi) seconds.threshold++;
    else                                seconds.vo2++;

    if (h >= MP_BAND_LO   && h <= MP_BAND_HI)   mpBandSec++;
    if (h >= SUBT_BAND_LO && h <= SUBT_BAND_HI) subtBandSec++;
  }

  const totalSec = valid.length;
  const pcts = {};
  for (const k of Object.keys(seconds)) pcts[k] = pct(seconds[k], totalSec);

  return {
    seconds, pcts, mpBandSec, subtBandSec, totalSec,
    avgHR:  Math.round(valid.reduce((s, h) => s + h, 0) / totalSec),
    peakHR: Math.max(...valid),
  };
}

/**
 * Gray-zone percentage — the flagship metric (KB §2, spec §2.3).
 *
 * Time at HR 136–152 as a share of moving time. This is an EASY-RUN error
 * metric: it measures running easy days too hard. During a quality session,
 * passing through 136–152 on the way to sub-T is expected and correct, so
 * `flagged` is only true for easy/long sessions.
 */
function computeGrayZone(hrStream, sessionType) {
  const z = classifyHRSeconds(hrStream);
  if (!z) return null;

  const isEasyIntent = sessionType === 'easy' || sessionType === 'long';
  const grayPct = z.pcts.gray;

  return {
    grayPct,
    graySeconds: z.seconds.gray,
    easyPct:     z.pcts.easy,
    totalSec:    z.totalSec,
    // KB §8.2: "Easy run: was >90% of time under HR 136?"
    easyDisciplineOk: isEasyIntent ? z.pcts.easy >= 90 : null,
    flagged: isEasyIntent && grayPct > 10,
    detail: isEasyIntent
      ? (grayPct > 10
          ? `${grayPct}% of this run sat in the gray zone (HR 136–152) — the primary historical training error. Only ${z.pcts.easy}% stayed under 136.`
          : `${z.pcts.easy}% under HR 136, ${grayPct}% gray. Properly easy.`)
      : `${grayPct}% in the 136–152 band — expected for a quality session (warmup, recoveries, ramp to sub-T). Not a gray-zone error.`,
  };
}

/**
 * Analyze work intervals of a quality session.
 * Grades against the KB sub-T band (155–162) and checks recovery clearance.
 *
 * @param {Array} reps - [{ label, avgHR, maxHR, paceMinMi, durationSec }]
 * @param {Array} recoveries - [{ minHR }] optional
 */
function analyzeReps(reps, recoveries) {
  if (!Array.isArray(reps) || !reps.length) return null;

  const hrs = reps.map(r => r.avgHR).filter(h => h > 0);
  const inBand = hrs.filter(h => h >= SUBT_BAND_LO && h <= SUBT_BAND_HI).length;

  // Drift: did HR climb above the band by the final rep?
  const first = hrs[0], last = hrs[hrs.length - 1];
  const driftBpm = (first != null && last != null) ? last - first : null;
  const droveAboveBand = last != null && last > SUBT_BAND_HI;

  // Recovery clearance (KB §8.2: recoveries should drop below ~140)
  let recoveryClearance = null;
  if (Array.isArray(recoveries) && recoveries.length) {
    const cleared = recoveries.filter(r => r.minHR != null && r.minHR < RECOVERY_CLEAR_HR).length;
    recoveryClearance = {
      cleared,
      total: recoveries.length,
      allCleared: cleared === recoveries.length,
      minHRs: recoveries.map(r => r.minHR),
    };
  }

  return {
    repCount: reps.length,
    repHRs: hrs,
    inBandCount: inBand,
    allInBand: inBand === hrs.length,
    driftBpm,
    droveAboveBand,
    recoveryClearance,
    // KB §2: pace is primary, HR is a ceiling. A rep on pace with high HR is fine.
    verdict: droveAboveBand
      ? `HR drifted above the 155–162 band by the final rep (${last}). Check whether pace held — if pace was on target, this is heat or fatigue, not a pacing error.`
      : inBand === hrs.length
        ? `All ${reps.length} reps averaged inside the 155–162 sub-T band (${hrs.join('/')}). Clean execution.`
        : `Rep HRs ${hrs.join('/')} — ${inBand}/${hrs.length} inside the 155–162 band. Pace is primary; a low-HR early rep is a warmup artifact, not an error.`,
  };
}

/**
 * Sum sub-threshold work minutes from cached lap analysis.
 *
 * Work intervals are laps classified 'Interval' (faster than threshold) or
 * 'Hard' (within ±5% of threshold) by `classifyLaps`. Warm-up, cool-down,
 * recovery jogs and easy laps are excluded — only the work counts toward the
 * 20–25% weekly target (KB §5.1).
 *
 * @param {Array} lapDataList - cached `laps:{athleteId}:{activityId}` objects
 * @param {object} opts { since, until } — YYYY-MM-DD bounds, inclusive
 * @returns {{ minutes, bySession: [{date, name, minutes, reps}] }}
 */
function computeSubTMinutes(lapDataList, opts = {}) {
  const out = { minutes: 0, bySession: [] };
  if (!Array.isArray(lapDataList)) return out;

  for (const ld of lapDataList) {
    if (!ld || !Array.isArray(ld.laps)) continue;
    const date = (ld.date || '').slice(0, 10);
    if (opts.since && date && date < opts.since) continue;
    if (opts.until && date && date > opts.until) continue;

    const work = ld.laps.filter(l =>
      l.classification === 'Interval' || l.classification === 'Hard'
    );
    if (!work.length) continue;

    const mins = work.reduce((s, l) => s + (l.durationMin || 0), 0);
    if (mins <= 0) continue;

    out.minutes += mins;
    out.bySession.push({
      date,
      name:    ld.name || 'Workout',
      minutes: Math.round(mins),
      reps:    work.length,
    });
  }

  out.minutes = Math.round(out.minutes);
  out.bySession.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return out;
}

/**
 * Infer session type from activity shape.
 * Returns: easy | long | subt | mp_long | race | cross
 */
function inferSessionType(activity, opts = {}) {
  if (!isRun(activity)) return 'cross';

  const wt     = activity.workout_type ?? activity.wt ?? 0;
  const miles  = activityMiles(activity);
  const name   = (activity.name || activity.nm || '').toLowerCase();
  const longCap = opts.longRunCapMi || 18;

  if (wt === 1 || /\brace\b|marathon|half|10k|5k\b/.test(name)) return 'race';
  if (wt === 3 || /\d+\s*x\s*\d+|@\s*mp|sub-?t|tempo|interval|threshold|\bmp\b/.test(name)) {
    return miles >= longCap * 0.7 ? 'mp_long' : 'subt';
  }
  if (wt === 2 || miles >= 12) return 'long';
  return 'easy';
}

/** Stopped time — matters for races (KB §4.2, Sugarloaf 15:44 stopped). */
function elapsedMinusMoving(activity) {
  const moving  = activityMovingSec(activity);
  const elapsed = activityElapsedSec(activity);
  if (!elapsed || !moving || elapsed < moving) return null;
  const stopped = elapsed - moving;
  return {
    stoppedSec: stopped,
    stoppedStr: `${Math.floor(stopped / 60)}:${String(stopped % 60).padStart(2, '0')}`,
    movingStr:  fmtDuration(moving),
    elapsedStr: fmtDuration(elapsed),
    significant: stopped >= 60,
  };
}

function fmtDuration(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   ROLLING METRICS
   ══════════════════════════════════════════════════════════════════════════════ */

/** Is this activity a quality effort? (workout_type, or workout-shaped name) */
function isQualityEffort(a) {
  if (!isRun(a)) return false;
  const wt   = a.workout_type ?? a.wt ?? 0;
  const name = (a.name || a.nm || '').toLowerCase();
  if (wt === 1 || wt === 3) return true;
  return /\d+\s*x\s*\d+|@\s*mp|sub-?t|tempo|interval|threshold|\bt\b\s*$|\bmp\b|race/.test(name);
}

/**
 * Build the rolling context. Pure — give it activities, get back facts.
 *
 * @param {Array}  activities - Strava or compressed shape, any order
 * @param {object} opts { today, raceDate, blockStartDate, longRunCapMi, subTMinutesThisWeek }
 */
function computeRollingContext(activities, opts = {}) {
  const today   = opts.today || athleteToday(opts.timezone);
  const acts    = (activities || []).filter(a => activityDate(a));
  const runs    = acts.filter(isRun);
  const thisWk  = weekStart(today);

  // ── Weekly buckets ───────────────────────────────────────────────────────
  const byWeek = {};
  for (const a of runs) {
    const wk = weekStart(activityDate(a));
    if (!byWeek[wk]) byWeek[wk] = { miles: 0, minutes: 0, longRunMi: 0, quality: 0 };
    const mi = activityMiles(a);
    byWeek[wk].miles     += mi;
    byWeek[wk].minutes   += activityMovingSec(a) / 60;
    byWeek[wk].longRunMi  = Math.max(byWeek[wk].longRunMi, mi);
    if (isQualityEffort(a)) byWeek[wk].quality++;
  }

  const currentWeek = byWeek[thisWk] || { miles: 0, minutes: 0, longRunMi: 0, quality: 0 };

  // ── Trailing 4-week average (the 4 COMPLETE weeks before this one) ───────
  const priorWeeks = [];
  for (let i = 1; i <= 4; i++) {
    const d = new Date(thisWk + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() - i * 7);
    const wk = d.toISOString().slice(0, 10);
    priorWeeks.push({ wk, ...(byWeek[wk] || { miles: 0, minutes: 0, longRunMi: 0, quality: 0 }) });
  }
  const trailing4wkAvgMiles = priorWeeks.reduce((s, w) => s + w.miles, 0) / 4;

  // ── Consecutive weeks above 55mi (most recent backward) ─────────────────
  let weeksAbove55Consecutive = 0;
  for (const w of priorWeeks) {
    if (w.miles > 55) weeksAbove55Consecutive++;
    else break;
  }

  // ── 60mi weeks used this block ──────────────────────────────────────────
  let sixtyMileWeeksThisBlock = 0;
  if (opts.blockStartDate) {
    for (const [wk, v] of Object.entries(byWeek)) {
      if (wk >= weekStart(opts.blockStartDate) && v.miles >= 60) sixtyMileWeeksThisBlock++;
    }
  }

  // ── Hours since last quality effort ─────────────────────────────────────
  const qualityRuns = runs.filter(isQualityEffort)
    .sort((a, b) => activityDate(b).localeCompare(activityDate(a)));
  const lastQualityDate = qualityRuns.length ? activityDate(qualityRuns[0]) : null;
  const hoursSinceLastQuality = lastQualityDate
    ? daysBetween(lastQualityDate, today) * 24
    : null;

  // ── Long runs in the last 14 days ───────────────────────────────────────
  const longRunsLast14d = runs
    .filter(a => {
      const gap = daysBetween(activityDate(a), today);
      return gap != null && gap <= 14 && activityMiles(a) >= 12;
    })
    .map(a => ({ date: activityDate(a), distanceMi: r1(activityMiles(a)) }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const maxLongRunLast14d = longRunsLast14d.length
    ? Math.max(...longRunsLast14d.map(l => l.distanceMi)) : 0;

  // ── Last marathon ───────────────────────────────────────────────────────
  const marathons = runs
    .filter(a => activityMiles(a) >= 26)
    .sort((a, b) => activityDate(b).localeCompare(activityDate(a)));
  const lastMarathonDate = marathons.length ? activityDate(marathons[0]) : null;

  // ── Block position ──────────────────────────────────────────────────────
  // Day counts are computed here, never left to the model. "How many days to
  // my race" is date arithmetic — deterministic work (spec §1).
  let weeksToRace = null, daysToRace = null, isRaceWeek = false;
  let blockWeek = null, raceDateLong = null, raceDayOfWeek = null;

  if (opts.raceDate) {
    daysToRace   = daysUntil(today, opts.raceDate);
    weeksToRace  = daysToRace != null ? r1(daysToRace / 7) : null;
    isRaceWeek   = daysToRace != null && daysToRace >= 0 && daysToRace <= 7;
    raceDateLong = formatLongDate(opts.raceDate);
    raceDayOfWeek = new Date(opts.raceDate + 'T12:00:00Z')
      .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  }
  if (opts.blockStartDate) {
    const d = daysUntil(opts.blockStartDate, today);
    blockWeek = d != null ? Math.floor(d / 7) + 1 : null;
  }

  // ── Upcoming key sessions with day counts ───────────────────────────────
  const upcomingKeySessions = (opts.keySessions || [])
    .map(k => ({ ...k, daysAway: daysUntil(today, k.date) }))
    .filter(k => k.daysAway != null && k.daysAway >= 0)
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, 3);

  // ── Ramp ────────────────────────────────────────────────────────────────
  const rampCeilingMi = trailing4wkAvgMiles * 1.10;
  const rampPct = trailing4wkAvgMiles > 0
    ? r1((currentWeek.miles / trailing4wkAvgMiles - 1) * 100) : null;

  // Sub-T minutes are NOT inferable from the activity list. Caller supplies
  // them from lap data if available; otherwise null (never fabricate).
  const subTMinutesThisWeek = opts.subTMinutesThisWeek != null ? opts.subTMinutesThisWeek : null;
  const subTPctOfWeeklyTime = (subTMinutesThisWeek != null && currentWeek.minutes > 0)
    ? r1(subTMinutesThisWeek / currentWeek.minutes * 100) : null;

  return {
    today,
    todayLong:     formatLongDate(today),
    todayDayOfWeek: new Date(today + 'T12:00:00Z')
      .toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }),
    timezone: opts.timezone || DEFAULT_TZ,
    trailing4wkAvgMiles: r1(trailing4wkAvgMiles),
    trailingWeeks:       priorWeeks.map(w => ({ week: w.wk, miles: r1(w.miles), quality: w.quality })),
    currentWeekMiles:    r1(currentWeek.miles),
    currentWeekMinutes:  Math.round(currentWeek.minutes),
    currentWeekLongRunMi: r1(currentWeek.longRunMi),
    currentWeekQuality:  currentWeek.quality,
    weeklyRunMinutes:    Math.round(currentWeek.minutes),
    rampPct,
    rampCeilingMi:       r1(rampCeilingMi),
    hoursSinceLastQuality,
    lastQualityDate,
    longRunsLast14d,
    maxLongRunLast14d,
    lastMarathonDate,
    weeksAbove55Consecutive,
    sixtyMileWeeksThisBlock,
    weeksToRace,
    daysToRace,
    raceDate: opts.raceDate || null,
    raceDateLong,
    raceDayOfWeek,
    upcomingKeySessions,
    blockWeek,
    isRaceWeek,
    subTMinutesThisWeek,
    subTPctOfWeeklyTime,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════
   CONTEXT BLOCK (build spec §5)
   Terse and numeric. The model has the interpretive framework in the system
   prompt; it needs facts, not prose.
   ══════════════════════════════════════════════════════════════════════════════ */

function buildContextBlock(rolling, extras = {}) {
  if (!rolling) return '';
  const L = [];

  // Dates are stated once, fully resolved, in the athlete's timezone. The model
  // must never do calendar arithmetic — it is the thing it gets wrong most.
  L.push(`TODAY: ${rolling.todayLong}  [${rolling.today}, ${rolling.timezone}]`);

  if (rolling.blockWeek) L.push(`block_week: W${rolling.blockWeek}`);

  if (rolling.daysToRace != null) {
    const d = rolling.daysToRace;
    const phrase = d === 0 ? 'RACE DAY' : d < 0 ? `${Math.abs(d)} days ago` : `in ${d} days`;
    L.push(
      `GOAL RACE: ${rolling.raceDateLong} (${rolling.raceDate}) — ${phrase}` +
      (d > 0 ? ` = ${rolling.weeksToRace} weeks` : '')
    );
  }

  if (rolling.upcomingKeySessions?.length) {
    L.push('next_key_sessions:');
    for (const k of rolling.upcomingKeySessions) {
      const when = k.daysAway === 0 ? 'TODAY'
                 : k.daysAway === 1 ? 'tomorrow'
                 : `in ${k.daysAway} days`;
      const dow = new Date(k.date + 'T12:00:00Z')
        .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
      L.push(`  ${k.date} (${dow}, ${when}) — ${k.type}: ${k.detail}`);
    }
  }

  // Ramp % is only meaningful once the week has miles in it — a Monday morning
  // reading of "-100%" is arithmetically true and completely useless.
  const showRamp = rolling.rampPct != null && rolling.currentWeekMiles > 0;
  L.push(
    `trailing_4wk_avg: ${rolling.trailing4wkAvgMiles}mi · current_week: ${rolling.currentWeekMiles}mi` +
    ` · ramp_ceiling: ${rolling.rampCeilingMi}mi` +
    (showRamp ? ` · ramp: ${rolling.rampPct > 0 ? '+' : ''}${rolling.rampPct}%` : ' (week in progress)')
  );

  L.push(`weekly_miles_by_week (oldest→newest): ${rolling.trailingWeeks.map(w => w.miles).join(' | ')} → ${rolling.currentWeekMiles} (current)`);

  const lastLR = rolling.longRunsLast14d[0];
  const ago = d => {
    const n = daysBetween(d, rolling.today);
    return n === 0 ? 'today' : n === 1 ? 'yesterday' : `${n}d ago`;
  };
  L.push(
    `hours_since_quality: ${rolling.hoursSinceLastQuality ?? '?'}` +
    (rolling.lastQualityDate ? ` (${rolling.lastQualityDate}, ${ago(rolling.lastQualityDate)})` : '') +
    ` · last_long_run: ${lastLR ? `${lastLR.distanceMi}mi (${lastLR.date}, ${ago(lastLR.date)})` : 'none in 14d'}`
  );

  if (rolling.longRunsLast14d.length > 1) {
    L.push(`long_runs_14d: ${rolling.longRunsLast14d.map(l => `${l.distanceMi}mi ${l.date}`).join(', ')}`);
  }

  L.push(
    `subt_this_week: ${rolling.subTMinutesThisWeek != null ? `${rolling.subTMinutesThisWeek}min (${rolling.subTPctOfWeeklyTime}% of ${rolling.currentWeekMinutes}min)` : 'UNKNOWN — no lap data'}` +
    ` · target 20–25%`
  );

  const flags = [];
  if (rolling.weeksAbove55Consecutive >= 2) flags.push(`step-back week required (${rolling.weeksAbove55Consecutive} consecutive weeks >55mi)`);
  if (rolling.isRaceWeek)                   flags.push('RACE WEEK — 20mi cap');
  if (rolling.sixtyMileWeeksThisBlock > 0)  flags.push(`${rolling.sixtyMileWeeksThisBlock}× 60mi week used this block`);
  if (rolling.maxLongRunLast14d >= 17)      flags.push(`long run ${rolling.maxLongRunLast14d}mi in last 14d — Rule 4 active`);
  L.push(`flags: ${flags.length ? flags.join(' · ') : 'none'}`);

  if (extras.weatherLine) L.push(extras.weatherLine);
  if (extras.loadLine)    L.push(extras.loadLine);

  return `\n## DETERMINISTIC CONTEXT (computed, not estimated — do not recalculate)
Every date and count below is already resolved in the athlete's local timezone.
Never compute a date, day-of-week, or countdown yourself — read it from here. If
a date you need is not listed, say so rather than deriving it.
\`\`\`\n${L.join('\n')}\n\`\`\`\n`;
}

module.exports = {
  // per-activity
  classifyHRSeconds,
  computeGrayZone,
  analyzeReps,
  inferSessionType,
  elapsedMinusMoving,
  computeSubTMinutes,
  // rolling
  computeRollingContext,
  isQualityEffort,
  buildContextBlock,
  // dates
  athleteToday,
  formatLongDate,
  daysUntil,
  DEFAULT_TZ,
  // internals for testing
  weekStart,
  HR_BANDS,
  constants: {
    MP_BAND_LO, MP_BAND_HI, SUBT_BAND_LO, SUBT_BAND_HI,
    RECOVERY_CLEAR_HR, EASY_HR_CEILING,
  },
};
