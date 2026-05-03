'use strict';

/**
 * _stream-analysis.js — Pure HR stream analysis functions.
 * No I/O, no KV, no Strava calls. Exported for use by streams.js and streams-batch.js.
 *
 * All time values are in seconds. HR values are in bpm.
 * Velocity values are m/s from Strava (velocity_smooth stream).
 */

/**
 * HR zone boundaries for stream analysis (5-zone Coggan model).
 * Cycling zones shifted down 5% maxHR to account for lower cardiac ceiling.
 *
 * @param {number} maxHR
 * @param {string} activityType  Strava activity type string
 * @returns {{ z1, z2, z3, z4, z5 }} each zone has { lo, hi } bpm thresholds
 */
function getStreamZones(maxHR, activityType) {
  if (!maxHR || maxHR < 100 || maxHR > 230) return null;
  const isCycling = /ride|cycling|velo|virtualride|ebikeride/i.test(activityType || '');
  // Cycling: effective max HR used for zone math is 5% lower
  const m = isCycling ? maxHR * 0.95 : maxHR;
  return {
    z1: { lo: 0,       hi: m * 0.60 },  // Recovery
    z2: { lo: m * 0.60, hi: m * 0.70 }, // Aerobic base
    z3: { lo: m * 0.70, hi: m * 0.80 }, // Tempo / aerobic threshold
    z4: { lo: m * 0.80, hi: m * 0.90 }, // Threshold
    z5: { lo: m * 0.90, hi: Infinity },  // VO2max / neuromuscular
  };
}

/**
 * Main analysis entry point.
 *
 * @param {{ heartrate: number[], time: number[], distance: number[], velocity_smooth: number[] }} streams
 * @param {number|null} maxHR
 * @param {string} activityType
 * @returns {object|null}  Full analysis object, or null if data is insufficient.
 */
function analyzeHRStream(streams, maxHR, activityType) {
  const hr  = streams.heartrate       || [];
  const t   = streams.time            || [];
  const d   = streams.distance        || [];
  const vel = streams.velocity_smooth || [];

  // Require at least 60 HR samples for meaningful analysis
  if (!hr.length || hr.length < 60) return null;
  if (!maxHR || maxHR < 100 || maxHR > 230) return null;

  const zones = getStreamZones(maxHR, activityType);
  const n     = hr.length;

  // Build a time array: Strava time streams are cumulative seconds from start.
  // If time stream absent, synthesise 1s per sample.
  const tArr = t.length === n ? t : Array.from({ length: n }, (_, i) => i);

  // ── Zone time accumulation ─────────────────────────────────────────────────
  // Each sample represents 1 second (Strava streams at 1-Hz resolution).
  const zoneSec = { z1: 0, z2: 0, z3: 0, z4: 0, z5: 0 };
  let totalSec  = 0;
  let hrSum     = 0;
  let hrMax     = 0;
  let validHR   = 0;

  for (let i = 0; i < n; i++) {
    const h = hr[i];
    if (!h || h < 30 || h > 230) continue; // ignore obviously bad samples
    totalSec++;
    hrSum += h;
    validHR++;
    if (h > hrMax) hrMax = h;

    if      (h < zones.z1.hi) zoneSec.z1++;
    else if (h < zones.z2.hi) zoneSec.z2++;
    else if (h < zones.z3.hi) zoneSec.z3++;
    else if (h < zones.z4.hi) zoneSec.z4++;
    else                      zoneSec.z5++;
  }

  if (totalSec < 60) return null;

  const pct = (s) => Math.round(s / totalSec * 100);
  const zonesOut = {
    z1: { s: zoneSec.z1, pct: pct(zoneSec.z1) },
    z2: { s: zoneSec.z2, pct: pct(zoneSec.z2) },
    z3: { s: zoneSec.z3, pct: pct(zoneSec.z3) },
    z4: { s: zoneSec.z4, pct: pct(zoneSec.z4) },
    z5: { s: zoneSec.z5, pct: pct(zoneSec.z5) },
  };
  const avgHR = validHR > 0 ? Math.round(hrSum / validHR) : null;

  // ── Effort blocks ──────────────────────────────────────────────────────────
  // Block: HR >= 80% maxHR for ≥60s. Allow gaps ≤15s under threshold.
  const blockThresh = zones.z4.lo; // 80% maxHR
  const effortBlocks = [];
  let blockStart = null;
  let gapStart   = null;
  let blockHRSum = 0;
  let blockCount = 0;
  let blockPeak  = 0;

  function closeBlock(endIdx) {
    const dur = tArr[endIdx] - tArr[blockStart];
    if (dur >= 60) {
      effortBlocks.push({
        startTime: tArr[blockStart],
        durationS: Math.round(dur),
        avgHR:     blockCount > 0 ? Math.round(blockHRSum / blockCount) : 0,
        peakHR:    blockPeak,
      });
    }
    blockStart = null; gapStart = null; blockHRSum = 0; blockCount = 0; blockPeak = 0;
  }

  for (let i = 0; i < n; i++) {
    const h = hr[i];
    if (!h || h < 30) continue;
    if (h >= blockThresh) {
      if (blockStart === null) blockStart = i;
      gapStart = null;
      blockHRSum += h; blockCount++;
      if (h > blockPeak) blockPeak = h;
    } else {
      if (blockStart !== null) {
        if (gapStart === null) gapStart = i;
        // Close block if gap exceeds 15s
        if (tArr[i] - tArr[gapStart] > 15) closeBlock(gapStart);
      }
    }
  }
  if (blockStart !== null) closeBlock(n - 1);

  // ── Cardiac recovery (HRR-60) ─────────────────────────────────────────────
  // For each effort block: measure BPM dropped in the 60 seconds after peak.
  const recoveryEvents = [];
  for (const block of effortBlocks) {
    const blockEndSec = block.startTime + block.durationS;
    // Find index at block end
    let endIdx = tArr.findIndex(t2 => t2 >= blockEndSec);
    if (endIdx < 0) continue;
    // Find index ~60s after block end
    const targetSec = blockEndSec + 60;
    let idx60 = tArr.findIndex(t2 => t2 >= targetSec);
    if (idx60 < 0) idx60 = n - 1;
    if (idx60 >= n || idx60 <= endIdx) continue;

    // Smooth over ±3s window at the 60s mark
    const window = [];
    for (let j = Math.max(0, idx60 - 3); j <= Math.min(n - 1, idx60 + 3); j++) {
      if (hr[j] && hr[j] > 30) window.push(hr[j]);
    }
    if (!window.length) continue;
    const hrAt60 = window.reduce((a, b) => a + b, 0) / window.length;
    const dropBPM = Math.round(block.peakHR - hrAt60);
    if (dropBPM > 5) {
      recoveryEvents.push({ peakHR: block.peakHR, dropS: dropBPM }); // dropS = BPM/60s (spec field name)
    }
  }

  const avgRecoveryS = recoveryEvents.length > 0
    ? Math.round(recoveryEvents.reduce((s, r) => s + r.dropS, 0) / recoveryEvents.length)
    : null;

  // ── Aerobic decoupling ─────────────────────────────────────────────────────
  const decoupling = computeDecoupling(hr, tArr, vel, n);

  // ── Training Effect (Firstbeat-approximation) ──────────────────────────────
  const trainingEffect = computeTrainingEffect(zonesOut, totalSec);

  return {
    analyzedAt:      Date.now(),
    activityType:    activityType || '',
    maxHRUsed:       maxHR,
    totalSeconds:    totalSec,
    avgHR,
    maxHR:           hrMax,
    zones:           zonesOut,
    effortBlocks,
    recoveryEvents,
    avgRecoveryS,
    decoupling,
    trainingEffect,
  };
}

/**
 * Aerobic decoupling: compares HR/pace efficiency factor between first and second halves.
 * Requires velocity stream. Returns { available: false } if data is insufficient.
 */
function computeDecoupling(hr, tArr, vel, n) {
  const absent = { available: false };
  if (!vel || vel.length < n * 0.5) return absent;

  // Trim 5-min warmup and 3-min cooldown
  const startSec = tArr[0] + 300;
  const endSec   = tArr[n - 1] - 180;
  if (endSec - startSec < 600) return absent; // activity too short after trimming

  const startIdx = tArr.findIndex(t => t >= startSec);
  const endIdx   = findLastIndex(tArr, t => t <= endSec);
  if (startIdx < 0 || endIdx <= startIdx) return absent;

  const trimHR  = hr.slice(startIdx, endIdx + 1);
  const trimVel = vel.slice(startIdx, endIdx + 1);

  // Check if activity is steady-state (coefficient of variation of velocity < 15%)
  const velMean = _avg(trimVel.filter(v => v > 0));
  if (!velMean || velMean < 0.5) return absent; // too slow / no movement
  const velStd  = Math.sqrt(_avg(trimVel.map(v => (v - velMean) ** 2)));
  if (velStd / velMean > 0.20) return absent; // too variable — intervals, not steady state

  // Split in half
  const mid    = Math.floor(trimHR.length / 2);
  const h1HR   = _avg(trimHR.slice(0, mid).filter(h => h > 30));
  const h2HR   = _avg(trimHR.slice(mid).filter(h => h > 30));
  const h1Vel  = _avg(trimVel.slice(0, mid).filter(v => v > 0));
  const h2Vel  = _avg(trimVel.slice(mid).filter(v => v > 0));

  if (!h1HR || !h2HR || !h1Vel || !h2Vel) return absent;

  const ef1 = h1Vel / h1HR;  // efficiency factor = velocity per HR
  const ef2 = h2Vel / h2HR;
  if (!ef1) return absent;

  // Decoupling % = (second-half EF - first-half EF) / first-half EF × 100
  // Positive = efficiency declined (heart rate rose relative to pace) — aerobic drift
  // Negative = efficiency improved (unlikely but possible with warmup effect)
  const pct = Math.round(((ef2 - ef1) / ef1) * -100 * 10) / 10; // flip sign: pos=worse
  return { available: true, pct, flagged: pct > 5 };
}

/**
 * Firstbeat-approximation Training Effect score (1.0–5.0 each).
 * Based on zone distribution relative to total duration.
 */
function computeTrainingEffect(zones, totalSec) {
  if (!totalSec) return { aerobic: 1.0, anaerobic: 1.0 };

  const z2p = zones.z2.pct;
  const z3p = zones.z3.pct;
  const z4p = zones.z4.pct;
  const z5p = zones.z5.pct;

  // Aerobic TE: driven by sustained Z2/Z3/Z4 time
  const aerobicStimulus = (z2p * 0.5 + z3p * 1.0 + z4p * 1.5 + z5p * 0.5) / 100;
  // Duration amplifier: longer sessions increase aerobic effect
  const durFactor = Math.min(1.4, 0.6 + totalSec / 7200);
  const aerobic = Math.min(5.0, Math.max(1.0, Math.round((1.0 + aerobicStimulus * 11.0 * durFactor) * 10) / 10));

  // Anaerobic TE: driven by Z5 time
  const anaerobicStimulus = z5p / 100;
  const anaerobic = Math.min(5.0, Math.max(1.0, Math.round((1.0 + anaerobicStimulus * 16.0) * 10) / 10));

  return { aerobic, anaerobic };
}

/* ── Private helpers ──────────────────────────────────────────────────────── */

function _avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function findLastIndex(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i;
  }
  return -1;
}

module.exports = { getStreamZones, analyzeHRStream };
