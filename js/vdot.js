/* ── VDOT Calculator — Jack Daniels' Running Formula ──────────────────────
   All math from "Daniels' Running Formula" (3rd ed.)
   ─────────────────────────────────────────────────────────────────────── */
window.VDOT = (function () {
  'use strict';

  /* Common race distances in meters */
  const DISTANCES = {
    '1 Mile':        1609.34,
    '5K':            5000,
    '10K':           10000,
    'Half Marathon': 21097.5,
    'Marathon':      42195,
  };

  /* ── Core formulas ── */

  /** VO₂ cost (ml/kg/min) at velocity v (m/min) */
  function vo2AtV(v) {
    return -4.60 + 0.182258 * v + 0.000104 * v * v;
  }

  /** Fraction of VO₂max utilised at race duration t (minutes) */
  function pctVO2MaxAtT(t) {
    return 0.8
      + 0.1894393 * Math.exp(-0.012778  * t)
      + 0.2989558 * Math.exp(-0.1932605 * t);
  }

  /* ── Public API ── */

  /**
   * Calculate VDOT from a race result.
   * @param {number} distM   Race distance in metres
   * @param {number} timeSec Finish time in seconds
   * @returns {number} VDOT score
   */
  function calculate(distM, timeSec) {
    const t = timeSec / 60;         // minutes
    const v = distM   / t;          // m/min
    return vo2AtV(v) / pctVO2MaxAtT(t);
  }

  /**
   * Velocity at VO₂max (m/min) from a VDOT score.
   * Derived by solving:  VDOT = -4.60 + 0.182258v + 0.000104v²
   */
  function vVO2max(vdot) {
    const a = 0.000104, b = 0.182258, c = -(vdot + 4.60);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }

  /**
   * Predict finish time (seconds) for a given distance using binary search.
   * @param {number} vdot
   * @param {number} distM Distance in metres
   * @returns {number} Predicted time in seconds
   */
  function predictTime(vdot, distM) {
    const vMax = vVO2max(vdot);
    let lo = vMax * 0.35;   // very slow (below easy pace)
    let hi = vMax * 1.25;   // very fast (above rep pace)

    for (let i = 0; i < 64; i++) {
      const mid      = (lo + hi) / 2;
      const tMin     = distM / mid;
      const computed = vo2AtV(mid) / pctVO2MaxAtT(tMin);
      computed < vdot ? (lo = mid) : (hi = mid);
    }

    return (distM / ((lo + hi) / 2)) * 60; // seconds
  }

  /**
   * Training pace ranges (min/mile) for each Daniels zone.
   * Returns { easy, marathon, threshold, interval, rep }
   * Each value is [lo_pace, hi_pace] where lo < hi (lo = faster).
   *
   * Zone intensities as % of vVO₂max:
   *   Easy      59–74 %
   *   Marathon  75–84 %
   *   Threshold 83–88 %
   *   Interval  95–100 %
   *   Rep      105–115 %
   */
  function trainingPaces(vdot) {
    const vMax       = vVO2max(vdot);
    const mpm        = v => 1609.34 / v / 60; // m/min → min/mile

    return {
      easy:      [ mpm(vMax * 0.74), mpm(vMax * 0.59) ],
      marathon:  [ mpm(vMax * 0.84), mpm(vMax * 0.75) ],
      threshold: [ mpm(vMax * 0.88), mpm(vMax * 0.83) ],
      interval:  [ mpm(vMax * 1.00), mpm(vMax * 0.95) ],
      rep:       [ mpm(vMax * 1.15), mpm(vMax * 1.05) ],
    };
  }

  /* ── Formatters ── */

  /** Format seconds to H:MM:SS or M:SS */
  function fmtTime(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.round(sec % 60);
    return h > 0
      ? `${h}:${pad(m)}:${pad(s)}`
      : `${m}:${pad(s)}`;
  }

  /** Format decimal min/mile to M:SS */
  function fmtPace(minPerMile) {
    const m = Math.floor(minPerMile);
    const s = Math.round((minPerMile - m) * 60);
    return `${m}:${pad(s)}`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  return { DISTANCES, calculate, predictTime, trainingPaces, fmtTime, fmtPace };
})();
