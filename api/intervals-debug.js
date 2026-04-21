/**
 * GET /api/intervals-debug
 *
 * Diagnostic endpoint — bypasses KV cache, hits Intervals.icu directly,
 * and returns full raw response + field inspection.
 *
 * NO auth required (env vars are server-side only; nothing sensitive is returned).
 * Remove or gate this endpoint once the integration is confirmed working.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const apiKey    = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;

  const env = {
    INTERVALS_API_KEY:    apiKey    ? `set (${apiKey.length} chars, starts "${apiKey.slice(0, 4)}...")` : 'MISSING',
    INTERVALS_ATHLETE_ID: athleteId ? `set ("${athleteId}")` : 'MISSING',
    KV_REST_API_URL:      process.env.KV_REST_API_URL    ? 'set' : 'missing',
    KV_REST_API_TOKEN:    process.env.KV_REST_API_TOKEN  ? 'set' : 'missing',
  };

  if (!apiKey || !athleteId) {
    return res.status(200).json({ ok: false, stage: 'env', env });
  }

  // Build auth header — Basic base64("API_KEY:" + key)
  const rawCred  = 'API_KEY:' + apiKey;
  const b64      = Buffer.from(rawCred).toString('base64');
  const headers  = { Authorization: 'Basic ' + b64, Accept: 'application/json' };
  const base     = `https://intervals.icu/api/v1/athlete/${athleteId}`;

  const today  = new Date().toISOString().split('T')[0];
  const oldest = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // last 14 days only

  // ── Test 1: athlete endpoint (cheapest auth check) ──
  let athleteResult = null;
  let athleteStatus = null;
  try {
    const r = await fetch(`${base}`, { headers });
    athleteStatus = r.status;
    if (r.ok) {
      const j = await r.json();
      athleteResult = { id: j.id, name: j.name, sports: j.sportTypes };
    } else {
      const text = await r.text().catch(() => '');
      athleteResult = { error: text.slice(0, 200) };
    }
  } catch (e) {
    athleteResult = { networkError: String(e) };
  }

  // ── Test 2: wellness endpoint (last 14 days) ──
  let wellnessStatus  = null;
  let wellnessRaw     = null;
  let wellnessFields  = null;
  let wellnessParsed  = null;
  let wellnessError   = null;

  try {
    const url = `${base}/wellness?oldest=${oldest}&newest=${today}`;
    const r   = await fetch(url, { headers });
    wellnessStatus = r.status;

    if (r.ok) {
      const data = await r.json();
      wellnessRaw = Array.isArray(data) ? data.slice(-3) : data; // last 3 days

      // Inspect field names on the most recent entry
      if (Array.isArray(data) && data.length > 0) {
        const sorted  = [...data].sort((a, b) => b.id.localeCompare(a.id));
        const latest  = sorted[0];
        wellnessFields = Object.entries(latest)
          .filter(([, v]) => v != null)
          .reduce((acc, [k, v]) => { acc[k] = v; return acc; }, {});

        // Try to extract fitness numbers using every plausible field name
        const candidates = {
          ctl: ['ctl', 'ctlLoad', 'fitnessLoad', 'fitness'],
          atl: ['atl', 'atlLoad', 'fatigueLoad', 'fatigue'],
          tsb: ['form', 'tsb', 'formLoad'],
          rampRate: ['rampRate', 'ramp', 'ctlRamp'],
        };

        wellnessParsed = {};
        for (const [metric, keys] of Object.entries(candidates)) {
          for (const k of keys) {
            if (latest[k] != null) {
              wellnessParsed[metric] = { field: k, value: latest[k] };
              break;
            }
          }
          if (!wellnessParsed[metric]) wellnessParsed[metric] = { field: null, value: null };
        }
      } else {
        wellnessError = Array.isArray(data) ? 'empty array returned' : `unexpected type: ${typeof data}`;
      }
    } else {
      const text = await r.text().catch(() => '');
      wellnessError = `HTTP ${r.status}: ${text.slice(0, 200)}`;
    }
  } catch (e) {
    wellnessError = String(e);
  }

  // ── Test 3: check what our parsing code would produce ──
  let ourParsing = null;
  if (wellnessFields) {
    const ctl = wellnessParsed?.ctl?.value;
    const atl = wellnessParsed?.atl?.value;
    const tsb = wellnessParsed?.tsb?.value ?? (ctl != null && atl != null ? ctl - atl : null);
    ourParsing = {
      ctl:      ctl != null ? Math.round(ctl * 10) / 10 : null,
      atl:      atl != null ? Math.round(atl * 10) / 10 : null,
      tsb:      tsb != null ? Math.round(tsb * 10) / 10 : null,
      rampRate: wellnessParsed?.rampRate?.value != null
        ? Math.round(wellnessParsed.rampRate.value * 10) / 10 : null,
    };
  }

  // ── Check KV cache state ──
  let kvCacheState = null;
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (kvUrl && kvToken) {
    const cacheKey = `intervals:${athleteId}:wellness:${today}`;
    try {
      const r    = await fetch(`${kvUrl}/get/${encodeURIComponent(cacheKey)}`, {
        headers: { Authorization: `Bearer ${kvToken}` },
      });
      const d = await r.json();
      if (d.result) {
        const cached = JSON.parse(d.result);
        kvCacheState = {
          exists:    true,
          available: cached.available,
          ctl:       cached.ctl,
          atl:       cached.atl,
          tsb:       cached.tsb,
          dataDate:  cached.dataDate,
        };
      } else {
        kvCacheState = { exists: false };
      }
    } catch (e) {
      kvCacheState = { error: String(e) };
    }
  } else {
    kvCacheState = { exists: false, reason: 'KV not configured' };
  }

  return res.status(200).json({
    ok:             wellnessStatus === 200,
    timestamp:      new Date().toISOString(),
    env,
    authHeader:     `Basic ${b64.slice(0, 8)}...`,
    athleteUrl:     `${base}`,
    wellnessUrl:    `${base}/wellness?oldest=${oldest}&newest=${today}`,

    athlete: { status: athleteStatus, result: athleteResult },

    wellness: {
      status:      wellnessStatus,
      error:       wellnessError,
      entryCount:  Array.isArray(wellnessRaw) ? wellnessRaw.length : null,
      last3Days:   wellnessRaw,
      fieldsSeen:  wellnessFields,
      fieldMapping: wellnessParsed,
    },

    ourParsing,
    kvCache: kvCacheState,

    target: { ctl: 32, atl: 45, tsb: -13, note: 'expected from Intervals.icu UI' },
  });
};
