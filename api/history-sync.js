/**
 * POST /api/history-sync
 * Body: { accessToken, reset?: boolean }
 *
 * Fetches one page (200 activities) of the athlete's full Strava history
 * using before= timestamp pagination. The frontend calls this repeatedly
 * until complete: true.
 *
 * Storage:
 *   history:{athleteId}:meta   — sync state
 *   history:{athleteId}:page:N — 200 compressed activities per page
 *
 * Cache: complete syncs are valid for 30 days (activities don't change).
 */
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { accessToken, reset = false } = req.body || {};
  if (!accessToken) return res.status(401).json({ error: 'accessToken required' });

  const kvUrl   = process.env.KV_REST_API_URL;
  const kvToken = process.env.KV_REST_API_TOKEN;
  if (!kvUrl || !kvToken) return res.status(200).json({ error: 'KV not configured', complete: false });

  // ── Resolve athlete ID ──
  const athleteId = await resolveAthleteId(accessToken);
  if (!athleteId) return res.status(401).json({ error: 'Strava session expired' });

  const metaKey = `history:${athleteId}:meta`;

  // ── Read current meta ──
  let meta = await kvGetJSON(kvUrl, kvToken, metaKey);

  // Return immediately if already fresh (< 30 days) and not resetting
  if (!reset && meta && meta.complete) {
    const ageMs = Date.now() - (meta.finishedAt || 0);
    if (ageMs < 30 * 24 * 60 * 60 * 1000) {
      return res.status(200).json({
        complete:    true,
        fromCache:   true,
        count:       meta.count,
        pages:       meta.pages,
        oldestDate:  meta.oldestDate,
        newestDate:  meta.newestDate,
        finishedAt:  meta.finishedAt,
      });
    }

    // Cache stale — do incremental sync: fetch only new activities since newestTs
    const newestTs = meta.newestTs || 0;
    const afterParams = new URLSearchParams({ per_page: '200', after: String(newestTs) });
    let newActs = [];
    try {
      const r = await fetch(
        `https://www.strava.com/api/v3/athlete/activities?${afterParams}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
      if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit' });
      if (r.ok) newActs = await r.json();
    } catch (_) {}

    if (Array.isArray(newActs) && newActs.length > 0) {
      // Append new activities as a new page
      const compressed = newActs.map(compressActivity);
      const pageKey    = `history:${athleteId}:page:${meta.pages}`;
      await kvSetJSON(kvUrl, kvToken, pageKey, compressed);

      const timestamps = newActs.map(a =>
        Math.floor(new Date(a.start_date_local || a.start_date).getTime() / 1000)
      ).filter(Boolean);
      meta.count      += compressed.length;
      meta.pages      += 1;
      meta.newestTs    = Math.max(...timestamps);
      meta.newestDate  = new Date(meta.newestTs * 1000).toISOString().slice(0, 10);

      // Invalidate analysis cache so it gets rebuilt with new activities
      await kvPipeline(kvUrl, kvToken, [['DEL', `history:${athleteId}:analysis`]]);
    }

    meta.complete   = true;
    meta.finishedAt = Date.now();
    await kvSetJSON(kvUrl, kvToken, metaKey, meta);
    return res.status(200).json({
      complete:    true,
      incremental: true,
      added:       Array.isArray(newActs) ? newActs.length : 0,
      count:       meta.count,
      pages:       meta.pages,
      oldestDate:  meta.oldestDate,
      newestDate:  meta.newestDate,
      finishedAt:  meta.finishedAt,
    });
  }

  // Reset: wipe existing pages
  if (reset && meta && meta.pages > 0) {
    const deletes = [];
    for (let i = 0; i < meta.pages; i++) {
      deletes.push(['DEL', `history:${athleteId}:page:${i}`]);
    }
    await kvPipeline(kvUrl, kvToken, deletes);
    meta = null;
  }

  // Initialize meta for fresh sync
  if (!meta || reset) {
    meta = { v: 1, startedAt: Date.now(), finishedAt: null,
             count: 0, pages: 0, oldestTs: null, oldestDate: null,
             newestDate: null, complete: false };
  }

  // ── Fetch next page from Strava ──
  const params = new URLSearchParams({ per_page: '200' });
  if (meta.oldestTs) params.set('before', String(meta.oldestTs - 1));

  let stravaActs = [];
  try {
    const r = await fetch(
      `https://www.strava.com/api/v3/athlete/activities?${params}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    if (r.status === 401) return res.status(401).json({ error: 'Strava session expired' });
    if (r.status === 429) return res.status(429).json({ error: 'Strava rate limit' });
    if (!r.ok)            return res.status(502).json({ error: `Strava error ${r.status}` });
    stravaActs = await r.json();
  } catch (e) {
    return res.status(502).json({ error: 'Network error fetching Strava' });
  }

  if (!Array.isArray(stravaActs) || stravaActs.length === 0) {
    // No more activities — sync complete
    meta.complete   = true;
    meta.finishedAt = Date.now();
    await kvSetJSON(kvUrl, kvToken, metaKey, meta);
    return res.status(200).json({
      complete:   true,
      count:      meta.count,
      pages:      meta.pages,
      oldestDate: meta.oldestDate,
      newestDate: meta.newestDate,
    });
  }

  // Compress and store this page
  const compressed = stravaActs.map(compressActivity);
  const pageKey    = `history:${athleteId}:page:${meta.pages}`;
  await kvSetJSON(kvUrl, kvToken, pageKey, compressed);

  // Update meta
  const timestamps = stravaActs.map(a =>
    Math.floor(new Date(a.start_date_local || a.start_date).getTime() / 1000)
  ).filter(Boolean);
  const oldestInPage = Math.min(...timestamps);
  const newestInPage = Math.max(...timestamps);

  meta.count    += compressed.length;
  meta.pages    += 1;
  meta.oldestTs  = oldestInPage;
  meta.oldestDate = new Date(oldestInPage * 1000).toISOString().slice(0, 10);
  if (!meta.newestDate) {
    meta.newestTs   = newestInPage;
    meta.newestDate = new Date(newestInPage * 1000).toISOString().slice(0, 10);
  }

  // Complete if this page had fewer than 200 (last page)
  const isLastPage = stravaActs.length < 200;
  if (isLastPage) {
    meta.complete   = true;
    meta.finishedAt = Date.now();
  }

  await kvSetJSON(kvUrl, kvToken, metaKey, meta);

  return res.status(200).json({
    complete:    meta.complete,
    count:       meta.count,
    pages:       meta.pages,
    pageFetched: meta.pages - 1,
    fetched:     compressed.length,
    oldestDate:  meta.oldestDate,
    newestDate:  meta.newestDate,
  });
};

/* ── Activity compression ───────────────────────────────────────────────── */

/**
 * Trim a Strava activity to minimal fields for long-term storage.
 * Target: ~120 bytes per activity.
 */
function compressActivity(a) {
  const isRun  = /run/i.test(a.type || '');
  const distMi = +((a.distance || 0) / 1609.34).toFixed(2);
  const pace   = (isRun && a.average_speed > 0.5)
    ? +(1609.34 / a.average_speed / 60).toFixed(2)
    : null;

  return {
    id:  a.id,
    d:   (a.start_date_local || a.start_date || '').slice(0, 10),
    ty:  (a.type || 'Other').slice(0, 10),
    nm:  (a.name || '').slice(0, 60),
    mi:  distMi,
    sec: a.moving_time || 0,
    pa:  pace,
    hr:  a.average_heartrate ? Math.round(a.average_heartrate) : null,
    mhr: a.max_heartrate     ? Math.round(a.max_heartrate)     : null,
    el:  a.total_elevation_gain ? Math.round(a.total_elevation_gain * 3.28084) : 0,
    wt:  a.workout_type || 0,
    ss:  a.suffer_score  ? Math.round(a.suffer_score) : null,
  };
}

/* ── Strava athlete ID ──────────────────────────────────────────────────── */

async function resolveAthleteId(accessToken) {
  try {
    const r = await fetch('https://www.strava.com/api/v3/athlete', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!r.ok) return null;
    const a = await r.json();
    return a.id ? String(a.id) : null;
  } catch (_) { return null; }
}

/* ── KV helpers ─────────────────────────────────────────────────────────── */

async function kvGetJSON(url, token, key) {
  try {
    const r    = await fetch(`${url}/get/${encodeURIComponent(key)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const data = await r.json();
    if (!data.result) return null;
    return JSON.parse(data.result);
  } catch (_) { return null; }
}

async function kvSetJSON(url, token, key, value) {
  await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify([['SET', key, JSON.stringify(value)]]),
  }).catch(() => {});
}

async function kvPipeline(url, token, commands) {
  await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(commands),
  }).catch(() => {});
}
