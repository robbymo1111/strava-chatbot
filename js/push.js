'use strict';

/* ── Push Notification + Service Worker setup ───────────────────────────────
   Runs only in chat.html (authenticated context).
   1. Registers /sw.js
   2. Checks for a pending post-run analysis and displays it in the chat
   3. After a short delay, requests notification permission and subscribes
──────────────────────────────────────────────────────────────────────────── */

(function () {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;

  function getToken() {
    return sessionStorage.getItem('strava_access_token')
        || localStorage.getItem('strava_access_token');
  }

  /* ── Register service worker ─────────────────────────────────────────── */
  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then(function (reg) {

      var token = getToken();
      if (token) checkPendingAnalysis(token);

      // Request permission 4 s after load — less intrusive than immediate
      setTimeout(function () {
        if (!token) return;
        if (Notification.permission === 'default') {
          Notification.requestPermission().then(function (perm) {
            if (perm === 'granted') subscribeToPush(reg, token);
          });
        } else if (Notification.permission === 'granted') {
          subscribeToPush(reg, token);
        }
      }, 4000);
    })
    .catch(function (err) { console.warn('[push] SW registration failed:', err); });

  /* ── Subscribe to Web Push ───────────────────────────────────────────── */
  function subscribeToPush(reg, token) {
    fetch('/api/webhook?action=config')
      .then(function (r) { return r.json(); })
      .then(function (cfg) {
        if (!cfg.vapidPublicKey) return;

        reg.pushManager.getSubscription()
          .then(function (existing) {
            if (existing) { saveSubscription(existing, token); return; }

            return reg.pushManager.subscribe({
              userVisibleOnly:      true,
              applicationServerKey: urlBase64ToUint8Array(cfg.vapidPublicKey),
            });
          })
          .then(function (sub) {
            if (sub) saveSubscription(sub, token);
          })
          .catch(function (err) { console.warn('[push] Subscribe error:', err); });
      })
      .catch(function () {});
  }

  function saveSubscription(sub, token) {
    fetch('/api/webhook', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        action:       'save-subscription',
        accessToken:  token,
        subscription: sub.toJSON(),
      }),
    }).catch(function () {});
  }

  /* ── Check for pending post-run analysis ─────────────────────────────── */
  function checkPendingAnalysis(token) {
    fetch('/api/webhook?action=pending&accessToken=' + encodeURIComponent(token))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (data.analysis) displayAutoAnalysis(data.analysis);
      })
      .catch(function () {});
  }

  /* ── Render analysis as a coach message ──────────────────────────────── */
  function displayAutoAnalysis(analysis) {
    // Wait for the welcome message to appear, then insert after it
    function tryInsert() {
      var el       = document.getElementById('chat-messages');
      var firstMsg = el && el.querySelector('.msg--coach');
      if (!firstMsg) { setTimeout(tryInsert, 400); return; }

      var msg = document.createElement('div');
      msg.className = 'msg msg--coach msg--auto-analysis';

      var lines = (analysis.message || '').split('\n').filter(Boolean);
      msg.innerHTML =
        '<div class="msg__bubble">' +
          '<div class="auto-analysis__label">Post-Run Analysis</div>' +
          lines.map(function (l) { return '<p>' + esc(l) + '</p>'; }).join('') +
        '</div>';

      // Insert right after the welcome coach message
      if (firstMsg.nextSibling) el.insertBefore(msg, firstMsg.nextSibling);
      else el.appendChild(msg);

      // Scroll to the analysis
      msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setTimeout(tryInsert, 300);
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function urlBase64ToUint8Array(b64) {
    var padding = '='.repeat((4 - b64.length % 4) % 4);
    var base64  = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw     = atob(base64);
    var arr     = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }
})();
