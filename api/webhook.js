'use strict';

/**
 * Strava Webhook + Push Notification Handler
 *
 * GET  /api/webhook?hub.mode=subscribe&hub.challenge=xxx&hub.verify_token=yyy
 *      Strava one-time verification handshake.
 *
 * GET  /api/webhook?action=config
 *      Returns { vapidPublicKey } — safe to call unauthenticated.
 *
 * GET  /api/webhook?action=pending&accessToken=xxx
 *      Returns and clears the pending auto-analysis for this athlete.
 *      Called by the app on load to surface post-run analyses.
 *
 * POST /api/webhook  { action:'save-subscription', accessToken, subscription }
 *      Persists a Web Push PushSubscription to KV.
 *
 * POST /api/webhook  { object_type:'activity', aspect_type:'create', owner_id, object_id }
 *      Strava activity-created event. Responds 200 immediately, then:
 *        1. Waits 15 s for Strava to finish processing
 *        2. Fetches activity + laps
 *        3. Generates a 3-line coaching summary via Claude
 *        4. Sends push notification
 *        5. Saves as pending coach message in KV
 *
 * Required env vars
 *   STRAVA_WEBHOOK_SECRET   random string set in Vercel + passed to register-webhook script
 *   STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET   for token refresh
 *   ANTHROPIC_API_KEY
 *   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   generate with: npx web-push generate-vapid-keys
 *   KV_REST_API_URL / KV_REST_API_TOKEN
 */

const crypto = require('crypto');
const { kvGet, kvSet, fmtPace } = require('./_lib');

module.exports = async (req, res) => {
  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;

  /* ── GET ──────────────────────────────────────────────────────────────── */
  if (req.method === 'GET') {
    const { action, accessToken } = req.query;
    const mode      = req.query['hub.mode'];
    const challenge = req.query['hub.challenge'];
    const verifyTok = req.query['hub.verify_token'];

    // Strava webhook verification handshake
    if (mode === 'subscribe') {
      if (verifyTok !== process.env.STRAVA_WEBHOOK_SECRET) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      return res.status(200).json({ 'hub.challenge': challenge });
    }

    // Public config (VAPID public key for client subscription)
    if (action === 'config') {
      return res.status(200).json({ vapidPublicKey: process.env.VAPID_PUBLIC_KEY || null });
    }

    // Pending auto-analysis — one-shot: read once then delete
    if (action === 'pending') {
      if (!accessToken) return res.status(400).json({ error: 'accessToken required' });
      const athleteId = await resolveAthleteId(accessToken);
      if (!athleteId) return res.status(200).json({ analysis: null });

      const key  = `auto-analysis:${athleteId}:pending`;
      const data = await kvGet(kvUrl, kvToken, key);
      if (data) {
        await kvPipelineDel(kvUrl, kvToken, key);
      }
      return res.status(200).json({ analysis: data || null });
    }

    return res.status(200).json({ ok: true });
  }

  /* ── POST ─────────────────────────────────────────────────────────────── */
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const body = req.body || {};

  // Save push subscription
  if (body.action === 'save-subscription') {
    const { accessToken, subscription } = body;
    if (!accessToken || !subscription) return res.status(400).json({ error: 'Missing fields' });
    const athleteId = await resolveAthleteId(accessToken);
    if (!athleteId) return res.status(401).json({ error: 'Invalid token' });
    await kvSet(kvUrl, kvToken, `push:${athleteId}:subscription`, subscription);
    return res.status(200).json({ ok: true });
  }

  // Strava activity created event
  if (body.object_type === 'activity' && body.aspect_type === 'create') {
    const athleteId  = String(body.owner_id);
    const activityId = body.object_id;

    // Respond immediately — Strava requires < 5 s
    res.status(200).json({ received: true });

    // Function stays alive (Vercel waits for the returned Promise)
    await processNewRun(athleteId, activityId, kvUrl, kvToken)
      .catch(err => console.error('[webhook] processNewRun error:', err.message));
    return;
  }

  // All other Strava events (updates, deletes) — acknowledge
  return res.status(200).json({ received: true });
};

/* ── Post-run processing ──────────────────────────────────────────────────── */

async function processNewRun(athleteId, activityId, kvUrl, kvToken) {
  // Deduplication: skip if we already handled this activity
  const dedupKey = `auto-analysis:dedup:${activityId}`;
  const already  = await kvGet(kvUrl, kvToken, dedupKey);
  if (already) { console.log('[webhook] Duplicate event, skipping', activityId); return; }
  // Mark as in-flight (TTL 1 day)
  await kvSetEx(kvUrl, kvToken, dedupKey, { at: Date.now() }, 86400);

  // Load stored tokens
  const tokens = await kvGet(kvUrl, kvToken, `athlete:${athleteId}:tokens`);
  if (!tokens?.accessToken) {
    console.log('[webhook] No stored tokens for athlete', athleteId);
    return;
  }

  // Refresh if needed
  const accessToken = await getValidToken(tokens, athleteId, kvUrl, kvToken);
  if (!accessToken) { console.log('[webhook] Token refresh failed for athlete', athleteId); return; }

  // Wait for Strava to fully process the activity
  await sleep(15000);

  // Fetch activity + laps in parallel
  const [actRes, lapsRes] = await Promise.all([
    fetch(`https://www.strava.com/api/v3/activities/${activityId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
    fetch(`https://www.strava.com/api/v3/activities/${activityId}/laps`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    }),
  ]);

  if (!actRes.ok) { console.log('[webhook] Activity fetch failed:', actRes.status); return; }

  const activity = await actRes.json();
  const laps     = lapsRes.ok ? (await lapsRes.json()) : [];

  // Only process runs
  if (!/run/i.test(activity.type || '')) {
    console.log('[webhook] Not a run:', activity.type);
    return;
  }

  // Build prompt content
  const actSummary   = buildActivitySummary(activity, laps);
  const [trainSum, ouraSum] = await Promise.all([
    kvGet(kvUrl, kvToken, `training_summary:${athleteId}`),
    kvGet(kvUrl, kvToken, `oura:${athleteId}:summary:${isoDate()}`),
  ]);
  const context = buildContext(trainSum, ouraSum);

  // Generate coaching analysis
  const analysis = await generateAnalysis(actSummary, context);
  if (!analysis) { console.log('[webhook] Claude returned no analysis'); return; }

  const distMi     = activity.distance ? (activity.distance / 1609.34).toFixed(1) : '?';
  const notifTitle = `Run analyzed — ${distMi}mi`;
  const notifBody  = analysis;

  // Send push notification (if subscribed)
  const sub = await kvGet(kvUrl, kvToken, `push:${athleteId}:subscription`);
  if (sub) await sendPush(sub, notifTitle, notifBody);

  // Save as pending in-app message
  await kvSet(kvUrl, kvToken, `auto-analysis:${athleteId}:pending`, {
    title:       notifTitle,
    message:     analysis,
    activityId,
    createdAt:   Date.now(),
  });

  console.log('[webhook] Processed run', activityId, 'for athlete', athleteId);
}

/* ── Activity summary builder ─────────────────────────────────────────────── */

function buildActivitySummary(activity, laps) {
  const distMi  = activity.distance   ? (activity.distance   / 1609.34).toFixed(2) : '?';
  const timeMin = activity.moving_time ? Math.round(activity.moving_time / 60) : '?';
  const avgPace = (activity.average_speed && activity.distance)
    ? fmtPace(1609.34 / activity.average_speed / 60) : '?:??';
  const elevFt  = activity.total_elevation_gain
    ? Math.round(activity.total_elevation_gain * 3.28084) : 0;
  const avgHR   = activity.average_heartrate ? Math.round(activity.average_heartrate) : null;
  const maxHR   = activity.max_heartrate     ? Math.round(activity.max_heartrate)     : null;
  const wt      = activity.workout_type;
  const wtLabel = { 1: 'Race', 2: 'Long Run', 3: 'Workout' }[wt] || 'Run';

  const lines = [
    `Activity: "${activity.name || 'Run'}" (${wtLabel})`,
    `Distance: ${distMi} miles | Time: ${timeMin} min | Avg pace: ${avgPace}/mi`,
    `Elevation: ${elevFt} ft${avgHR ? ` | Avg HR: ${avgHR} bpm` : ''}${maxHR ? ` | Max HR: ${maxHR} bpm` : ''}`,
  ];

  if (Array.isArray(laps) && laps.length > 1 && laps.length <= 15) {
    const lapLines = laps.slice(0, 10).map((l, i) => {
      const d    = l.distance ? (l.distance / 1609.34).toFixed(2) : '?';
      const pace = l.average_speed ? fmtPace(1609.34 / l.average_speed / 60) : '?:??';
      const hr   = l.average_heartrate ? ` HR:${Math.round(l.average_heartrate)}` : '';
      return `  Lap ${i + 1}: ${d}mi @ ${pace}/mi${hr}`;
    });
    lines.push('Laps:\n' + lapLines.join('\n'));
  }

  return lines.join('\n');
}

function buildContext(trainSum, ouraSum) {
  const parts = [];
  if (trainSum?.text)   parts.push('Recent training:\n' + trainSum.text.slice(0, 600));
  if (ouraSum?.available) {
    const r = ouraSum.todayReadiness, h = ouraSum.todayHrvPct;
    if (r != null) {
      parts.push(`Recovery: readiness ${r}/100${h != null ? `, HRV ${h > 0 ? '+' : ''}${h}% vs baseline` : ''}`);
    }
  }
  return parts.join('\n\n');
}

/* ── Claude API ───────────────────────────────────────────────────────────── */

async function generateAnalysis(activitySummary, context) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const system = [
    'You are a running coach. Generate exactly 3 lines:',
    'Line 1: What happened in the workout (distance, key paces, structure if workout)',
    'Line 2: One specific coaching observation (good or needs work)',
    'Line 3: How it affects race prep / what it means for Sugarloaf or current training phase',
    'Be specific, use actual numbers. No fluff. Output ONLY the 3 lines — no labels, no numbering.',
  ].join('\n');

  const userContent = activitySummary + (context ? '\n\n' + context : '');

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 300,
        system,
        messages: [{ role: 'user', content: userContent }],
      }),
    });

    if (!r.ok) { console.error('[webhook] Claude error:', r.status); return null; }
    const d = await r.json();
    return d.content?.[0]?.text?.trim() || null;
  } catch (err) {
    console.error('[webhook] Claude exception:', err.message);
    return null;
  }
}

/* ── Push notification ────────────────────────────────────────────────────── */

function makeVapidJwt(audience) {
  const header  = Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + 43200,
    sub: 'mailto:admin@strava-chatbot.vercel.app',
  })).toString('base64url');
  const input = `${header}.${payload}`;

  const rawPub  = Buffer.from(process.env.VAPID_PUBLIC_KEY,  'base64url'); // 65 bytes uncompressed
  const rawPriv = Buffer.from(process.env.VAPID_PRIVATE_KEY, 'base64url'); // 32 bytes
  const privKey = crypto.createPrivateKey({
    key: {
      kty: 'EC', crv: 'P-256',
      x: rawPub.slice(1, 33).toString('base64url'),
      y: rawPub.slice(33, 65).toString('base64url'),
      d: rawPriv.toString('base64url'),
    },
    format: 'jwk',
  });

  const sig = crypto.sign('sha256', Buffer.from(input), { key: privKey, dsaEncoding: 'ieee-p1363' });
  return `${input}.${sig.toString('base64url')}`;
}

async function sendPush(subscription, title, body) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const endpoint   = subscription.endpoint;
    const p256dh     = subscription.keys?.p256dh;
    const auth       = subscription.keys?.auth;
    if (!p256dh || !auth) { console.log('[webhook] Subscription missing keys'); return; }

    const receiverPub    = Buffer.from(p256dh, 'base64url'); // 65-byte uncompressed
    const authSecret     = Buffer.from(auth,   'base64url'); // 16-byte

    // Ephemeral ECDH key pair
    const { privateKey: ephPriv, publicKey: ephPub } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    // SPKI DER for P-256 is 91 bytes; last 65 = 04 || x || y
    const ephPubRaw = Buffer.from(ephPub.export({ type: 'spki', format: 'der' })).slice(-65);

    // Receiver's public key as KeyObject
    const receiverPubKey = crypto.createPublicKey({
      key: {
        kty: 'EC', crv: 'P-256',
        x: receiverPub.slice(1, 33).toString('base64url'),
        y: receiverPub.slice(33, 65).toString('base64url'),
      },
      format: 'jwk',
    });

    // ECDH shared secret
    const sharedSecret = crypto.diffieHellman({ privateKey: ephPriv, publicKey: receiverPubKey });

    // RFC 8291 §3.3: IKM derivation (HKDF over ECDH secret + auth)
    const authInfo = Buffer.concat([
      Buffer.from('WebPush: info\0'),
      receiverPub,
      ephPubRaw,
    ]);
    const ikm = Buffer.from(crypto.hkdfSync('sha256', sharedSecret, authSecret, authInfo, 32));

    // RFC 8188: per-record encryption
    const salt  = crypto.randomBytes(16);
    const cek   = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

    // Plaintext = payload + 0x02 (last-record delimiter, RFC 8188)
    const plaintext = Buffer.concat([
      Buffer.from(JSON.stringify({ title, body, url: '/chat.html' })),
      Buffer.from([0x02]),
    ]);
    const cipher    = crypto.createCipheriv('aes-128-gcm', cek, nonce);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag       = cipher.getAuthTag(); // 16 bytes

    // Header: salt(16) + rs(4 BE) + idLen(1) + ephPubRaw(65)
    const hdr = Buffer.alloc(16 + 4 + 1 + ephPubRaw.length);
    salt.copy(hdr, 0);
    hdr.writeUInt32BE(4096, 16);
    hdr[20] = ephPubRaw.length;
    ephPubRaw.copy(hdr, 21);

    const encBody = Buffer.concat([hdr, encrypted, tag]);
    const jwt     = makeVapidJwt(new URL(endpoint).origin);

    const response = await fetch(endpoint, {
      method:  'POST',
      headers: {
        'Content-Type':     'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL':              '86400',
        'Authorization':    `vapid t=${jwt},k=${process.env.VAPID_PUBLIC_KEY}`,
      },
      body: encBody,
    });

    if (!response.ok) {
      if (response.status === 410 || response.status === 404) {
        console.log('[webhook] Push subscription expired/gone');
      } else {
        console.error('[webhook] Push failed:', response.status, await response.text().catch(() => ''));
      }
    }
  } catch (err) {
    console.error('[webhook] sendPush error:', err.message);
  }
}

/* ── Strava token helpers ────────────────────────────────────────────────── */

async function getValidToken(tokens, athleteId, kvUrl, kvToken) {
  const now = Math.floor(Date.now() / 1000);
  if (tokens.expiresAt > now + 120) return tokens.accessToken;

  try {
    const r = await fetch('https://www.strava.com/oauth/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        client_id:     process.env.STRAVA_CLIENT_ID,
        client_secret: process.env.STRAVA_CLIENT_SECRET,
        refresh_token: tokens.refreshToken,
        grant_type:    'refresh_token',
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    await kvSet(kvUrl, kvToken, `athlete:${athleteId}:tokens`, {
      accessToken:  d.access_token,
      refreshToken: d.refresh_token,
      expiresAt:    d.expires_at,
    });
    return d.access_token;
  } catch (_) { return null; }
}

async function resolveAthleteId(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!r.ok) return null;
    const a = await r.json();
    return a.id ? String(a.id) : null;
  } catch (_) { return null; }
}

/* ── KV helpers ──────────────────────────────────────────────────────────── */

async function kvSetEx(url, token, key, value, ttlSeconds) {
  try {
    await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]),
    });
  } catch (_) {}
}

async function kvPipelineDel(url, token, key) {
  try {
    await fetch(`${url}/pipeline`, {
      method:  'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify([['DEL', key]]),
    });
  } catch (_) {}
}

/* ── Misc ─────────────────────────────────────────────────────────────────── */

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function isoDate()  { return new Date().toISOString().split('T')[0]; }
