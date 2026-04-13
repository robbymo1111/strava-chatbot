/**
 * GET /.netlify/functions/strava-auth-url
 * Returns the Strava OAuth authorization URL so the client_id
 * never needs to be embedded in frontend source code.
 */
exports.handler = async () => {
  const clientId = process.env.STRAVA_CLIENT_ID;

  if (!clientId) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'STRAVA_CLIENT_ID environment variable is not set.' })
    };
  }

  const redirectUri = 'https://strava-chatbot.netlify.app/callback';
  const scope       = 'activity:read_all';

  const url = new URL('https://www.strava.com/oauth/authorize');
  url.searchParams.set('client_id',     clientId);
  url.searchParams.set('redirect_uri',  redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('approval_prompt', 'auto');
  url.searchParams.set('scope',         scope);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: url.toString() })
  };
};
