/**
 * GET /api/intervals-wellness?accessToken=xxx
 *
 * Returns real fitness metrics from Intervals.icu:
 *   - CTL, ATL, TSB (form), ramp rate from /wellness
 *   - Running best efforts from /power-curves
 *
 * Requires env vars: INTERVALS_API_KEY, INTERVALS_ATHLETE_ID
 * Cached in Vercel KV with 1-hour expiry.
 * Returns { available: false } gracefully if not configured or fetch fails.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const { accessToken } = req.query;
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const apiKey    = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;

  if (!apiKey || !athleteId) {
    return res.status(200).json({ available: false, reason: 'Intervals.icu not configured' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  const today    = new Date().toISOString().split('T')[0];
  const cacheKey = `intervals:${athleteId}:wellness:${today}`;

  // ── 1. Check KV cache (1-hour TTL set at write time) ──
  if (kvUrl && kvToken) {
    try {
      const cached = await kvGet(kvUrl, kvToken, cacheKey);
      if (cached && cached.available !== false) {
        return res.status(200).json({ ...cached, fromCache: true });
      }
    } catch (_) {}
  }

  // ── 2. Fetch from Intervals.icu ──
  const auth    = Buffer.from('API_KEY:' + apiKey).toString('base64');
  const headers = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
  const base    = `https://intervals.icu/api/v1/athlete/${athleteId}`;
  const oldest  = new Date(Date.now() - 42 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

  let wellnessData = null;
  let pcData       = null;

  try {
    const [wRes, pcRes] = await Promise.all([
      fetch(`${base}/wellness?oldest=${oldest}&newest=${today}`, { headers }),
      fetch(`${base}/power-curves?type=Run&curves=year`, { headers }).catch(() => null),
    ]);

    if (!wRes.ok) {
      const msg = wRes.status === 401
        ? 'Intervals.icu API key invalid'
        : `Intervals.icu wellness returned ${wRes.status}`;
      return res.status(200).json({ available: false, reason: msg });
    }

    wellnessData = await wRes.json();

    if (pcRes && pcRes.ok) {
      try { pcData = await pcRes.json(); } catch (_) {}
    }
  } catch (err) {
    return res.status(200).json({ available: false, reason: 'Network error fetching Intervals.icu' });
  }

  if (!Array.isArray(wellnessData) || wellnessData.length === 0) {
    return res.status(200).json({ available: false, reason: 'No wellness data returned' });
  }

  // ── 3. Extract current values (most recent entry with CTL data) ──
  const sorted  = [...wellnessData].sort((a, b) => b.id.localeCompare(a.id));
  const current = sorted.find(w => w.ctl != null) || {};

  const ctl      = current.ctl      != null ? Math.round(current.ctl      * 10) / 10 : null;
  const atl      = current.atl      != null ? Math.round(current.atl      * 10) / 10 : null;
  // Intervals.icu uses 'form' for TSB (= CTL − ATL)
  const tsb      = current.form     != null ? Math.round(current.form     * 10) / 10
                 : (ctl != null && atl != null) ? Math.round((ctl - atl) * 10) / 10 : null;
  const rampRate = current.rampRate != null ? Math.round(current.rampRate * 10) / 10 : null;
  const dataDate = current.id || today;

  // ── 4. Build 6-week history for the CTL chart ──
  const history = wellnessData
    .filter(w => w.ctl != null)
    .map(w => ({
      date: w.id,
      ctl:  Math.round((w.ctl  || 0) * 10) / 10,
      atl:  Math.round((w.atl  || 0) * 10) / 10,
      tsb:  w.form != null ? Math.round(w.form * 10) / 10
           : Math.round(((w.ctl || 0) - (w.atl || 0)) * 10) / 10,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // ── 5. Parse running best efforts from power-curves ──
  const bestEfforts = pcData ? parsePowerCurves(pcData) : null;

  const result = {
    available: true,
    dataDate,
    ctl,
    atl,
    tsb,
    rampRate,
    history,
    bestEfforts,
  };

  // ── 6. Cache with 1-hour TTL ──
  if (kvUrl && kvToken) {
    try { await kvSetEx(kvUrl, kvToken, cacheKey, result, 3600); } catch (_) {}
  }

  return res.status(200).json({ ...result, fromCache: false });
};

/* ── Power-curves parser ─────────────────────────────────────────────────── */

/**
 * Parse Intervals.icu power-curves response into best efforts at key distances.
 * The API returns arrays indexed by duration. For running, we look for best
 * pace over standard race durations and convert to pace/distance.
 *
 * Returns array of { label, distLabel, timeSec, paceStr } or null if unparseable.
 */
function parsePowerCurves(pcData) {
  try {
    // Response may be an array of curve sets (e.g. year, all-time)
    // or a single object. Normalise to array.
    const sets = Array.isArray(pcData) ? pcData : [pcData];

    // Find the most recent / "year" curve set
    const curveSet = sets.find(s => s && (s.secs || (s.run && s.run.secs))) || sets[0];
    if (!curveSet) return null;

    // Support both top-level secs[] and nested run.secs[]
    const secsArr     = curveSet.secs       || (curveSet.run && curveSet.run.secs)     || null;
    // best_time_secs: time (seconds) to complete the distance at best pace
    // velocity: m/s (for running power curves without a power meter)
    const velArr      = curveSet.velocity   || (curveSet.run && curveSet.run.velocity) || null;

    if (!secsArr || !velArr || secsArr.length !== velArr.length) return null;

    // Build a lookup: duration (secs) → velocity (m/s)
    const lookup = {};
    for (let i = 0; i < secsArr.length; i++) {
      if (velArr[i] != null) lookup[secsArr[i]] = velArr[i];
    }

    // Key durations to check (seconds) → expected distance label
    // We pick the duration closest to an elite performance at each distance
    const targets = [
      // [approx duration bucket, distLabel, distM]
      // Use ranges of candidate durations so we find the best nearby bucket
      { label: '1 Mile',         distM: 1609.34,  candidates: [240, 270, 300, 360, 420] },
      { label: '5K',             distM: 5000,     candidates: [780, 840, 900, 960, 1080, 1200] },
      { label: '10K',            distM: 10000,    candidates: [1680, 1800, 1920, 2100, 2400] },
      { label: 'Half Marathon',  distM: 21097.5,  candidates: [3600, 3900, 4200, 4500, 5400] },
      { label: '20-min Tempo',   distM: null,     candidates: [1200] }, // fixed 20-min window
    ];

    const results = [];

    for (const t of targets) {
      // Find the candidate duration that has data and yields the best (lowest) pace
      let bestVel = null;
      let bestDur = null;
      for (const dur of t.candidates) {
        const v = lookup[dur];
        if (v && v > 0 && (bestVel === null || v > bestVel)) {
          bestVel = v;
          bestDur = dur;
        }
      }
      if (bestVel === null || bestDur === null) continue;

      // For distance-based events: compute implied time to cover the full distance
      // velocity (m/s) × time = distance → time = distance / velocity
      let timeSec, paceStr, distLabel;

      if (t.distM) {
        timeSec  = Math.round(t.distM / bestVel);
        const paceMPM = 1609.34 / bestVel / 60;
        paceStr  = fmtPace(paceMPM);
        distLabel = t.label;
      } else {
        // 20-min tempo: show distance covered
        const distM = bestVel * bestDur;
        const distMi = distM / 1609.34;
        timeSec   = bestDur;
        const paceMPM = 1609.34 / bestVel / 60;
        paceStr   = fmtPace(paceMPM);
        distLabel = `20-min (${distMi.toFixed(2)} mi)`;
      }

      results.push({
        label:     distLabel,
        timeSec,
        timeStr:   fmtTime(timeSec),
        paceStr,
      });
    }

    return results.length ? results : null;
  } catch (_) {
    return null;
  }
}

/* ── Utilities ──────────────────────────────────────────────────────────── */

function fmtPace(mpm) {
  if (!mpm) return '?:??';
  const m = Math.floor(mpm);
  const s = Math.round((mpm - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtTime(secs) {
  if (!secs) return '--:--';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ── KV helpers ─────────────────────────────────────────────────────────── */

async function kvGet(url, token, key) {
  const r    = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await r.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch (_) { return null; }
}

async function kvSetEx(url, token, key, value, ttlSeconds) {
  await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]),
  });
}
