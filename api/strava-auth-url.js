/**
 * GET /api/strava-auth-url
 * Returns the Strava OAuth authorization URL so the client_id
 * never needs to be embedded in frontend source code.
 */
module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  const clientId = process.env.STRAVA_CLIENT_ID;

  if (!clientId) {
    return res.status(500).json({ error: 'STRAVA_CLIENT_ID environment variable is not set.' });
  }

  const redirectUri = 'https://strava-chatbot.vercel.app/callback';
  const scope       = 'activity:read_all,profile:read_all';

  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'force');
  url.searchParams.set('scope',         scope);

  return res.status(200).json({ url: url.toString() });
};
