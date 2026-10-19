'use strict';

/**
 * LOAD-FIRST WEEKLY TARGET  (the Kaizen mechanic)
 *
 * The currency is training load, not distance. A weekly load target is set
 * from current fitness and where the block is, then translated into a
 * distance you can actually act on. Run the week faster than expected and the
 * distance target falls, because you banked the load in fewer miles. Run it
 * slower and it rises.
 *
 *   load  = miles × (threshold_pace / pace) ^ k
 *   miles = load / (threshold_pace / pace) ^ k
 *
 * On k — how hard intensity is weighted:
 *   k = 1  matches running TSS (duration × IF²), which is what Intervals.icu
 *          already computes for this athlete's CTL/ATL. Default, because the
 *          whole system should agree with the load numbers he already tracks.
 *   k = 3  reproduces the one published Kaizen example (40km @ 5:30/km →
 *          30km after running 5:00/km). That example self-describes as a
 *          "random number example", so treat 3 as a dial, not a constant.
 *
 * Nothing here invents a fitness model. The load target comes from CTL, which
 * is measured, and the translation is arithmetic.
 */

const DEFAULT_K = 1;

/* ── Block phase ───────────────────────────────────────────────────────────── */

/**
 * Where the block is, derived from weeks-to-race rather than hardcoded week
 * numbers, so it stays right when a race moves.
 *
 * Returns { phase, factor, why } — factor multiplies the maintenance load.
 */
function blockPhase(opts) {
  var w = opts.weeksToRace;
  var daysSinceLastMarathon = opts.daysSinceLastMarathon;

  // Recovery after a marathon overrides everything. Roughly one easy day per
  // mile raced before hard training resumes.
  if (daysSinceLastMarathon != null && daysSinceLastMarathon < 21) {
    return { phase: 'recovery', factor: 0.70,
             why: 'recovering from a marathon ' + daysSinceLastMarathon + ' days ago' };
  }
  if (w == null)            return { phase: 'base',  factor: 1.00, why: 'no goal race set' };
  if (w <= 1)               return { phase: 'race week', factor: 0.45, why: 'race week' };
  if (w <= 2)               return { phase: 'taper', factor: 0.62, why: 'tapering' };
  if (w <= 4)               return { phase: 'sharpen', factor: 1.00, why: 'sharpening before the taper' };
  return { phase: 'build', factor: 1.08, why: 'building' };
}

/* ── Load target ───────────────────────────────────────────────────────────── */

/**
 * Weekly load (TSS) needed for a given fitness outcome.
 *
 * CTL is an exponentially weighted mean of daily load with a 42-day constant,
 * so dCTL/dt = (load − CTL)/42. Holding CTL flat needs daily load = CTL, i.e.
 * 7 × CTL per week. Gaining R CTL per week needs 7 × (CTL + 6R).
 */
function weeklyLoadTarget(opts) {
  var ctl = opts.ctl;
  if (!ctl || ctl <= 0) return null;

  var phase = opts.phase || { factor: 1, phase: 'base', why: '' };
  var gainPerWeek = opts.gainPerWeek != null ? opts.gainPerWeek : 0;

  var maintain = 7 * ctl;
  var target   = 7 * (ctl + 6 * gainPerWeek) * phase.factor;

  return {
    tss:        Math.round(target),
    maintainTss: Math.round(maintain),
    phase:      phase.phase,
    phaseWhy:   phase.why,
    factor:     phase.factor,
    gainPerWeek: gainPerWeek,
  };
}

/* ── Translating load into distance ────────────────────────────────────────── */

/** Load generated per mile at a given pace. */
function loadPerMile(paceMinMi, threshPaceMinMi, k) {
  if (!paceMinMi || !threshPaceMinMi || paceMinMi <= 0) return null;
  var kk = k == null ? DEFAULT_K : k;
  // Intensity factor as a ratio of speeds: threshold pace over actual pace.
  var intensity = threshPaceMinMi / paceMinMi;
  // Scaled so a mile AT threshold pace is 1.0 units of load.
  return Math.pow(intensity, kk);
}

/**
 * Miles required to bank a load target at a given average pace.
 * Faster pace → fewer miles. That is the whole mechanic.
 */
function milesForLoad(loadUnits, paceMinMi, threshPaceMinMi, k) {
  var per = loadPerMile(paceMinMi, threshPaceMinMi, k);
  if (!per || per <= 0) return null;
  return loadUnits / per;
}

/**
 * Calibrate the abstract load unit against this athlete's own recent weeks, so
 * "load" is denominated in something real rather than a made-up scale.
 *
 * @param {Array} weeks [{ miles, minutes }] recent complete weeks
 * @returns {number|null} average pace in min/mi across those weeks
 */
function observedWeeklyPace(weeks) {
  if (!Array.isArray(weeks) || !weeks.length) return null;
  var mi = 0, min = 0;
  for (var i = 0; i < weeks.length; i++) {
    if (!weeks[i].current) { mi += weeks[i].miles || 0; min += weeks[i].minutes || 0; }
  }
  if (mi <= 0 || min <= 0) return null;
  return min / mi;
}

/* ── The week, as the athlete sees it ──────────────────────────────────────── */

/**
 * Build the adaptive weekly target.
 *
 * @param {object} o
 *   ctl, gainPerWeek, weeksToRace, daysSinceLastMarathon,
 *   threshPaceMinMi, expectedPaceMinMi,
 *   doneMi, doneMin, k
 */
function weeklyPlan(o) {
  var phase  = blockPhase(o);
  var target = weeklyLoadTarget({ ctl: o.ctl, gainPerWeek: o.gainPerWeek, phase: phase });
  if (!target) return null;

  var k        = o.k == null ? DEFAULT_K : o.k;
  var thresh   = o.threshPaceMinMi;
  var expected = o.expectedPaceMinMi || thresh * 1.27;   // typical easy pace if unknown

  // A mile at threshold is 1 load unit, so the TSS target maps across at the
  // same scale a threshold mile occupies in rTSS (~10.8 TSS for a 6:30 mile).
  var tssPerThresholdMile = (100 / 60) * thresh;
  var loadUnits = target.tss / tssPerThresholdMile;

  var baselineMi = milesForLoad(loadUnits, expected, thresh, k);

  // What has actually been run, and at what pace
  var doneMi  = o.doneMi || 0;
  var doneMin = o.doneMin || 0;
  var actualPace = (doneMi > 0 && doneMin > 0) ? doneMin / doneMi : null;

  // Load already banked, priced at the pace it was actually run
  var bankedUnits = actualPace ? doneMi * loadPerMile(actualPace, thresh, k) : 0;
  var remainUnits = Math.max(loadUnits - bankedUnits, 0);

  // Remaining miles priced at the pace he has been running
  var pricingPace = actualPace || expected;
  var remainMi    = milesForLoad(remainUnits, pricingPace, thresh, k) || 0;

  // The revised whole-week distance — what Kaizen shows moving
  var revisedMi = doneMi + remainMi;

  return {
    phase:        target.phase,
    phaseWhy:     target.phaseWhy,
    tssTarget:    target.tss,
    maintainTss:  target.maintainTss,
    loadUnits:    Math.round(loadUnits * 10) / 10,
    bankedUnits:  Math.round(bankedUnits * 10) / 10,
    pctComplete:  loadUnits > 0 ? Math.min(bankedUnits / loadUnits, 1) : 0,
    baselineMi:   baselineMi != null ? Math.round(baselineMi * 10) / 10 : null,
    revisedMi:    Math.round(revisedMi * 10) / 10,
    doneMi:       Math.round(doneMi * 10) / 10,
    remainMi:     Math.round(remainMi * 10) / 10,
    expectedPace: expected,
    actualPace:   actualPace,
    movedBy:      baselineMi != null ? Math.round((revisedMi - baselineMi) * 10) / 10 : null,
    k:            k,
  };
}

module.exports = {
  DEFAULT_K,
  blockPhase,
  weeklyLoadTarget,
  loadPerMile,
  milesForLoad,
  observedWeeklyPace,
  weeklyPlan,
};
