'use strict';

/**
 * Strava OAuth — URL generation and code exchange.
 *
 * GET  /api/strava-auth
 *   → { url: string }  Strava authorization URL.
 *
 * POST /api/strava-auth
 *   Body: { code: string }
 *   → { access_token, athlete }
 *   Also saves { accessToken, refreshToken, expiresAt } to KV so the
 *   webhook handler can make authenticated Strava calls on the athlete's behalf.
 *
 * KV key: athlete:{athleteId}:tokens
 */

const { kvSet } = require('./_lib');

module.exports = async (req, res) => {
  const clientId     = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  /* ── GET: return OAuth URL ─────────────────────────────────────────────── */
  if (req.method === 'GET') {
    if (!clientId) return res.status(500).json({ error: 'STRAVA_CLIENT_ID not configured.' });

    const url = new URL('https://www.strava.com/oauth/authorize');
    url.searchParams.set('client_id',       clientId);
    url.searchParams.set('redirect_uri',    'https://strava-chatbot.vercel.app/callback');
    url.searchParams.set('response_type',   'code');
    url.searchParams.set('approval_prompt', 'force');
    url.searchParams.set('scope',           'activity:read_all,profile:read_all');

    return res.status(200).json({ url: url.toString() });
  }

  /* ── POST: exchange code for tokens ────────────────────────────────────── */
  if (req.method === 'POST') {
    const { code } = req.body || {};
    if (!code)                      return res.status(400).json({ error: 'Missing authorization code.' });
    if (!clientId || !clientSecret) return res.status(500).json({ error: 'Strava credentials not configured.' });

    let data;
    try {
      const r = await fetch('https://www.strava.com/oauth/token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' }),
      });
      data = await r.json();
      if (!r.ok || data.errors) return res.status(400).json({ error: data.message || 'Token exchange failed.' });
    } catch (_) {
      return res.status(502).json({ error: 'Could not reach Strava.' });
    }

    // Persist tokens so webhook can refresh them server-side
    const kvUrl   = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    if (kvUrl && kvToken && data.athlete?.id) {
      await kvSet(kvUrl, kvToken, `athlete:${data.athlete.id}:tokens`, {
        accessToken:  data.access_token,
        refreshToken: data.refresh_token,
        expiresAt:    data.expires_at,
      }).catch(() => {});
    }

    return res.status(200).json({
      access_token: data.access_token,
      athlete: {
        id:             data.athlete.id,
        firstname:      data.athlete.firstname,
        lastname:       data.athlete.lastname,
        profile:        data.athlete.profile,
        profile_medium: data.athlete.profile_medium,
        city:           data.athlete.city,
        country:        data.athlete.country,
      },
    });
  }

  return res.status(405).send('Method Not Allowed');
};
