/**
 * POST /.netlify/functions/strava-exchange
 * Body: { code: string }
 * Exchanges a Strava OAuth authorization code for an access token.
 * Returns: { access_token, athlete }
 */
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let code;
  try {
    ({ code } = JSON.parse(event.body));
  } catch (_) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid request body.' })
    };
  }

  if (!code) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Missing authorization code.' })
    };
  }

  const clientId     = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Strava credentials are not configured on the server.' })
    };
  }

  try {
    const res = await fetch('https://www.strava.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id:     clientId,
        client_secret: clientSecret,
        code,
        grant_type:    'authorization_code'
      })
    });

    const data = await res.json();

    if (!res.ok || data.errors) {
      console.error('Strava token exchange error:', data);
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: data.message || 'Failed to exchange authorization code with Strava.' })
      };
    }

    // Only return what the client needs — never expose the refresh token
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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
      })
    };
  } catch (err) {
    console.error('Network error during token exchange:', err);
    return {
      statusCode: 502,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Could not reach Strava. Please try again.' })
    };
  }
};
