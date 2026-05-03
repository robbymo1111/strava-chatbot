'use strict';

/* ── Service Worker + Post-Run Analysis ─────────────────────────────────────
   Runs in chat.html (authenticated context).
   1. Registers /sw.js for offline caching
   2. Checks for a pending post-run analysis and displays it in chat
──────────────────────────────────────────────────────────────────────────── */

(function () {
  if (!('serviceWorker' in navigator)) return;

  function getToken() {
    return sessionStorage.getItem('strava_access_token')
        || localStorage.getItem('strava_access_token');
  }

  navigator.serviceWorker.register('/sw.js', { scope: '/' })
    .then(function () {
      var token = getToken();
      if (token) checkPendingAnalysis(token);
    })
    .catch(function (err) { console.warn('[sw] Registration failed:', err); });

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

      if (firstMsg.nextSibling) el.insertBefore(msg, firstMsg.nextSibling);
      else el.appendChild(msg);
      msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setTimeout(tryInsert, 300);
  }

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
})();
