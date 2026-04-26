#!/usr/bin/env node
'use strict';
/**
 * One-time setup: registers a Strava webhook subscription.
 *
 * Usage (run locally with Vercel env vars pulled):
 *   vercel env pull .env.local && node scripts/register-webhook.js
 *
 * Or set the three required vars directly:
 *   STRAVA_CLIENT_ID=xxx STRAVA_CLIENT_SECRET=xxx STRAVA_WEBHOOK_SECRET=xxx \
 *   node scripts/register-webhook.js
 *
 * To view existing subscriptions:
 *   node scripts/register-webhook.js --list
 *
 * To delete a subscription:
 *   node scripts/register-webhook.js --delete <id>
 */

// Parse .env.local manually — no dotenv dependency needed
try {
  const fs   = require('fs');
  const lines = fs.readFileSync('.env.local', 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
} catch (_) {}

const CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;
const WEBHOOK_SECRET = process.env.STRAVA_WEBHOOK_SECRET;
const CALLBACK_URL  = 'https://strava-chatbot.vercel.app/api/webhook';

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--list') {
    const r = await fetch(
      `https://www.strava.com/api/v3/push_subscriptions?client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`
    );
    const data = await r.json();
    console.log('Existing subscriptions:', JSON.stringify(data, null, 2));
    return;
  }

  if (args[0] === '--delete') {
    const id = args[1];
    if (!id) { console.error('Usage: --delete <subscription_id>'); process.exit(1); }
    const r = await fetch(`https://www.strava.com/api/v3/push_subscriptions/${id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET }),
    });
    console.log(r.ok ? `Deleted subscription ${id}` : `Failed: ${r.status}`);
    return;
  }

  if (!CLIENT_ID || !CLIENT_SECRET || !WEBHOOK_SECRET) {
    console.error('Required: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_WEBHOOK_SECRET');
    process.exit(1);
  }

  console.log(`Registering webhook: ${CALLBACK_URL}`);
  const r = await fetch('https://www.strava.com/api/v3/push_subscriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      callback_url:  CALLBACK_URL,
      verify_token:  WEBHOOK_SECRET,
    }),
  });

  const data = await r.json();
  if (!r.ok) { console.error('Failed:', data); process.exit(1); }
  console.log('Webhook registered! Subscription ID:', data.id);
}

main().catch(err => { console.error(err); process.exit(1); });
