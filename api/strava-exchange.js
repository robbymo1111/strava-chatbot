/**
 * POST /api/strava-exchange
 * Body: { code: string }
 * Exchanges a Strava OAuth authorization code for an access token.
 * Returns: { access_token, athlete }
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const { code } = req.body || {};

  if (!code) {
    return res.status(400).json({ error: 'Missing authorization code.' });
  }

  const clientId     = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return res.status(500).json({ error: 'Strava credentials are not configured on the server.' });
  }

  try {
    const stravaRes = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        grant_type:    'authorization_code'
      })
    });

    const data = await stravaRes.json();

    if (!stravaRes.ok || data.errors) {
      console.error('Strava token exchange error:', data);
      return res.status(400).json({ error: data.message || 'Failed to exchange authorization code with Strava.' });
    }

    // Only return what the client needs — never expose the refresh token
    return res.status(200).json({
      access_token: data.access_token,
      athlete: {
        id:             data.athlete.id,
        firstname:      data.athlete.firstname,
        lastname:       data.athlete.lastname,
        profile:        data.athlete.profile,
        profile_medium: data.athlete.profile_medium,
        city:           data.athlete.city,
        country:        data.athlete.country
      }
    });
  } catch (err) {
    console.error('Network error during token exchange:', err);
    return res.status(502).json({ error: 'Could not reach Strava. Please try again.' });
  }
};
