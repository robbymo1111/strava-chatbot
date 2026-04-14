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
   * Zones are defined as % of VO₂max (oxygen cost), NOT % of vVO₂max.
   * We solve the quadratic vo2AtV(v) = vdot * pct for velocity v:
   *   0.000104v² + 0.182258v - (4.60 + target) = 0
   *
   *   Easy      59–64 % VO₂max  (~8:55–9:25/mi at VDOT 50)
   *   Marathon  76–80 % VO₂max  (~7:22–7:42/mi at VDOT 50)
   *   Threshold 83–88 % VO₂max  (~6:51–7:11/mi at VDOT 50)
   *   Interval  95–100% VO₂max  (~6:10–6:26/mi at VDOT 50)
   *   Rep       vVO₂max ×1.05–1.15 (above VO₂max)
   */
  function trainingPaces(vdot) {
    const vMax = vVO2max(vdot);
    const mpm  = v => 1609.34 / v;   // m/min → min/mile

    // Solve for velocity (m/min) where VO₂ cost = vdot × pct
    function vAtPct(pct) {
      const target = vdot * pct;
      const a = 0.000104, b = 0.182258, c = -(4.60 + target);
      return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
    }

    return {
      easy:      [ mpm(vAtPct(0.64)), mpm(vAtPct(0.59)) ],
      marathon:  [ mpm(vAtPct(0.80)), mpm(vAtPct(0.76)) ],
      threshold: [ mpm(vAtPct(0.88)), mpm(vAtPct(0.83)) ],
      interval:  [ mpm(vAtPct(1.00)), mpm(vAtPct(0.95)) ],
      rep:       [ mpm(vMax * 1.15),  mpm(vMax * 1.05)  ],
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
