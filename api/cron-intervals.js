'use strict';

/**
 * GET /api/cron-intervals
 * Vercel Cron — runs every 2 hours.
 * Refreshes Intervals.icu wellness cache in KV so Brain modal loads instantly.
 *
 * Secured by Authorization: Bearer $CRON_SECRET header injected by Vercel.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const auth = req.headers.authorization || '';
    if (auth !== `Bearer ${cronSecret}`) {
      return res.status(401).send('Unauthorized');
    }
  }

  const apiKey    = process.env.INTERVALS_API_KEY;
  const athleteId = process.env.INTERVALS_ATHLETE_ID;
  if (!apiKey || !athleteId) {
    return res.status(200).json({ ok: false, reason: 'Intervals.icu not configured' });
  }

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) {
    return res.status(200).json({ ok: false, reason: 'KV not configured' });
  }

  const today   = new Date().toISOString().split('T')[0];
  const cacheKey = `intervals:${athleteId}:wellness:${today}`;
  const oldest  = new Date(Date.now() - 42 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  const auth    = Buffer.from('API_KEY:' + apiKey).toString('base64');
  const headers = { Authorization: 'Basic ' + auth, Accept: 'application/json' };
  const base    = `https://intervals.icu/api/v1/athlete/${athleteId}`;

  try {
    const [wRes, pcRes] = await Promise.all([
      fetch(`${base}/wellness?oldest=${oldest}&newest=${today}`, { headers }),
      fetch(`${base}/power-curves?type=Run&curves=year`, { headers }).catch(() => null),
    ]);

    if (!wRes.ok) {
      return res.status(200).json({ ok: false, reason: `Intervals.icu returned ${wRes.status}` });
    }

    const wellnessData = await wRes.json();
    if (!Array.isArray(wellnessData) || !wellnessData.length) {
      return res.status(200).json({ ok: false, reason: 'Empty wellness response' });
    }

    const sorted  = [...wellnessData].sort((a, b) => b.id.localeCompare(a.id));
    const current = sorted.find(w => w.ctl != null) || {};

    const ctl      = current.ctl      != null ? Math.round(current.ctl)      : null;
    const atl      = current.atl      != null ? Math.round(current.atl)      : null;
    const tsb      = current.form     != null ? Math.round(current.form)
                   : (ctl != null && atl != null) ? ctl - atl : null;
    const rampRate = current.rampRate != null ? Math.round(current.rampRate * 10) / 10 : null;
    const dataDate = current.id || today;

    const history = wellnessData
      .filter(w => w.ctl != null)
      .map(w => {
        const c = Math.round(w.ctl || 0);
        const a = Math.round(w.atl || 0);
        return { date: w.id, ctl: c, atl: a, tsb: w.form != null ? Math.round(w.form) : c - a };
      })
      .sort((a, b) => a.date.localeCompare(b.date));

    const result = { available: true, ctl, atl, tsb, rampRate, dataDate, history };

    await fetch(`${kvUrl}/set/${encodeURIComponent(cacheKey)}`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify(result),
    });

    return res.status(200).json({ ok: true, ctl, atl, tsb, rampRate, dataDate });
  } catch (err) {
    return res.status(200).json({ ok: false, reason: err.message });
  }
};
