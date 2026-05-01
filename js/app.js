/* ── Strava Coach AI — chat frontend ── */
(function () {
  'use strict';

  /* ── Auth guard ── */
  const accessToken = sessionStorage.getItem('strava_access_token');
  if (!accessToken) {
    window.location.replace('/');
    return;
  }

  /* ── Athlete info ── */
  let athlete = {};
  try {
    athlete = JSON.parse(sessionStorage.getItem('strava_athlete') || '{}');
  } catch (_) {}

  /* ── DOM refs ── */
  const messagesEl    = document.getElementById('chat-messages');
  const inputEl       = document.getElementById('chat-input');
  const sendBtn       = document.getElementById('send-btn');
  const typingEl      = document.getElementById('typing-indicator');
  const suggestionsEl = document.getElementById('suggestions');
  const headerName    = document.getElementById('header-name');
  const headerAvatar  = document.getElementById('header-avatar');
  const logoutBtn     = document.getElementById('logout-btn');
  const memoryBtn     = document.getElementById('memory-btn');
  const memoryDot     = document.getElementById('memory-dot');
  const memoryModal   = document.getElementById('memory-modal');
  const memoryBackdrop = document.getElementById('memory-backdrop');
  const memoryClose   = document.getElementById('memory-close');
  const memoryClear   = document.getElementById('memory-clear');
  const memoryBody    = document.getElementById('memory-body');

  /* ── Populate header ── */
  if (athlete.firstname) {
    headerName.textContent = athlete.firstname.toUpperCase();
  }
  if (athlete.profile_medium || athlete.profile) {
    const img = document.createElement('img');
    img.src = athlete.profile_medium || athlete.profile;
    img.alt = athlete.firstname || 'Athlete';
    headerAvatar.innerHTML = '';
    headerAvatar.appendChild(img);
  }

  /* ── Logout ── */
  logoutBtn.addEventListener('click', function () {
    sessionStorage.clear();
    window.location.replace('/');
  });

  /* ── Memory ── */
  const MEMORY_KEY = 'coach_memory';
  const MEMORY_SECTIONS = [
    { key: 'goals',    label: 'Goals & Races'   },
    { key: 'prs',      label: 'Personal Records' },
    { key: 'injuries', label: 'Injuries & Health'},
    { key: 'notes',    label: 'Notes'            },
  ];

  function loadMemory() {
    try {
      const stored = JSON.parse(localStorage.getItem(MEMORY_KEY));
      return Object.assign(
        { goals: [], prs: [], injuries: [], notes: [], vdot: null, paces: null, raceInput: null,
          maxHR: null, longRunDay: 0, hardDays: [2, 4] },
        stored
      );
    } catch (_) {
      return { goals: [], prs: [], injuries: [], notes: [], vdot: null, paces: null, raceInput: null,
               maxHR: null, longRunDay: 0, hardDays: [2, 4] };
    }
  }

  // Write to localStorage only (no server round-trip)
  function saveMemoryLocal(mem) {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(mem));
    updateMemoryDot();
  }

  // Write locally + fire-and-forget to server
  function saveMemory(mem) {
    const stamped = Object.assign({}, mem, { _savedAt: Date.now() });
    saveMemoryLocal(stamped);
    syncMemoryToServer(stamped);
  }

  function syncMemoryToServer(mem) {
    fetch('/api/memory', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accessToken, memory: mem }),
    }).catch(() => {}); // silent — localStorage is the fallback
  }

  // On load: pull server memory in background; only overwrite local if server is newer
  (function syncFromServer() {
    fetch('/api/memory?accessToken=' + encodeURIComponent(accessToken))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.memory) return;
        const serverMem = data.memory;
        const local = loadMemory();
        const serverTs = serverMem._savedAt || 0;
        const localTs  = local._savedAt     || 0;
        // Only replace local if server has genuinely newer data
        if (serverTs > localTs) {
          saveMemoryLocal(serverMem);
          if (memoryModal.classList.contains('open')) renderMemoryModal();
        }
      })
      .catch(function() {}); // silent — localStorage fallback
  })();

  function hasMemory(mem) {
    return MEMORY_SECTIONS.some(s => (mem[s.key] || []).length > 0);
  }

  function updateMemoryDot() {
    memoryDot.hidden = !hasMemory(loadMemory());
  }

  // Strip <memory-update> block from Claude's reply, save it, return clean text
  function extractMemoryUpdate(text) {
    const match = text.match(/<memory-update>([\s\S]*?)<\/memory-update>/);
    if (!match) return text;
    try {
      const update = JSON.parse(match[1].trim());
      const current = loadMemory();
      saveMemory(Object.assign({}, current, {
        goals:    update.goals    ?? current.goals,
        prs:      update.prs      ?? current.prs,
        injuries: update.injuries ?? current.injuries,
        notes:    update.notes    ?? current.notes,
        maxHR:    update.maxHR    != null ? update.maxHR : current.maxHR,
      }));
    } catch (e) {
      console.warn('Memory parse failed', e);
    }
    return text
      .replace(/<memory-update>[\s\S]*?<\/memory-update>/g, '')
      .replace(/<session-note>[\s\S]*?<\/session-note>/g, '')
      .replace(/<memory-update>[\s\S]*/g, '')
      .replace(/<session-note>[\s\S]*/g, '')
      .trim();
  }

  // Modal open/close
  function openMemoryModal() {
    renderMemoryModal();
    memoryModal.classList.add('open');
    memoryModal.setAttribute('aria-hidden', 'false');
    fetchDashboard();  // pre-warm cache so data is ready when user switches tabs
    fetchOuraData();   // pre-warm so Recovery tab loads instantly
    updateHistoryStatusBar(); // refresh status bar with latest known sync state
  }

  function closeMemoryModal() {
    memoryModal.classList.remove('open');
    memoryModal.setAttribute('aria-hidden', 'true');
  }

  function renderMemoryModal() {
    const mem = loadMemory();
    memoryBody.innerHTML = '';

    if (!hasMemory(mem)) {
      const empty = document.createElement('p');
      empty.className = 'memory-empty';
      empty.textContent = 'Nothing saved yet. Tell your coach your PRs, goals, or injuries and it\'ll remember them.';
      memoryBody.appendChild(empty);
      return;
    }

    MEMORY_SECTIONS.forEach(({ key, label }) => {
      const items = mem[key] || [];
      if (!items.length) return;

      const section = document.createElement('div');

      const lbl = document.createElement('div');
      lbl.className = 'memory-section__label';
      lbl.textContent = label;
      section.appendChild(lbl);

      items.forEach((item, idx) => {
        const row = document.createElement('div');
        row.className = 'memory-item';

        const txt = document.createElement('span');
        txt.className = 'memory-item__text';
        txt.textContent = item;

        const del = document.createElement('button');
        del.className = 'memory-item__del';
        del.textContent = '×';
        del.setAttribute('aria-label', 'Delete');
        del.addEventListener('click', function () {
          const m = loadMemory();
          m[key].splice(idx, 1);
          saveMemory(m);
          renderMemoryModal();
        });

        row.appendChild(txt);
        row.appendChild(del);
        section.appendChild(row);
      });

      memoryBody.appendChild(section);
    });
  }

  memoryBtn.addEventListener('click', openMemoryModal);
  memoryClose.addEventListener('click', closeMemoryModal);
  memoryBackdrop.addEventListener('click', closeMemoryModal);
  memoryClear.addEventListener('click', function () {
    if (confirm('Clear all saved memory?')) {
      saveMemory({ goals: [], prs: [], injuries: [], notes: [], vdot: null, paces: null, raceInput: null,
                   shoeCategories: {}, maxHR: null, longRunDay: 0, hardDays: [2, 4] });
      renderMemoryModal();
    }
  });

  /* ── Dashboard data cache ── */
  var dashboardData      = null;
  var dashboardFetchedAt = 0;
  var dashboardError     = false;
  var dashboardFetching  = false;

  /* ── Oura Ring data cache ── */
  var ouraData      = null;
  var ouraFetchedAt = 0;
  var ouraFetching  = false;

  /* ── Log tab caches ── */
  var logNotesCache = {};  // activityId (string) → { title, notes }
  var weekDataCache  = {};  // weekKey → { notes, targetMiles }
  var lapDataCache   = {};  // activityId (string) → { laps[], pattern }

  /* ── HTML escape helpers ── */
  function hesc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function hescAttr(s) { return hesc(s); }
  function hescTa(s)   { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

  function fetchDashboard(onComplete) {
    var now = Date.now();
    if (dashboardData && now - dashboardFetchedAt < 5 * 60 * 1000) {
      if (onComplete) onComplete();
      return;
    }
    if (dashboardFetching) return; // already in flight
    dashboardFetching = true;
    dashboardError    = false;

    var mem = loadMemory();
    var qs  = '?accessToken=' + encodeURIComponent(accessToken);
    if (mem.paces && mem.paces.threshold) {
      var threshMid = (mem.paces.threshold[0] + mem.paces.threshold[1]) / 2;
      qs += '&threshPaceMin=' + threshMid.toFixed(4);
    }
    if (mem.maxHR) qs += '&maxHR=' + mem.maxHR;

    // 20-second timeout so we never spin forever
    var controller = new AbortController();
    var timeoutId  = setTimeout(function () { controller.abort(); }, 20000);

    fetch('/api/dashboard' + qs, { signal: controller.signal })
      .then(function (r) {
        clearTimeout(timeoutId);
        if (r.status === 429) { dashboardError = 'rate_limit'; return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (data) {
        dashboardFetching = false;
        if (!data) {
          if (!dashboardError) dashboardError = 'failed';
          refreshActiveTab();
          return;
        }
        dashboardData      = data;
        dashboardFetchedAt = Date.now();
        dashboardError     = false;
        refreshActiveTab();
        if (onComplete) onComplete();
      })
      .catch(function (err) {
        clearTimeout(timeoutId);
        dashboardFetching = false;
        dashboardError = err && err.name === 'AbortError' ? 'timeout' : 'failed';
        refreshActiveTab();
      });
  }

  function refreshActiveTab() {
    var active = document.querySelector('.mem-tab.active');
    if (!active) return;
    var t = active.dataset.tab;
    if      (t === 'load')     renderLoadTab();
    else if (t === 'fitness')  renderFitnessTab();
    else if (t === 'insights') renderInsightsTab();
    else if (t === 'log')      renderLogTab();
    else if (t === 'gear')     renderGearTab();
    else if (t === 'recovery') renderRecoveryTab();
  }

  function dashboardErrorHTML() {
    var msg = dashboardError === 'rate_limit'
      ? 'Strava rate limit reached. Wait a few minutes then retry.'
      : dashboardError === 'timeout'
      ? 'Request timed out — Strava may be slow right now.'
      : 'Could not load training data.';
    return '<div class="tab-empty" style="display:flex;flex-direction:column;gap:12px;align-items:center">' +
      '<span>' + msg + '</span>' +
      '<button class="log-export-btn" onclick="(function(){window._dashRetry&&window._dashRetry();})()">Retry</button>' +
    '</div>';
  }

  window._dashRetry = function () {
    dashboardError    = false;
    dashboardFetching = false;
    dashboardData     = null;
    fetchDashboard();
  };

  // Eager background fetch on load so workout card appears quickly
  fetchDashboard(function () {
    // After dashboard loads, kick off lap history sync in background
    scheduleLapSync();
    // Only auto-start lap fetch if it has never been initialized (first run).
    // Resuming an interrupted fetch is left to the user to avoid burning
    // Strava quota on every page load.
    setTimeout(scheduleHistoricalLapFetch, 8000);
    // Silently trigger analysis to ensure race-index/race-blocks exist in KV
    // (no-op if fresh and race-index already built; only rebuilds when missing)
    setTimeout(function () {
      fetch('/api/history-analysis', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accessToken: accessToken }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (!data) return;
          if (data.text && !data.notReady) {
            // Analysis succeeded — populate localStorage so Insights renders instantly
            if (!loadInsightsLocally()) {
              saveInsightsLocally(data);
              window._insightsData = data;
              insightsSyncState    = 'done';
            }
          } else if (data.notReady && data.stale) {
            // History pages are stale — kick off one incremental sync page
            // so the analysis can rebuild with fresh data
            fetch('/api/history-sync', {
              method:  'POST',
              headers: { 'Content-Type': 'application/json' },
              body:    JSON.stringify({ accessToken: accessToken }),
            }).catch(function () {});
          }
        })
        .catch(function () {});
    }, 6000);
  });

  /* ── Tab switching ── */
  document.querySelectorAll('.mem-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.mem-tab').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.mem-tab-panel').forEach(function (p) { p.hidden = true; });
      btn.classList.add('active');
      var panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) {
        panel.hidden = false;
        panel.scrollTop = 0; // reset scroll on tab switch
      }

      var tab = btn.dataset.tab;
      if (tab === 'load')     { renderLoadTab();     fetchDashboard(); }
      if (tab === 'fitness')  { renderFitnessTab();  fetchDashboard(); }
      if (tab === 'insights') { renderInsightsTab(); }
      if (tab === 'log')      { renderLogTab();      fetchDashboard(); }
      if (tab === 'gear')     { renderGearTab();     fetchDashboard(); }
      if (tab === 'recovery') { renderRecoveryTab(); fetchOuraData(); }
    });
  });

  updateMemoryDot();

  /* ── Load previous chat sessions in background ── */
  setTimeout(loadChatHistory, 200);

  /* ── Auto-grow textarea ── */
  inputEl.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    sendBtn.disabled = this.value.trim().length === 0;
  });

  inputEl.addEventListener('keydown', function (e) {
    // Send on Enter (not Shift+Enter)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendMessage();
    }
  });

  sendBtn.addEventListener('click', sendMessage);

  /* ── Suggestion chips ── */
  suggestionsEl.addEventListener('click', function (e) {
    const chip = e.target.closest('.suggestion-chip');
    if (!chip) return;
    inputEl.value = chip.dataset.q;
    inputEl.dispatchEvent(new Event('input'));
    sendMessage();
  });

  /* ── Core send logic ── */
  let isLoading = false;
  const history = []; // { role: 'user'|'assistant', content: string }[]

  // Phrases that trigger a local lap-fetch action instead of hitting the chat API
  var LAP_FETCH_TRIGGERS = [
    'fetch lap', 'pull lap', 'sync lap', 'get lap data', 'load lap',
    'fetch workout detail', 'pull workout detail', 'sync workout detail',
    'fetch historical', 'pull historical', 'sync historical',
    'fetch my history', 'pull my history', 'sync my history',
    'fetch old', 'pull old run', 'get old workout',
  ];

  async function sendMessage() {
    if (isLoading) return;
    const text = inputEl.value.trim();
    if (!text) return;

    // Clear input
    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;

    // Hide suggestions after first real question
    suggestionsEl.style.display = 'none';

    // Show user bubble
    appendUserMessage(text);

    // Handle lap-fetch requests locally — no need to hit the chat API
    var lowerText = text.toLowerCase();
    if (LAP_FETCH_TRIGGERS.some(function(p) { return lowerText.includes(p); })) {
      var isRunning = _lapFetchRunning;
      var msg = isRunning
        ? 'Already fetching workout details — check the Workout Details section in the Insights tab for progress.'
        : 'Starting historical lap data fetch for all quality sessions (pace < 8:00/mi). ' +
          'This runs in the background and may take a few minutes. ' +
          'You can track progress in the Insights tab under "Workout Details".';
      appendBotMessage(msg, false);
      if (!isRunning) startLapFetch(false);
      return;
    }

    // Add to history
    history.push({ role: 'user', content: text });

    // Show typing
    isLoading = true;
    typingEl.classList.add('visible');
    scrollToBottom();

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: history.slice(-8),
          accessToken,
          memory: loadMemory()
        })
      });

      typingEl.classList.remove('visible');

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const errMsg = body.error || `Server error (${res.status}). Please try again.`;
        appendBotMessage('Sorry, ' + errMsg, true);
        // Remove the failed user message from history
        history.pop();
        return;
      }

      const data = await res.json();
      const reply = extractMemoryUpdate(data.reply || '(No response)');

      history.push({ role: 'assistant', content: reply });
      if (data.weeklyBalance) renderBalanceCard(data.weeklyBalance);
      if (data.trainingLoad && isTrainingLoadQuery(text)) renderTrainingLoadCard(data.trainingLoad);
      appendBotMessage(reply);

    } catch (err) {
      console.error(err);
      typingEl.classList.remove('visible');
      appendBotMessage('Sorry, I couldn\'t reach the server. Check your connection and try again.', true);
      history.pop();
    } finally {
      isLoading = false;
    }
  }

  /* ── Message rendering ── */
  function appendUserMessage(text) {
    var msg = document.createElement('div');
    msg.className = 'msg msg--user';

    var meta = document.createElement('div');
    meta.className = 'msg__meta';
    meta.innerHTML =
      '<span class="msg__sender msg__sender--user">You</span>' +
      '<span class="msg__time">' + formatTime(new Date()) + '</span>';

    var content = document.createElement('div');
    content.className = 'msg__content';
    content.textContent = text;

    msg.appendChild(meta);
    msg.appendChild(content);
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  function appendBotMessage(text, isError) {
    var msg = document.createElement('div');
    msg.className = 'msg msg--coach';
    if (isError) msg.style.borderLeft = '2px solid #f87171';

    var meta = document.createElement('div');
    meta.className = 'msg__meta';
    meta.innerHTML =
      '<span class="msg__sender msg__sender--coach">COACH</span>' +
      '<span class="msg__time">' + formatTime(new Date()) + '</span>';

    var content = document.createElement('div');
    content.className = 'msg__content md-content';
    content.innerHTML = renderMarkdown(text);

    msg.appendChild(meta);
    msg.appendChild(content);
    messagesEl.appendChild(msg);
    requestAnimationFrame(function() {
      msg.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  /* ── Chat history (previous sessions) ────────────────────────────────── */

  function loadChatHistory() {
    var todayDiv = messagesEl.querySelector('.date-divider');
    if (todayDiv) todayDiv.textContent = histDividerLabel(new Date(), true);

    var loader = document.createElement('div');
    loader.id = 'hist-loader';
    loader.className = 'hist-loader';
    loader.textContent = 'loading history…';
    if (todayDiv) messagesEl.insertBefore(loader, todayDiv);

    fetch('/api/memory?type=chat-messages&accessToken=' + encodeURIComponent(accessToken))
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        var l = document.getElementById('hist-loader');
        if (l) l.remove();
        if (!data || !Array.isArray(data.sessions) || !data.sessions.length) return;
        renderChatHistory(data.sessions);
      })
      .catch(function() {
        var l = document.getElementById('hist-loader');
        if (l) l.remove();
      });
  }

  function renderChatHistory(sessions) {
    var todayDiv = messagesEl.querySelector('.date-divider');
    if (!todayDiv) return;

    // Last 2 sessions expanded; anything older collapsed behind a button
    var expanded  = sessions.slice(-2);
    var collapsed = sessions.slice(0, -2);
    var frag = document.createDocumentFragment();

    if (collapsed.length > 0) {
      var colGroup = document.createElement('div');
      colGroup.id = 'hist-collapsed';
      colGroup.hidden = true;
      collapsed.forEach(function(s) {
        colGroup.appendChild(histMakeDivider(s.date));
        (s.messages || []).forEach(function(m) { colGroup.appendChild(histMakeMsg(m)); });
      });
      frag.appendChild(colGroup);

      var showWrap = document.createElement('div');
      showWrap.className = 'hist-show-earlier';
      var showBtn = document.createElement('button');
      showBtn.className = 'hist-show-earlier__btn';
      showBtn.textContent = 'Show ' + collapsed.length + ' earlier session' + (collapsed.length !== 1 ? 's' : '');
      showBtn.addEventListener('click', function() {
        document.getElementById('hist-collapsed').hidden = false;
        showWrap.remove();
      });
      showWrap.appendChild(showBtn);
      frag.appendChild(showWrap);
    }

    expanded.forEach(function(s) {
      frag.appendChild(histMakeDivider(s.date));
      (s.messages || []).forEach(function(m) { frag.appendChild(histMakeMsg(m)); });
    });

    messagesEl.insertBefore(frag, todayDiv);

    requestAnimationFrame(function() {
      todayDiv.scrollIntoView({ block: 'start' });
    });
  }

  function histMakeDivider(dateStr) {
    var el = document.createElement('div');
    el.className = 'date-divider';
    el.textContent = histDividerLabel(dateStr, false);
    return el;
  }

  function histDividerLabel(dateOrStr, isToday) {
    var d;
    if (typeof dateOrStr === 'string') {
      var p = dateOrStr.split('-');
      d = p.length === 3 ? new Date(+p[0], +p[1] - 1, +p[2]) : new Date(dateOrStr);
    } else {
      d = dateOrStr;
    }
    var days   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
    var months = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
    var label = '── ' + days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate();
    if (isToday) label += ' (today)';
    return label + ' ──';
  }

  function histMakeMsg(msg) {
    var isUser = msg.role === 'user';
    var el = document.createElement('div');
    el.className = 'msg ' + (isUser ? 'msg--user' : 'msg--coach') + ' msg--history';

    var meta = document.createElement('div');
    meta.className = 'msg__meta';
    var timeStr = '';
    if (msg.ts) {
      try { timeStr = formatTime(new Date(msg.ts)); } catch(_) {}
    }
    meta.innerHTML = isUser
      ? '<span class="msg__sender msg__sender--user">You</span>'   + (timeStr ? '<span class="msg__time">' + timeStr + '</span>' : '')
      : '<span class="msg__sender msg__sender--coach">COACH</span>' + (timeStr ? '<span class="msg__time">' + timeStr + '</span>' : '');

    var content = document.createElement('div');
    content.className = isUser ? 'msg__content' : 'msg__content md-content';
    if (isUser) {
      content.textContent = msg.content || '';
    } else {
      content.innerHTML = renderMarkdown(msg.content || '');
    }

    el.appendChild(meta);
    el.appendChild(content);
    return el;
  }

  /* ── Brain tab renderers ── */

  function fmtDuration(minutes) {
    if (!minutes) return '0m';
    var h = Math.floor(minutes / 60);
    var m = Math.round(minutes % 60);
    return h > 0 ? h + 'h' + (m ? ' ' + m + 'm' : '') : m + 'm';
  }

  function fmtPaceStr(minPerMile) {
    var m = Math.floor(minPerMile);
    var s = Math.round((minPerMile - m) * 60);
    return m + ':' + String(s).padStart(2, '0');
  }

  var CLS_TAG = {
    'Easy Run': 'easy', 'Long Run': 'long', 'Tempo Run': 'tempo',
    'Workout': 'workout', 'Recovery Run': 'recovery', 'Race': 'race',
  };

  // ── Training Load ───────────────────────────────────────────────────────
  function renderLoadTab() {
    var el = document.getElementById('tab-load-content');
    if (!el) return;
    if (dashboardError) { el.innerHTML = dashboardErrorHTML(); return; }
    if (!dashboardData || !dashboardData.trainingLoad) {
      el.innerHTML = '<div class="tab-loading">Loading…</div>'; return;
    }

    var load = dashboardData.trainingLoad;
    var risk = dashboardData.injuryRisk || { level: 'LOW', reason: 'Training load is manageable' };

    var ctl = load.ctl, atl = load.atl, tsb = load.tsb;
    var tsbLabel, tsbColor;
    if      (tsb >  10) { tsbLabel = 'Fresh';      tsbColor = '#60a5fa'; }
    else if (tsb >= -10) { tsbLabel = 'Optimal';   tsbColor = '#4ade80'; }
    else if (tsb >= -20) { tsbLabel = 'Productive'; tsbColor = '#fb923c'; }
    else                 { tsbLabel = 'Fatigued';   tsbColor = '#f87171'; }

    var riskColor = risk.level === 'HIGH' ? '#f87171' : risk.level === 'MODERATE' ? '#fb923c' : '#4ade80';

    var sourceBadge = (load.source === 'intervals.icu')
      ? '<span class="fitness-source-badge fitness-source-badge--real">Intervals.icu</span>'
      : '<span class="fitness-source-badge fitness-source-badge--est">estimated</span>';

    var rampRow = (load.rampRate != null)
      ? (function() {
          var rr = load.rampRate;
          var rrSign  = rr > 0 ? '+' : '';
          var rrColor = Math.abs(rr) > 5 ? '#f87171' : Math.abs(rr) > 3 ? '#fb923c' : '#4ade80';
          var rrNote  = rr > 5 ? ' \u26a0\ufe0f aggressive' : rr > 3 ? ' moderate' : rr < -3 ? ' tapering' : ' sustainable';
          return '<div class="fitness-ramp-row" style="margin:8px 0 4px">' +
            '<span class="fitness-ramp-label">Ramp rate</span>' +
            '<span class="fitness-ramp-value" style="color:' + rrColor + '">' + rrSign + rr + ' CTL/wk' + rrNote + '</span>' +
          '</div>';
        })()
      : '';

    el.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:2px">' +
        '<span class="tab-section-label" style="margin:0">Performance Management Chart</span>' +
        sourceBadge +
      '</div>' +
      '<div class="tl-metrics">' +
        '<div class="tl-metric"><span class="tl-metric__label">CTL</span><span class="tl-metric__value tl-metric__value--ctl">' + Math.round(ctl) + '</span><span class="tl-metric__sub">Fitness</span></div>' +
        '<div class="tl-metric"><span class="tl-metric__label">ATL</span><span class="tl-metric__value tl-metric__value--atl">' + Math.round(atl) + '</span><span class="tl-metric__sub">Fatigue</span></div>' +
        '<div class="tl-metric"><span class="tl-metric__label">TSB</span><span class="tl-metric__value" style="color:' + tsbColor + '">' + (tsb > 0 ? '+' : '') + Math.round(tsb) + '</span><span class="tl-metric__sub" style="color:' + tsbColor + '">' + tsbLabel + '</span></div>' +
      '</div>' +
      rampRow +
      '<div class="tl-chart">' + buildLoadChart(load.history) + '</div>' +
      '<div class="tl-legend"><span class="tl-legend__item tl-legend__ctl">\u25cf CTL</span><span class="tl-legend__item tl-legend__atl">\u25cf ATL</span><span class="tl-legend__item tl-legend__tsb">\u25cf TSB</span></div>' +
      '<div class="tab-section-label">Injury Risk</div>' +
      '<div class="tab-risk-row">' +
        '<span class="tab-risk__level" style="color:' + riskColor + '">' + risk.level + '</span>' +
        '<span class="tab-risk__reason">' + risk.reason + '</span>' +
      '</div>';
  }

  // ── Fitness ─────────────────────────────────────────────────────────────
  function renderFitnessTab() {
    var el = document.getElementById('tab-fitness-content');
    if (!el) return;

    var mem = loadMemory();

    // Optional VDOT badge \u2014 only shown if user had previously set one
    var headerHTML = '';
    if (mem.vdot) {
      var runCount  = dashboardData ? (dashboardData.weeklyStats.runCount || 0) : 0;
      var confLevel = runCount >= 5 ? 'HIGH' : runCount >= 2 ? 'MEDIUM' : 'LOW';
      var confColor = confLevel === 'HIGH' ? '#4ade80' : confLevel === 'MEDIUM' ? '#fb923c' : '#f87171';
      var source    = mem.raceInput
        ? 'VDOT\u00a0' + mem.vdot.toFixed(1) + '\u00a0\u00b7\u00a0from\u00a0' + mem.raceInput.distLabel
        : 'VDOT\u00a0' + mem.vdot.toFixed(1);
      headerHTML =
        '<div class="tab-vdot-badge">' + source + '</div>' +
        '<div class="tab-conf-row">Confidence <span style="color:' + confColor + ';font-weight:700">' + confLevel + '</span></div>';
    }

    // Trend
    var trendHTML = '';
    if (dashboardData && dashboardData.fitnessTrend) {
      var tr = dashboardData.fitnessTrend;
      var arrow = tr.direction === 'improving' ? '\u2191' : tr.direction === 'declining' ? '\u2193' : '\u2192';
      var trendCls = 'tab-trend--' + (tr.direction === 'improving' ? 'up' : tr.direction === 'declining' ? 'down' : 'flat');
      trendHTML =
        '<div class="vdot-section-label" style="margin-top:14px">Trend vs 4 Weeks Ago</div>' +
        '<div class="tab-trend ' + trendCls + '">' + arrow + '\u00a0' +
          (tr.direction === 'stable' ? 'Stable' : tr.direction === 'improving' ? 'Improving' : 'Slowing') +
          ' \u2014 avg pace ' + fmtPaceStr(tr.recentPace) + ' vs ' + fmtPaceStr(tr.priorPace) + '/mi' +
        '</div>';
    }

    el.innerHTML = headerHTML + trendHTML;

    // ── Training Load (PMC) from Intervals.icu or estimated ──────────────
    var load = dashboardData && dashboardData.trainingLoad;
    if (load && load.ctl != null) {
      var isReal     = load.source === 'intervals.icu';
      var sourceBadge = isReal
        ? '<span class="fitness-source-badge fitness-source-badge--real">Intervals.icu</span>'
        : '<span class="fitness-source-badge fitness-source-badge--est">estimated</span>';

      var tsb     = load.tsb || 0;
      var tsbSign = tsb > 0 ? '+' : '';
      var tsbColor = tsb > 5 ? '#4ade80' : tsb > -10 ? '#facc15' : tsb > -20 ? '#fb923c' : '#f87171';
      var tsbLabel = tsb > 10 ? 'Fresh' : tsb > -10 ? 'Optimal' : tsb > -20 ? 'Stressed' : 'Fatigued';

      var rampHTML = '';
      if (load.rampRate != null) {
        var rr = load.rampRate;
        var rrSign  = rr > 0 ? '+' : '';
        var rrColor = Math.abs(rr) > 5 ? '#f87171' : Math.abs(rr) > 3 ? '#fb923c' : '#4ade80';
        var rrLabel = rr > 5 ? ' \u26a0\ufe0f too fast' : rr > 3 ? ' moderate' : rr < -3 ? ' tapering' : ' sustainable';
        rampHTML = '<div class="fitness-ramp-row">' +
          '<span class="fitness-ramp-label">Ramp Rate</span>' +
          '<span class="fitness-ramp-value" style="color:' + rrColor + '">' + rrSign + rr + ' CTL/wk' + rrLabel + '</span>' +
        '</div>';
      }

      el.innerHTML +=
        '<div class="vdot-section-label" style="margin-top:18px">Training Load (PMC) ' + sourceBadge + '</div>' +
        '<div class="fitness-pmc-row">' +
          '<div class="fitness-pmc-metric">' +
            '<span class="fitness-pmc-val">' + Math.round(load.ctl) + '</span>' +
            '<span class="fitness-pmc-lbl">CTL · Fitness</span>' +
          '</div>' +
          '<div class="fitness-pmc-metric">' +
            '<span class="fitness-pmc-val">' + Math.round(load.atl) + '</span>' +
            '<span class="fitness-pmc-lbl">ATL · Fatigue</span>' +
          '</div>' +
          '<div class="fitness-pmc-metric">' +
            '<span class="fitness-pmc-val" style="color:' + tsbColor + '">' + tsbSign + Math.round(tsb) + '</span>' +
            '<span class="fitness-pmc-lbl" style="color:' + tsbColor + '">TSB · ' + tsbLabel + '</span>' +
          '</div>' +
        '</div>' +
        rampHTML;

      // 6-week CTL trend mini-chart
      if (load.history && load.history.length >= 7) {
        el.innerHTML += renderCTLMiniChart(load.history);
      }
    }

    // ── Best Efforts from Intervals.icu ──────────────────────────────────
    var be = dashboardData && dashboardData.bestEfforts;
    if (be && be.length) {
      var beHTML = '<div class="vdot-section-label" style="margin-top:18px">Best Efforts ' +
        '<span class="fitness-source-badge fitness-source-badge--real">Intervals.icu</span></div>' +
        '<div class="vdot-paces">';
      be.forEach(function(e) {
        beHTML +=
          '<div class="vdot-pace-row">' +
            '<span class="vdot-pace-label">' + e.label + '</span>' +
            '<span class="vdot-pace-value">' + e.timeStr +
              ' <span class="vdot-pace-sub">(' + e.paceStr + '/mi)</span></span>' +
          '</div>';
      });
      beHTML += '</div>';
      el.innerHTML += beHTML;
    }

    // HR Drift section
    var driftData = dashboardData && dashboardData.hrDriftTrend;
    if (driftData && driftData.length) {
      var driftHTML = '<div class="vdot-section-label" style="margin-top:18px">Cardiac Drift \u00b7 Long Runs</div>';
      driftData.forEach(function(run) {
        var color = run.flag ? (run.driftPct > 8 ? '#f87171' : '#fb923c') : '#4ade80';
        var sign  = run.driftPct > 0 ? '+' : '';
        var barW  = Math.min(100, Math.abs(run.driftPct) * 10);
        driftHTML +=
          '<div class="drift-row">' +
            '<div class="drift-row__meta">' +
              '<span class="drift-row__name">' + run.name + ' (' + run.distMi + 'mi)</span>' +
              '<span class="drift-row__date">' + run.date + '</span>' +
            '</div>' +
            '<div class="drift-row__bar-wrap"><div class="drift-row__bar" style="width:' + barW + '%;background:' + color + '"></div></div>' +
            '<span class="drift-row__value" style="color:' + color + '">' + sign + run.driftPct + '%</span>' +
          '</div>';
      });
      var flagged = driftData.filter(function(r) { return r.flag; }).length;
      if (flagged) {
        driftHTML += '<div class="tab-warning" style="margin-top:6px">\u26a0\ufe0f ' + flagged + ' long run' + (flagged > 1 ? 's' : '') + ' showed >5% cardiac drift — possible dehydration or aerobic base gap</div>';
      } else {
        driftHTML += '<div class="tab-rec" style="margin-top:6px">Cardiac drift under 5% — aerobic efficiency is solid.</div>';
      }
      el.innerHTML += driftHTML;
    } else if (dashboardData) {
      el.innerHTML += '<div class="vdot-section-label" style="margin-top:18px">Cardiac Drift</div>' +
        '<div class="tab-empty" style="padding:10px 0">No long runs (\u226560 min) found in the last 6 weeks.</div>';
    }
  }

  /**
   * Render a small SVG sparkline of CTL (and ATL) over the past 6 weeks.
   */
  function renderCTLMiniChart(history) {
    var W = 260, H = 56, PAD = 4;
    var pts  = history.slice(-42); // up to 6 weeks
    var ctls = pts.map(function(p) { return p.ctl; });
    var atls = pts.map(function(p) { return p.atl; });
    var all  = ctls.concat(atls);
    var minV = Math.min.apply(null, all);
    var maxV = Math.max.apply(null, all);
    var range = maxV - minV || 1;

    function toX(i) { return PAD + (i / (pts.length - 1)) * (W - PAD * 2); }
    function toY(v) { return H - PAD - ((v - minV) / range) * (H - PAD * 2); }

    function polyline(arr, color) {
      var d = arr.map(function(v, i) { return toX(i) + ',' + toY(v); }).join(' ');
      return '<polyline points="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linejoin="round"/>';
    }

    // Tick marks for weeks
    var weekTicks = '';
    for (var i = 0; i < pts.length; i += 7) {
      var x = toX(i);
      weekTicks += '<line x1="' + x + '" y1="' + (H - PAD) + '" x2="' + x + '" y2="' + (H - PAD + 3) + '" stroke="#4b5563" stroke-width="1"/>';
    }

    return '<div style="margin-top:8px;overflow:hidden">' +
      '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;width:100%;height:auto">' +
        '<rect width="' + W + '" height="' + H + '" fill="#111827" rx="4"/>' +
        weekTicks +
        polyline(atls, '#f87171') +
        polyline(ctls, '#60a5fa') +
        // latest value dots
        '<circle cx="' + toX(pts.length - 1) + '" cy="' + toY(ctls[ctls.length - 1]) + '" r="2.5" fill="#60a5fa"/>' +
        '<circle cx="' + toX(pts.length - 1) + '" cy="' + toY(atls[atls.length - 1]) + '" r="2.5" fill="#f87171"/>' +
      '</svg>' +
      '<div style="display:flex;gap:12px;margin-top:4px;font-size:10px;color:#9ca3af">' +
        '<span><span style="color:#60a5fa">\u25cf</span> CTL</span>' +
        '<span><span style="color:#f87171">\u25cf</span> ATL</span>' +
        '<span style="margin-left:auto;font-size:9px">6 weeks</span>' +
      '</div>' +
    '</div>';
  }

  // ── Insights (historical intelligence) ──────────────────────────────────

  var INSIGHTS_LS_KEY  = 'insights_analysis_v2'; // bumped: forces rebuild to populate race-index in KV
  var INSIGHTS_MAX_AGE = 30 * 24 * 60 * 60 * 1000; // 30 days

  var insightsSyncState = null; // null | 'syncing' | 'analyzing' | 'done' | 'error'
  var insightsSyncCount = 0;

  function saveInsightsLocally(data) {
    try {
      localStorage.setItem(INSIGHTS_LS_KEY, JSON.stringify({
        data:      data,
        savedAt:   Date.now(),
      }));
    } catch (_) {} // ignore if localStorage full
  }

  function loadInsightsLocally() {
    try {
      var raw = localStorage.getItem(INSIGHTS_LS_KEY);
      if (!raw) return null;
      var stored = JSON.parse(raw);
      if (!stored || !stored.data || !stored.data.text) return null;
      if (Date.now() - (stored.savedAt || 0) > INSIGHTS_MAX_AGE) return null;
      return stored.data;
    } catch (_) { return null; }
  }

  function clearInsightsLocally() {
    try { localStorage.removeItem(INSIGHTS_LS_KEY); } catch (_) {}
  }

  function renderInsightsTab() {
    var el = document.getElementById('tab-insights-content');
    if (!el) return;

    // Already loaded this session — render instantly
    if (insightsSyncState === 'done' && window._insightsData) {
      renderInsightsData(el, window._insightsData);
      return;
    }

    // Sync already running
    if (insightsSyncState === 'syncing' || insightsSyncState === 'analyzing') {
      el.innerHTML = buildSyncProgressHTML();
      return;
    }

    // Check localStorage first — render instantly if fresh
    var cached = loadInsightsLocally();
    if (cached) {
      insightsSyncState    = 'done';
      window._insightsData = cached;
      renderInsightsData(el, cached);
      return;
    }

    // Nothing cached — check server
    el.innerHTML = '<div class="tab-loading">Checking training history…</div>';

    fetch('/api/history-analysis', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accessToken: accessToken }),
    })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && data.text && !data.notReady) {
          insightsSyncState    = 'done';
          window._insightsData = data;
          saveInsightsLocally(data);
          renderInsightsData(el, data);
        } else {
          startHistorySync(el);
        }
      })
      .catch(function() { startHistorySync(el); });
  }

  function startHistorySync(el) {
    insightsSyncState = 'syncing';
    insightsSyncCount = 0;
    el.innerHTML = buildSyncProgressHTML();
    runSyncPage(el);
  }

  function runSyncPage(el) {
    fetch('/api/history-sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accessToken: accessToken }),
    })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) {
          insightsSyncState = 'error';
          if (el) el.innerHTML = '<div class="tab-empty">Sync failed — tap to retry.<br><button class="log-export-btn" style="margin-top:8px" onclick="window._insightsRetry&&window._insightsRetry()">Retry</button></div>';
          return;
        }
        insightsSyncCount = data.count || insightsSyncCount;
        if (el) el.innerHTML = buildSyncProgressHTML(data);

        if (data.complete) {
          // Update status bar with count from sync response
          if (data.count || data.finishedAt) {
            updateHistoryStatusBar({ count: data.count, finishedAt: data.finishedAt });
          }
          // All pages fetched — now build analysis
          insightsSyncState = 'analyzing';
          if (el) el.innerHTML = buildSyncProgressHTML(data, true);
          runAnalysis(el, data);
        } else {
          // Next page (100ms delay to be polite)
          setTimeout(function() { runSyncPage(el); }, 100);
        }
      })
      .catch(function() {
        insightsSyncState = 'error';
        if (el) el.innerHTML = '<div class="tab-empty">Network error during sync.</div>';
      });
  }

  function runAnalysis(el, syncData) {
    fetch('/api/history-analysis', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accessToken: accessToken }),
    })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (data && !data.error && !data.notReady) {
          insightsSyncState    = 'done';
          window._insightsData = data;
          saveInsightsLocally(data);
          var liveEl = document.getElementById('tab-insights-content');
          if (liveEl) renderInsightsData(liveEl, data);
          // History sync just completed — auto-start historical lap fetch so
          // the coach can see workout details for old training blocks
          setTimeout(scheduleHistoricalLapFetch, 1000);
        } else {
          if (el) el.innerHTML = '<div class="tab-empty">Analysis failed. ' + (data && data.error ? data.error : '') + '</div>';
        }
      })
      .catch(function() {
        if (el) el.innerHTML = '<div class="tab-empty">Analysis error.</div>';
      });
  }

  window._insightsRetry = function() {
    insightsSyncState = null;
    insightsSyncCount = 0;
    window._insightsData = null;
    var el = document.getElementById('tab-insights-content');
    if (el) { el.innerHTML = '<div class="tab-loading">Loading…</div>'; renderInsightsTab(); }
  };

  window._insightsReset = function() {
    insightsSyncState = 'syncing';
    insightsSyncCount = 0;
    window._insightsData = null;
    clearInsightsLocally();
    var el = document.getElementById('tab-insights-content');
    if (!el) return;
    el.innerHTML = buildSyncProgressHTML();
    fetch('/api/history-sync', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ accessToken: accessToken, reset: true }),
    })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function() { runSyncPage(el); });
  };

  function buildSyncProgressHTML(data, analyzing) {
    var count = (data && data.count) || insightsSyncCount;
    var oldest = data && data.oldestDate ? ' back to ' + data.oldestDate : '';
    var msg = analyzing
      ? 'Building training intelligence…'
      : 'Loading training history… ' + count + ' activities' + oldest;
    var pct = analyzing ? 95 : Math.min(90, count > 0 ? Math.min(90, (count / 1000) * 90) : 10);
    return '<div class="insights-sync-wrap">' +
      '<div class="insights-sync-label">' + msg + '</div>' +
      '<div class="insights-progress-track"><div class="insights-progress-bar" style="width:' + pct + '%"></div></div>' +
      '<div class="insights-sync-sub">First sync may take a moment — results are cached for 30 days.</div>' +
    '</div>';
  }

  function renderInsightsData(el, data) {
    var meta   = data.meta   || {};
    var races  = data.races  || [];
    var eff    = data.efficiency || [];
    var mi     = data.mileage   || {};
    var pats   = data.patterns  || null;

    // Update global status bar with count and sync date from analysis metadata
    if (meta.totalActivities || data.builtAt) {
      updateHistoryStatusBar({ count: meta.totalActivities, finishedAt: data.builtAt });
    }

    var html = '';

    // ── Header summary ──
    var since = meta.oldestDate || '?';
    var newest = meta.newestDate ? meta.newestDate.slice(0, 7) : '';
    html += '<div class="insights-header">' +
      '<span class="insights-stat">' + (meta.totalActivities || 0) + ' activities</span>' +
      '<span class="insights-sep">\u00b7</span>' +
      '<span class="insights-stat">' + races.length + ' races</span>' +
      '<span class="insights-sep">\u00b7</span>' +
      '<span class="insights-stat">since ' + since + '</span>' +
      '<button class="insights-resync-btn" onclick="window._insightsReset&&window._insightsReset()">Re-sync</button>' +
    '</div>';

    // ── Race history ──
    if (races.length > 0) {
      html += '<div class="vdot-section-label" style="margin-top:14px">Race History</div>';
      html += '<div class="insights-race-table">';
      var displayRaces = races.slice(0, 10);
      displayRaces.forEach(function(r) {
        var b = r.preRace;
        var bestClass = (pats && pats.bestRace && pats.bestRace.date === r.date) ? ' insights-race--best' : '';
        html +=
          '<div class="insights-race-row' + bestClass + '">' +
            '<div class="insights-race-main">' +
              '<span class="insights-race-name">' + r.name + '</span>' +
              '<span class="insights-race-date">' + r.date + '</span>' +
            '</div>' +
            '<div class="insights-race-stats">' +
              '<span class="insights-race-time">' + r.timeStr + '</span>' +
              '<span class="insights-race-pace">' + r.paceStr + '/mi</span>' +
              (r.hr ? '<span class="insights-race-hr">HR ' + r.hr + '</span>' : '') +
            '</div>' +
            '<div class="insights-race-block">' +
              '<span>' + b.avgWeeklyMi + 'mi/wk avg</span>' +
              '<span>peak ' + b.peakWeekMi + 'mi</span>' +
              (b.lastHardDaysOut ? '<span>' + b.lastHardDaysOut + 'd taper</span>' : '') +
            '</div>' +
          '</div>';
      });
      html += '</div>';
    }

    // ── Aerobic efficiency ──
    if (eff.length >= 2) {
      html += '<div class="vdot-section-label" style="margin-top:18px">Aerobic Efficiency</div>';
      html += '<div class="insights-eff-subtitle">Easy run pace at HR 125–155</div>';
      html += '<div class="insights-eff-list">';

      var minPace = Math.min.apply(null, eff.map(function(e) { return e.avgPace; }));
      var maxPace = Math.max.apply(null, eff.map(function(e) { return e.avgPace; }));
      var paceRange = maxPace - minPace || 1;

      eff.forEach(function(e) {
        var barPct = Math.round((1 - (e.avgPace - minPace) / paceRange) * 100);
        var barColor = barPct >= 70 ? '#4ade80' : barPct >= 40 ? '#facc15' : '#fb923c';
        html +=
          '<div class="insights-eff-row">' +
            '<span class="insights-eff-period">' + e.period + '</span>' +
            '<div class="insights-eff-bar-wrap">' +
              '<div class="insights-eff-bar" style="width:' + barPct + '%;background:' + barColor + '"></div>' +
            '</div>' +
            '<span class="insights-eff-pace">' + fmtPaceStr(e.avgPace) + '/mi</span>' +
            '<span class="insights-eff-hr">HR ' + e.avgHR + '</span>' +
          '</div>';
      });
      html += '</div>';

      var firstE = eff[0], lastE = eff[eff.length - 1];
      var impPct = ((firstE.avgPace - lastE.avgPace) / firstE.avgPace * 100).toFixed(1);
      if (parseFloat(impPct) > 1) {
        html += '<div class="tab-rec" style="margin-top:6px">' + impPct + '% faster at the same HR since ' + firstE.period + '</div>';
      }
    }

    // ── Mileage milestones ──
    if (mi.peakWeekMi) {
      html += '<div class="vdot-section-label" style="margin-top:18px">Mileage History</div>';
      html += '<div class="insights-mi-grid">';
      html +=
        '<div class="insights-mi-card"><span class="insights-mi-val">' + mi.peakWeekMi + '</span><span class="insights-mi-lbl">Peak week (mi)</span><span class="insights-mi-date">' + mi.peakWeekDate + '</span></div>' +
        '<div class="insights-mi-card"><span class="insights-mi-val">' + mi.best8wkAvg + '</span><span class="insights-mi-lbl">Best 8-wk avg</span><span class="insights-mi-date">' + (mi.best8wkDate || '') + '</span></div>' +
        '<div class="insights-mi-card"><span class="insights-mi-val">' + mi.recent4wkAvg + '</span><span class="insights-mi-lbl">Current 4-wk avg</span><span class="insights-mi-date">recent</span></div>' +
        '<div class="insights-mi-card"><span class="insights-mi-val">' + (mi.totalMiles || 0).toLocaleString() + '</span><span class="insights-mi-lbl">Career miles</span><span class="insights-mi-date">total</span></div>';
      html += '</div>';

      // Annual mileage bar chart
      if (mi.annualMiles && mi.annualMiles.length > 1) {
        html += '<div class="vdot-section-label" style="margin-top:14px">Annual Mileage</div>';
        html += buildAnnualMilesChart(mi.annualMiles);
      }

      // Weekly mileage sparkline
      if (mi.weeks && mi.weeks.length > 8) {
        html += '<div class="vdot-section-label" style="margin-top:14px">Weekly Mileage</div>';
        html += buildWeeklyMilesChart(mi.weeks);
      }
    }

    // ── Pattern insights ──
    if (pats && pats.insights && pats.insights.length > 0) {
      html += '<div class="vdot-section-label" style="margin-top:18px">What Works For You</div>';
      pats.insights.forEach(function(p) {
        html += '<div class="tab-rec" style="margin:4px 0">' + p + '</div>';
      });
    }

    // ── Best race context ──
    if (pats && pats.bestRace) {
      var b   = pats.bestRace;
      var blk = b.preRace;
      html += '<div class="vdot-section-label" style="margin-top:18px">Best Race Blueprint</div>';
      html +=
        '<div class="insights-blueprint">' +
          '<div class="insights-bp-race">' + b.name + ' \u00b7 ' + b.timeStr + ' @ ' + b.paceStr + '/mi</div>' +
          '<div class="insights-bp-stats">' +
            '<span>' + blk.avgWeeklyMi + 'mi/wk avg</span>' +
            '<span>peak ' + blk.peakWeekMi + 'mi</span>' +
            '<span>' + blk.qualityCount + ' quality sessions</span>' +
            (blk.lastHardDaysOut ? '<span>' + blk.lastHardDaysOut + ' day taper</span>' : '') +
          '</div>' +
        '</div>';
    }

    el.innerHTML = html;

    // Async: append workout-detail sync section and auto-start fetch if needed
    checkLapFetchProgress(el);
    scheduleHistoricalLapFetch();
    checkStreamsFetchProgress(el);
  }

  /* ── Lap-fetch progress check and UI ── */

  var _lapFetchRunning = false;

  /**
   * Called on startup and after history analysis completes.
   * Only auto-starts when the fetch has never been initialized — never
   * auto-resumes an interrupted fetch (user must trigger that manually
   * to avoid consuming Strava quota on every page load).
   */
  async function scheduleHistoricalLapFetch() {
    if (_lapFetchRunning) return;
    try {
      var r = await fetch('/api/history-lap-fetch?accessToken=' + encodeURIComponent(accessToken));
      if (!r.ok) return;
      var prog = await r.json();

      // Already fully complete
      if (prog.completedAt && prog.remaining === 0) {
        if (prog.totalQuality) updateHistoryStatusBar({ lapFetchDone: true, lapFetchTotal: prog.totalQuality });
        return;
      }

      // In-progress from a previous session — leave it for the user to resume
      if (prog.started && prog.processed > 0) return;

      // Never initialized — auto-start for the first time
      startLapFetch(false);
    } catch (_) {}
  }

  async function checkLapFetchProgress(insightsEl) {
    try {
      var r = await fetch('/api/history-lap-fetch?accessToken=' + encodeURIComponent(accessToken));
      if (!r.ok) return;
      var prog = await r.json();
      renderLapFetchSection(insightsEl, prog);
    } catch (_) {}
  }

  function renderLapFetchSection(insightsEl, prog) {
    // Remove existing section if re-rendering
    var existing = document.getElementById('lap-fetch-section');
    if (existing) existing.remove();

    var section = document.createElement('div');
    section.id        = 'lap-fetch-section';
    section.className = 'lapfetch-section';

    var total     = prog.totalQuality || 0;
    var processed = prog.processed    || 0;
    var remaining = prog.remaining != null ? prog.remaining : (total - processed);
    var pct       = total > 0 ? Math.round((processed / total) * 100) : 0;
    var isDone    = !!(prog.completedAt && remaining === 0);

    var statusText, btnLabel;
    if (!prog.started || total === 0) {
      statusText = 'Workout lap data not yet fetched for full history';
      btnLabel   = 'Fetch Workout Details';
    } else if (isDone) {
      statusText = 'All ' + total + ' quality sessions have workout details';
      btnLabel   = 'Re-sync';
    } else if (_lapFetchRunning) {
      statusText = 'Fetching… ' + processed + ' of ' + total + ' sessions (' + pct + '%)';
      btnLabel   = 'Running…';
    } else {
      statusText = processed + ' of ' + total + ' sessions fetched · ' + remaining + ' remaining';
      btnLabel   = processed > 0 ? 'Resume Fetch' : 'Start Fetch';
    }

    section.innerHTML =
      '<div class="lapfetch-header">' +
        '<span class="lapfetch-title">Workout Details</span>' +
        '<button class="lapfetch-btn" id="lapfetch-btn"' + (_lapFetchRunning ? ' disabled' : '') + '>' +
          btnLabel +
        '</button>' +
      '</div>' +
      (total > 0 ? (
        '<div class="lapfetch-progress-wrap">' +
          '<div class="lapfetch-progress-track">' +
            '<div class="lapfetch-progress-bar" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<div class="lapfetch-status' + (isDone ? ' lapfetch-status--done' : '') + '">' +
            statusText +
          '</div>' +
        '</div>'
      ) : (
        '<div class="lapfetch-status">' + statusText + '</div>'
      ));

    if (insightsEl) insightsEl.appendChild(section);

    // Wire up button
    var btn = document.getElementById('lapfetch-btn');
    if (btn && !_lapFetchRunning) {
      btn.addEventListener('click', function () {
        var resetFlag = isDone; // re-sync rebuilds the ID list
        startLapFetch(resetFlag);
      });
    }
  }

  async function startLapFetch(reset) {
    if (_lapFetchRunning) return;
    _lapFetchRunning = true;

    // Update button state immediately
    var btn = document.getElementById('lapfetch-btn');
    if (btn) { btn.textContent = 'Running…'; btn.disabled = true; }

    // First call initializes (or resets) the queue
    try {
      var initResp = await fetch('/api/history-lap-fetch', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accessToken: accessToken, reset: !!reset }),
      });
      if (!initResp.ok) throw new Error('init failed');
      var initData = await initResp.json();

      if (initData.error) {
        _lapFetchRunning = false;
        // notReady = history sync not done yet; silent failure is correct
        if (!initData.notReady) console.warn('lap-fetch error:', initData.error);
        return;
      }

      // If we just initialized (returned totalQuality), update UI immediately
      if (initData.initialized || initData.totalQuality) {
        updateLapFetchUI(initData);
      }

      // If already done, stop
      if (initData.alreadyDone || (initData.remaining === 0 && initData.completedAt)) {
        _lapFetchRunning = false;
        updateLapFetchUI(initData);
        return;
      }
    } catch (_) {
      _lapFetchRunning = false;
      return;
    }

    // Loop: call POST repeatedly until done or rate limited
    runLapFetchLoop();
  }

  async function runLapFetchLoop() {
    while (_lapFetchRunning) {
      try {
        var r = await fetch('/api/history-lap-fetch', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ accessToken: accessToken, batchSize: 5 }),
        });
        if (!r.ok) { _lapFetchRunning = false; break; }

        var data = await r.json();
        updateLapFetchUI(data);

        if (data.completedAt && data.remaining === 0) {
          _lapFetchRunning = false;
          break;
        }
        if (data.rateLimited) {
          // Back off for 60 seconds then resume — don't stop entirely
          updateLapFetchUI({ ...data, _paused: true });
          await new Promise(function (res) { setTimeout(res, 60000); });
          if (!_lapFetchRunning) break; // user cancelled during backoff
          continue;
        }
        if (data.error) {
          _lapFetchRunning = false;
          break;
        }

        // 5 seconds between batches — keeps lap fetch well within Strava's
        // rate limit while still making progress in the background
        await new Promise(function (res) { setTimeout(res, 5000); });
      } catch (_) {
        _lapFetchRunning = false;
        break;
      }
    }
  }

  function updateLapFetchUI(data) {
    var total     = data.totalQuality || 0;
    var processed = data.processed    || 0;
    var remaining = data.remaining != null ? data.remaining : (total - processed);
    var pct       = total > 0 ? Math.round((processed / total) * 100) : 0;
    var isDone    = !!(data.completedAt && remaining === 0);

    var bar = document.querySelector('#lap-fetch-section .lapfetch-progress-bar');
    if (bar) bar.style.width = pct + '%';

    var status = document.querySelector('#lap-fetch-section .lapfetch-status');
    if (status) {
      if (isDone) {
        status.textContent = 'All ' + total + ' quality sessions have workout details';
        status.className = 'lapfetch-status lapfetch-status--done';
      } else if (_lapFetchRunning) {
        status.textContent = 'Fetching… ' + processed + ' of ' + total + ' sessions (' + pct + '%)';
        status.className = 'lapfetch-status';
      } else if (data.rateLimited) {
        status.textContent = processed + ' of ' + total + ' complete · Strava rate limit reached — try again in a few minutes';
        status.className = 'lapfetch-status';
      } else {
        status.textContent = processed + ' of ' + total + ' sessions fetched';
        status.className = 'lapfetch-status';
      }
    }

    var btn = document.getElementById('lapfetch-btn');
    if (btn) {
      if (_lapFetchRunning) {
        btn.textContent = 'Running…';
        btn.disabled    = true;
      } else if (isDone) {
        btn.textContent = 'Re-sync';
        btn.disabled    = false;
      } else {
        btn.textContent = processed > 0 ? 'Resume' : 'Start Fetch';
        btn.disabled    = false;
      }
    }

    // Also update the history status bar with lap fetch info
    if (isDone && total > 0) {
      updateHistoryStatusBar({ lapFetchDone: true, lapFetchTotal: total });
    }
  }

  /* ── Streams / mile-splits fetch ──────────────────────────────────────── */

  var _streamsFetchRunning = false;

  async function checkStreamsFetchProgress(insightsEl) {
    try {
      var r = await fetch('/api/history-lap-fetch?action=streams&accessToken=' + encodeURIComponent(accessToken));
      if (!r.ok) return;
      var prog = await r.json();
      renderStreamsFetchSection(insightsEl, prog);
    } catch (_) {}
  }

  function renderStreamsFetchSection(insightsEl, prog) {
    var existing = document.getElementById('streams-fetch-section');
    if (existing) existing.remove();

    var section = document.createElement('div');
    section.id        = 'streams-fetch-section';
    section.className = 'lapfetch-section';
    section.style.marginTop = '8px';

    var total     = prog.totalQuality || 0;
    var processed = prog.processed    || 0;
    var remaining = prog.remaining != null ? prog.remaining : (total - processed);
    var pct       = total > 0 ? Math.round((processed / total) * 100) : 0;
    var isDone    = !!(prog.completedAt && remaining === 0);

    var statusText, btnLabel;
    if (!prog.started || total === 0) {
      statusText = 'Per-mile splits not yet fetched for races & workouts';
      btnLabel   = 'Fetch Splits';
    } else if (isDone) {
      statusText = '✓ Full splits: ' + total + ' races & workouts';
      btnLabel   = 'Re-sync';
    } else if (_streamsFetchRunning) {
      statusText = 'Fetching splits… ' + processed + ' of ' + total + ' (' + pct + '%)';
      btnLabel   = 'Running…';
    } else {
      statusText = processed + ' of ' + total + ' fetched · ' + remaining + ' remaining';
      btnLabel   = processed > 0 ? 'Resume' : 'Start Fetch';
    }

    section.innerHTML =
      '<div class="lapfetch-header">' +
        '<span class="lapfetch-title">Mile Splits</span>' +
        '<button class="lapfetch-btn" id="streams-fetch-btn"' + (_streamsFetchRunning ? ' disabled' : '') + '>' +
          btnLabel +
        '</button>' +
      '</div>' +
      (total > 0 ? (
        '<div class="lapfetch-progress-wrap">' +
          '<div class="lapfetch-progress-track">' +
            '<div class="lapfetch-progress-bar" style="width:' + pct + '%"></div>' +
          '</div>' +
          '<div class="lapfetch-status' + (isDone ? ' lapfetch-status--done' : '') + '" id="streams-fetch-status">' +
            statusText +
          '</div>' +
        '</div>'
      ) : (
        '<div class="lapfetch-status" id="streams-fetch-status">' + statusText + '</div>'
      ));

    if (insightsEl) insightsEl.appendChild(section);

    var btn = document.getElementById('streams-fetch-btn');
    if (btn && !_streamsFetchRunning) {
      btn.addEventListener('click', function() { startStreamsFetch(isDone); });
    }
  }

  async function startStreamsFetch(reset) {
    if (_streamsFetchRunning) return;
    _streamsFetchRunning = true;
    var btn = document.getElementById('streams-fetch-btn');
    if (btn) { btn.textContent = 'Running…'; btn.disabled = true; }

    try {
      var initResp = await fetch('/api/history-lap-fetch', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ accessToken: accessToken, action: 'streams', reset: !!reset }),
      });
      if (!initResp.ok) throw new Error('init failed');
      var initData = await initResp.json();
      if (initData.error && !initData.notReady) console.warn('streams-fetch error:', initData.error);
      if (initData.error) { _streamsFetchRunning = false; return; }
    } catch (_) { _streamsFetchRunning = false; return; }

    // Loop until done
    while (_streamsFetchRunning) {
      try {
        var r = await fetch('/api/history-lap-fetch', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ accessToken: accessToken, action: 'streams', batchSize: 5 }),
        });
        if (!r.ok) { _streamsFetchRunning = false; break; }
        var data = await r.json();
        updateStreamsFetchUI(data);
        if (data.completedAt && data.remaining === 0) { _streamsFetchRunning = false; break; }
        if (data.rateLimited) {
          updateStreamsFetchUI({ ...data, _paused: true });
          await new Promise(function(res) { setTimeout(res, 60000); });
          if (!_streamsFetchRunning) break;
          continue;
        }
        if (data.error) { _streamsFetchRunning = false; break; }
        await new Promise(function(res) { setTimeout(res, 5000); });
      } catch (_) { _streamsFetchRunning = false; break; }
    }
  }

  function updateStreamsFetchUI(data) {
    var total     = data.totalQuality || 0;
    var processed = data.processed    || 0;
    var remaining = data.remaining != null ? data.remaining : (total - processed);
    var pct       = total > 0 ? Math.round((processed / total) * 100) : 0;
    var isDone    = !!(data.completedAt && remaining === 0);

    var bar = document.querySelector('#streams-fetch-section .lapfetch-progress-bar');
    if (bar) bar.style.width = pct + '%';

    var status = document.getElementById('streams-fetch-status');
    if (status) {
      status.textContent = isDone
        ? '✓ Full splits: ' + total + ' races & workouts'
        : _streamsFetchRunning
          ? 'Fetching splits… ' + processed + ' of ' + total + ' (' + pct + '%)'
          : processed + ' of ' + total + ' fetched';
      status.className = 'lapfetch-status' + (isDone ? ' lapfetch-status--done' : '');
    }

    var btn = document.getElementById('streams-fetch-btn');
    if (btn) {
      if (_streamsFetchRunning) { btn.textContent = 'Running…'; btn.disabled = true; }
      else if (isDone) { btn.textContent = 'Re-sync'; btn.disabled = false; }
      else { btn.textContent = processed > 0 ? 'Resume' : 'Start Fetch'; btn.disabled = false; }
    }
  }

  function buildAnnualMilesChart(annualMiles) {
    var maxMi = Math.max.apply(null, annualMiles.map(function(y) { return y.miles; })) || 1;
    var html  = '<div class="insights-annual-chart">';
    annualMiles.forEach(function(y) {
      var pct   = Math.round((y.miles / maxMi) * 100);
      html +=
        '<div class="insights-annual-col">' +
          '<div class="insights-annual-bar-wrap">' +
            '<div class="insights-annual-bar" style="height:' + pct + '%"></div>' +
          '</div>' +
          '<span class="insights-annual-val">' + y.miles + '</span>' +
          '<span class="insights-annual-yr">' + y.year.slice(2) + '</span>' +
        '</div>';
    });
    return html + '</div>';
  }

  function buildWeeklyMilesChart(weeks) {
    var W = 260, H = 44, PAD = 2;
    var pts    = weeks.slice(-78); // last 18 months
    var values = pts.map(function(w) { return w.miles; });
    var maxV   = Math.max.apply(null, values) || 1;

    function toX(i) { return PAD + (i / (pts.length - 1)) * (W - PAD * 2); }
    function toH(v) { return Math.max(2, (v / maxV) * (H - PAD * 2)); }

    var bars = pts.map(function(w, i) {
      var bh    = toH(w.miles);
      var x     = toX(i) - 1;
      var color = w.miles >= maxV * 0.9 ? '#60a5fa' : w.miles >= maxV * 0.7 ? '#818cf8' : '#374151';
      return '<rect x="' + x + '" y="' + (H - PAD - bh) + '" width="2.5" height="' + bh + '" fill="' + color + '" rx="1"/>';
    }).join('');

    return '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" style="display:block;width:100%;height:auto">' +
      '<rect width="' + W + '" height="' + H + '" fill="#111827" rx="4"/>' +
      bars +
    '</svg>' +
    '<div style="font-size:9px;color:#6b7280;margin-top:2px">Each bar = one week · blue = peak weeks</div>';
  }

  // ── Workout Log ─────────────────────────────────────────────────────────
  function renderLogTab() {
    var el = document.getElementById('tab-log-content');
    if (!el) return;
    if (dashboardError) { el.innerHTML = dashboardErrorHTML(); return; }
    if (!dashboardData) { el.innerHTML = '<div class="tab-loading">Loading…</div>'; return; }

    var acts = (dashboardData.activities || []).slice().sort(function (a, b) { return b.ts - a.ts; });
    if (!acts.length) { el.innerHTML = '<div class="tab-empty">No activities found.</div>'; return; }

    var weekGroups = groupByWeek(acts);

    var html = '<div class="log-header">' +
      '<span class="tab-section-label">Training Log</span>' +
      '<button class="log-export-btn" id="log-export-btn">&#8659; Export PDF</button>' +
    '</div>';

    weekGroups.forEach(function (wg) { html += renderWeekSection(wg); });

    el.innerHTML = html;
    bindLogEvents(el);

    var actIds  = acts.map(function (a) { return String(a.id); });
    var weekKeys = weekGroups.map(function (wg) { return wg.weekKey; });
    loadLogNotes(actIds, weekKeys, el);
  }

  /* ── Week grouping helpers ── */
  function groupByWeek(activities) {
    var groups = {}, order = [];
    activities.forEach(function (a) {
      var key = getISOWeekKey(a.ts);
      if (!groups[key]) {
        groups[key] = { weekKey: key, activities: [], monday: getWeekMonday(a.ts) };
        order.push(key);
      }
      groups[key].activities.push(a);
    });
    return order.map(function (k) { return groups[k]; });
  }

  function getISOWeekKey(ts) {
    var d = new Date(ts);
    var utcd = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    utcd.setUTCDate(utcd.getUTCDate() + 4 - (utcd.getUTCDay() || 7));
    var yearStart = new Date(Date.UTC(utcd.getUTCFullYear(), 0, 1));
    var wn = Math.ceil((((utcd - yearStart) / 86400000) + 1) / 7);
    return utcd.getUTCFullYear() + '-W' + String(wn).padStart(2, '0');
  }

  function getWeekMonday(ts) {
    var d = new Date(ts);
    var day = d.getDay();
    var offset = day === 0 ? -6 : 1 - day;
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + offset);
  }

  /* ── Week section renderer ── */
  function renderWeekSection(wg) {
    var acts     = wg.activities;
    var totalMi  = acts.reduce(function (s, a) {
      return s + (/run/i.test(a.type || '') ? (a.distMi || 0) : 0);
    }, 0);
    var runCount = acts.filter(function (a) { return /run/i.test(a.type || '') && a.distMi; }).length;

    var monday  = wg.monday;
    var sunday  = new Date(monday.getTime() + 6 * 86400000);
    var mo = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var range = mo[monday.getMonth()] + ' ' + monday.getDate() +
      ' \u2013 ' + mo[sunday.getMonth()] + ' ' + sunday.getDate();

    var wd = weekDataCache[wg.weekKey] || {};
    var targetMi = wd.targetMiles != null ? wd.targetMiles : '';
    var weekNotes = wd.notes || '';
    var pct = targetMi ? Math.min(100, Math.round(totalMi / parseFloat(targetMi) * 100)) : 0;
    var progressLabel = targetMi ? totalMi.toFixed(1) + '/' + targetMi + ' mi' : '';

    var html = '<div class="log-week" data-week-key="' + hescAttr(wg.weekKey) + '">';

    html += '<div class="log-week__header">' +
      '<span class="log-week__range">' + hesc(range) + '</span>' +
      '<span class="log-week__totals">' + totalMi.toFixed(1) + 'mi \u00b7 ' + runCount + ' run' + (runCount !== 1 ? 's' : '') + '</span>' +
    '</div>';

    html += '<div class="log-week__target-row">' +
      '<span class="log-week__target-label">Target</span>' +
      '<input type="number" class="log-week__target-input" placeholder="\u2014" value="' + hescAttr(targetMi) + '" min="0" step="1">' +
      '<div class="log-week__progress"><div class="log-week__progress-bar" style="width:' + pct + '%"></div></div>' +
      '<span class="log-week__target-label log-week__progress-label">' + hesc(progressLabel) + '</span>' +
    '</div>';

    html += '<div class="log-week__notes-label">Week notes</div>' +
      '<textarea class="log-week__notes" rows="1" placeholder="Add weekly notes\u2026">' + hescTa(weekNotes) + '</textarea>';

    acts.forEach(function (a) { html += renderActivityRow(a); });

    html += '</div>';
    return html;
  }

  /* ── Activity row renderer ── */
  function renderActivityRow(a) {
    var tagCls  = CLS_TAG[a.classification];
    var tagHTML = tagCls
      ? '<span class="run-tag run-tag--' + tagCls + '">' + hesc(a.classification) + '</span>'
      : (a.type ? '<span class="log-type">' + hesc(a.type) + '</span>' : '');

    var stats = '';
    if (a.distMi)      stats += '<span class="log-stat">' + a.distMi.toFixed(1) + 'mi</span>';
    if (a.pace)        stats += '<span class="log-stat">' + hesc(a.pace) + '/mi</span>';
    if (a.avgHR)       stats += '<span class="log-stat">\u2665\u00a0' + a.avgHR + '</span>';
    if (a.durationMin) stats += '<span class="log-stat">' + a.durationMin + 'min</span>';
    if (a.elevFt)      stats += '<span class="log-stat">\u2191' + a.elevFt + 'ft</span>';

    var cached      = logNotesCache[String(a.id)] || {};
    var titleVal    = hescAttr(cached.title || a.name || '');
    var notesVal    = hescTa(cached.notes || '');

    return '<div class="log-activity" data-activity-id="' + a.id + '"' + (tagCls ? ' data-type="' + tagCls + '"' : '') + '>' +
      '<div class="log-activity__head">' +
        '<span class="log-activity__toggle">&#9654;</span>' +
        '<div class="log-activity__meta">' +
          '<div class="log-activity__top">' +
            '<span class="log-activity__date">' + hesc(a.date) + '</span>' +
            tagHTML +
          '</div>' +
          '<input type="text" class="log-activity__title-input" value="' + titleVal + '" placeholder="Activity title">' +
          (stats ? '<div class="log-activity__stats">' + stats + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<div class="log-activity__body">' +
        '<div class="lap-loading" data-lap-placeholder="' + a.id + '">Loading laps\u2026</div>' +
        '<textarea class="log-activity__notes" rows="2" placeholder="Add notes for this workout\u2026">' + notesVal + '</textarea>' +
      '</div>' +
    '</div>';
  }

  /* ── Event binding ── */
  function bindLogEvents(el) {
    // Export button
    var exportBtn = el.querySelector('#log-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', exportToPDF);

    // Expand/collapse — delegate on the container, ignore input clicks
    el.addEventListener('click', function (e) {
      var head = e.target.closest('.log-activity__head');
      if (!head) return;
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      var row = head.closest('.log-activity');
      if (!row) return;
      var wasExpanded = row.classList.contains('expanded');
      row.classList.toggle('expanded');
      if (!wasExpanded) {
        var ph = row.querySelector('[data-lap-placeholder]');
        if (ph) loadLapData(row.dataset.activityId, ph);
      }
    });

    // Stop click propagation on title inputs so they don't trigger toggle
    el.querySelectorAll('.log-activity__title-input').forEach(function (inp) {
      inp.addEventListener('click', function (e) { e.stopPropagation(); });
      inp.addEventListener('input', function () {
        clearTimeout(inp._t);
        inp._t = setTimeout(function () {
          var row = inp.closest('.log-activity');
          if (row) saveActivityNote(row.dataset.activityId, { title: inp.value });
        }, 600);
      });
    });

    // Activity notes — auto-resize + debounced save
    el.querySelectorAll('.log-activity__notes').forEach(function (ta) {
      autoResizeTa(ta);
      ta.addEventListener('input', function () {
        autoResizeTa(ta);
        clearTimeout(ta._t);
        ta._t = setTimeout(function () {
          var row = ta.closest('.log-activity');
          if (row) saveActivityNote(row.dataset.activityId, { notes: ta.value });
        }, 600);
      });
    });

    // Week notes — auto-resize + debounced save
    el.querySelectorAll('.log-week__notes').forEach(function (ta) {
      autoResizeTa(ta);
      ta.addEventListener('input', function () {
        autoResizeTa(ta);
        clearTimeout(ta._t);
        ta._t = setTimeout(function () {
          var week = ta.closest('.log-week');
          if (week) saveWeekData(week.dataset.weekKey, { notes: ta.value });
        }, 600);
      });
    });

    // Week target mileage
    el.querySelectorAll('.log-week__target-input').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var week = inp.closest('.log-week');
        if (!week) return;
        var val = inp.value !== '' ? parseFloat(inp.value) : null;
        saveWeekData(week.dataset.weekKey, { targetMiles: val });
        updateWeekProgress(week, val);
      });
    });
  }

  function autoResizeTa(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight, 36) + 'px';
  }

  function updateWeekProgress(weekEl, targetMi) {
    var totalsEl = weekEl.querySelector('.log-week__totals');
    var totalMiMatch = totalsEl ? totalsEl.textContent.match(/^([\d.]+)/) : null;
    var totalMi = totalMiMatch ? parseFloat(totalMiMatch[1]) : 0;
    var pct = targetMi ? Math.min(100, Math.round(totalMi / parseFloat(targetMi) * 100)) : 0;
    var bar = weekEl.querySelector('.log-week__progress-bar');
    if (bar) bar.style.width = pct + '%';
    var lbl = weekEl.querySelector('.log-week__progress-label');
    if (lbl) lbl.textContent = targetMi ? totalMi.toFixed(1) + '/' + targetMi + ' mi' : '';
  }

  /* ── Notes fetch + KV save ── */
  function loadLogNotes(actIds, weekKeys, containerEl) {
    var qs = '?accessToken=' + encodeURIComponent(accessToken);
    if (actIds.length)   qs += '&activityIds=' + actIds.join(',');
    if (weekKeys.length) qs += '&weekKeys=' + weekKeys.join(',');

    fetch('/api/activity-notes' + qs)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        Object.assign(logNotesCache, data.activities || {});
        Object.assign(weekDataCache,  data.weeks      || {});

        // Patch in loaded values
        Object.keys(data.activities || {}).forEach(function (id) {
          var note = data.activities[id];
          var row  = containerEl.querySelector('.log-activity[data-activity-id="' + id + '"]');
          if (!row) return;
          var inp = row.querySelector('.log-activity__title-input');
          if (inp && note.title) inp.value = note.title;
          var ta = row.querySelector('.log-activity__notes');
          if (ta && note.notes) { ta.value = note.notes; autoResizeTa(ta); }
        });

        Object.keys(data.weeks || {}).forEach(function (key) {
          var wd     = data.weeks[key];
          var weekEl = containerEl.querySelector('.log-week[data-week-key="' + key + '"]');
          if (!weekEl) return;
          if (wd.targetMiles != null) {
            var inp = weekEl.querySelector('.log-week__target-input');
            if (inp) { inp.value = wd.targetMiles; updateWeekProgress(weekEl, wd.targetMiles); }
          }
          if (wd.notes) {
            var ta = weekEl.querySelector('.log-week__notes');
            if (ta) { ta.value = wd.notes; autoResizeTa(ta); }
          }
        });
      })
      .catch(function () {});
  }

  function saveActivityNote(activityId, data) {
    fetch('/api/activity-notes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(Object.assign({ accessToken: accessToken, activityId: activityId }, data)),
    }).catch(function () {});
    if (!logNotesCache[activityId]) logNotesCache[activityId] = {};
    Object.assign(logNotesCache[activityId], data);
  }

  function saveWeekData(weekKey, data) {
    fetch('/api/activity-notes', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(Object.assign({ accessToken: accessToken, weekKey: weekKey }, data)),
    }).catch(function () {});
    if (!weekDataCache[weekKey]) weekDataCache[weekKey] = {};
    Object.assign(weekDataCache[weekKey], data);
  }

  /* ── Lap data (lazy) ── */
  function loadLapData(activityId, placeholderEl) {
    if (!activityId || !placeholderEl) return;

    if (lapDataCache[activityId]) {
      var html = buildLapTable(lapDataCache[activityId]);
      placeholderEl.outerHTML = html || '';
      return;
    }

    var mem = loadMemory();
    var qs  = '?accessToken=' + encodeURIComponent(accessToken) + '&activityId=' + activityId;
    if (mem.paces && mem.paces.threshold) {
      var mid = (mem.paces.threshold[0] + mem.paces.threshold[1]) / 2;
      qs += '&threshPaceMin=' + mid.toFixed(4);
    }

    fetch('/api/laps' + qs)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) { if (placeholderEl.parentNode) placeholderEl.outerHTML = ''; return; }
        lapDataCache[activityId] = data;
        var html = buildLapTable(data);
        if (placeholderEl.parentNode) placeholderEl.outerHTML = html || '';
      })
      .catch(function () { if (placeholderEl.parentNode) placeholderEl.outerHTML = ''; });
  }

  function buildLapTable(data) {
    var laps = data.laps || [];
    if (!laps.length) return '';

    var cls2key = {
      'Easy': 'easy', 'Moderate': 'moderate', 'Hard': 'hard',
      'Interval': 'interval', 'Warm-up': 'warmup', 'Cool-down': 'cooldown',
    };

    var patHtml = '';
    if (data.pattern && data.pattern.description && data.pattern.type !== 'Unknown') {
      patHtml = '<div class="lap-pattern">' + hesc(data.pattern.description) + '</div>';
    }

    var rows = laps.map(function (lap) {
      var key = cls2key[lap.classification] || 'easy';
      return '<tr class="lap-row--' + key + '">' +
        '<td>' + lap.lapNum + '</td>' +
        '<td>' + (lap.distMi || '\u2014') + '</td>' +
        '<td>' + (lap.pace   || '\u2014') + '</td>' +
        '<td>' + (lap.hr     || '\u2014') + '</td>' +
        '<td>' + (lap.maxHR  || '\u2014') + '</td>' +
        '<td>' + (lap.elevFt != null ? '+' + lap.elevFt : '\u2014') + '</td>' +
        '<td><span class="lap-badge lap-badge--' + key + '">' + hesc(lap.classification) + '</span></td>' +
      '</tr>';
    }).join('');

    return patHtml +
      '<div class="lap-table-wrap"><table class="lap-table">' +
      '<thead><tr><th>#</th><th>Dist</th><th>Pace</th><th>HR</th><th>Max HR</th><th>Elev</th><th>Zone</th></tr></thead>' +
      '<tbody>' + rows + '</tbody>' +
      '</table></div>';
  }

  /* ── PDF Export ── */
  function exportToPDF() {
    if (!window.jspdf || !window.jspdf.jsPDF) {
      alert('PDF library is still loading — please try again in a moment.');
      return;
    }
    var jsPDF = window.jspdf.jsPDF;
    var doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });

    var athleteName = ((athlete.firstname || '') + ' ' + (athlete.lastname || '')).trim();
    var headerDate  = new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    doc.setFontSize(20);
    doc.setFont(undefined, 'bold');
    doc.text('Training Log', 40, 48);

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.setTextColor(120);
    doc.text((athleteName || 'Athlete') + '  \u00b7  ' + headerDate, 40, 64);

    var y = 84;
    var pageH = doc.internal.pageSize.height;

    var containerEl = document.getElementById('tab-log-content');
    if (!containerEl) { doc.save('training-log.pdf'); return; }

    containerEl.querySelectorAll('.log-week').forEach(function (weekEl) {
      var rangeEl  = weekEl.querySelector('.log-week__range');
      var totalsEl = weekEl.querySelector('.log-week__totals');
      var rangeStr  = rangeEl  ? rangeEl.textContent  : '';
      var totalsStr = totalsEl ? totalsEl.textContent : '';

      // Week section needs at least 50pt headroom
      if (y > pageH - 80) { doc.addPage(); y = 40; }

      doc.setFontSize(9);
      doc.setFont(undefined, 'bold');
      doc.setTextColor(40);
      doc.text(rangeStr.toUpperCase(), 40, y);
      doc.setFont(undefined, 'normal');
      doc.setTextColor(110);
      doc.text(totalsStr, 300, y);
      y += 4;
      doc.setDrawColor(200);
      doc.line(40, y, 571, y);
      y += 10;

      weekEl.querySelectorAll('.log-activity').forEach(function (actEl) {
        var actId   = actEl.dataset.activityId;
        var dateEl  = actEl.querySelector('.log-activity__date');
        var titleInp = actEl.querySelector('.log-activity__title-input');
        var statsEl = actEl.querySelector('.log-activity__stats');
        var notesEl = actEl.querySelector('.log-activity__notes');

        var dateStr   = dateEl   ? dateEl.textContent   : '';
        var titleStr  = titleInp ? titleInp.value       : '';
        var statsText = statsEl  ? Array.from(statsEl.querySelectorAll('.log-stat')).map(function (s) { return s.textContent; }).join('  ') : '';
        var notesText = notesEl  ? notesEl.value.trim() : '';

        if (y > pageH - 60) { doc.addPage(); y = 40; }

        doc.setFontSize(9);
        doc.setFont(undefined, 'bold');
        doc.setTextColor(40);
        doc.text(dateStr, 40, y);
        doc.setFont(undefined, 'normal');
        doc.setTextColor(60);
        doc.text(doc.splitTextToSize(titleStr, 180)[0] || '', 110, y);
        doc.setTextColor(130);
        doc.text(statsText, 300, y);
        y += 14;

        if (notesText) {
          doc.setFontSize(8);
          doc.setTextColor(120);
          var noteLines = doc.splitTextToSize(notesText, 500);
          if (y + noteLines.length * 10 > pageH - 20) { doc.addPage(); y = 40; }
          doc.text(noteLines, 50, y);
          y += noteLines.length * 10 + 4;
        }

        // Lap table (only when cached — i.e. user expanded this activity)
        var laps = lapDataCache[actId] && lapDataCache[actId].laps;
        if (laps && laps.length > 1) {
          var tblHead = [['#', 'Distance', 'Pace', 'Avg HR', 'Zone']];
          var tblBody = laps.map(function (l) {
            return [l.lapNum, (l.distMi ? l.distMi + ' mi' : '\u2014'), (l.pace || '\u2014'), (l.hr || '\u2014'), (l.classification || '\u2014')];
          });
          if (y > pageH - 80) { doc.addPage(); y = 40; }
          doc.autoTable({
            head:       tblHead,
            body:       tblBody,
            startY:     y,
            margin:     { left: 50, right: 40 },
            styles:     { fontSize: 7, cellPadding: 2 },
            headStyles: { fillColor: [40, 40, 40], textColor: [180, 180, 180] },
            theme:      'grid',
          });
          y = doc.lastAutoTable.finalY + 8;
        }
        y += 2;
      });

      y += 10;
    });

    doc.save('training-log.pdf');
  }

  // ── Gear / Shoe Tracker ──────────────────────────────────────────────────
  function renderGearTab() {
    var el = document.getElementById('tab-gear-content');
    if (!el) return;

    var shoes = dashboardData && dashboardData.shoes;
    if (!shoes) { el.innerHTML = '<div class="tab-loading">Loading\u2026</div>'; return; }
    if (!shoes.length) {
      el.innerHTML =
        '<div class="tab-empty">No shoes found.</div>' +
        '<div class="tab-rec">If you have gear set up in Strava, <strong>log out and log back in</strong> so the app can request gear access. Strava requires a separate permission (<code>profile:read_all</code>) to read your shoe data.</div>';
      return;
    }

    var mem        = loadMemory();
    var categories = mem.shoeCategories || {};
    var catOptions = [
      { value: '',        label: 'Uncategorised' },
      { value: 'daily',   label: 'Daily Trainer' },
      { value: 'long',    label: 'Long Run' },
      { value: 'tempo',   label: 'Tempo / Performance' },
      { value: 'race',    label: 'Racing Flat' },
      { value: 'trail',   label: 'Trail' },
    ];

    var html = shoes.map(function (s) {
      var pct    = Math.min(100, Math.round(s.distanceMi / 500 * 100));
      var barClr = s.distanceMi >= 500 ? '#f87171' : s.distanceMi >= 400 ? '#fb923c' : '#4ade80';
      var status = s.distanceMi >= 500 ? '\u{1F534} Replace soon' : s.distanceMi >= 400 ? '\u{1F7E1} Nearing end of life' : '\u{1F7E2} Good condition';
      var selHTML = catOptions.map(function (o) {
        var sel = (categories[s.id] === o.value || (!categories[s.id] && o.value === '')) ? ' selected' : '';
        return '<option value="' + o.value + '"' + sel + '>' + o.label + '</option>';
      }).join('');

      return '<div class="shoe-card" data-shoe-id="' + s.id + '" data-shoe-name="' + s.name + '">' +
        '<div class="shoe-card__header">' +
          '<span class="shoe-card__name">' + s.name + (s.brand ? ' <span style="font-weight:400;color:var(--text-sub)">(' + s.brand + ')</span>' : '') + '</span>' +
          '<span class="shoe-card__miles">' + s.distanceMi + '\u00a0mi</span>' +
        '</div>' +
        '<div class="shoe-bar"><div class="shoe-bar__fill" style="width:' + pct + '%;background:' + barClr + '"></div></div>' +
        '<div class="shoe-card__footer">' +
          '<span class="shoe-card__status">' + status + '</span>' +
          '<select class="shoe-cat-select" data-shoe-id="' + s.id + '" data-shoe-name="' + s.name + '">' + selHTML + '</select>' +
        '</div>' +
      '</div>';
    }).join('');

    el.innerHTML = html +
      '<div class="tab-rec" style="margin-top:12px">Categorise each shoe so your coach can recommend the right one for each workout.</div>';

    // Save category on change
    el.querySelectorAll('.shoe-cat-select').forEach(function (sel) {
      sel.addEventListener('change', function () {
        var shoeId   = sel.dataset.shoeId;
        var shoeName = sel.dataset.shoeName;
        var m        = loadMemory();
        if (!m.shoeCategories) m.shoeCategories = {};
        if (sel.value) {
          m.shoeCategories[shoeId]   = sel.value;
          m.shoeCategories[shoeName] = sel.value; // also index by name for chat context
        } else {
          delete m.shoeCategories[shoeId];
          delete m.shoeCategories[shoeName];
        }
        saveMemory(m);
      });
    });
  }

  // ── Recovery (Oura Ring) ─────────────────────────────────────────────────

  function fetchOuraData(onComplete) {
    var now = Date.now();
    // Cache for 12 hours to match KV TTL
    if (ouraData !== null && now - ouraFetchedAt < 12 * 60 * 60 * 1000) {
      if (onComplete) onComplete();
      return;
    }
    if (ouraFetching) return;
    ouraFetching = true;

    fetch('/api/oura?accessToken=' + encodeURIComponent(accessToken))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        ouraFetching  = false;
        ouraData      = data || { available: false };
        ouraFetchedAt = Date.now();
        var active = document.querySelector('.mem-tab.active');
        if (active && active.dataset.tab === 'recovery') renderRecoveryTab();
        if (onComplete) onComplete();
      })
      .catch(function () {
        ouraFetching = false;
        ouraData     = { available: false };
        var active = document.querySelector('.mem-tab.active');
        if (active && active.dataset.tab === 'recovery') renderRecoveryTab();
      });
  }

  function renderRecoveryTab() {
    var el = document.getElementById('tab-recovery-content');
    if (!el) return;

    if (ouraData === null) {
      el.innerHTML = '<div class="tab-loading">Loading…</div>';
      fetchOuraData();
      return;
    }

    if (!ouraData.available) {
      var reason = ouraData.reason;
      var msg = reason === 'not_configured'
        ? 'Add <code>OURA_ACCESS_TOKEN</code> to Vercel environment variables to enable recovery tracking.'
        : reason === 'invalid_token'
        ? 'Oura access token is invalid. Check <code>OURA_ACCESS_TOKEN</code> in Vercel settings.'
        : 'Oura data unavailable right now. Try again later.';
      el.innerHTML = '<div class="tab-empty" style="line-height:1.6">' + msg + '</div>';
      return;
    }

    var html = '';

    // ── Today's readiness headline ─────────────────────────────────────
    var todayScore = ouraData.todayReadiness;
    var r7         = ouraData.readiness7d || [];
    var s7         = ouraData.sleep7d     || [];

    if (todayScore != null) {
      var rClr   = todayScore >= 80 ? '#4ade80' : todayScore >= 60 ? '#facc15' : '#f87171';
      var rLabel = todayScore >= 80 ? 'Ready to train' : todayScore >= 60 ? 'Moderate — take it easy' : 'Low — prioritize recovery';
      html += '<div class="rec-today-row">' +
        '<div class="rec-today-score" style="color:' + rClr + '">' + todayScore + '</div>' +
        '<div class="rec-today-info">' +
          '<div class="rec-today-label">Readiness</div>' +
          '<div class="rec-today-sub" style="color:' + rClr + '">' + rLabel + '</div>' +
        '</div>' +
      '</div>';
    }

    // ── HRV vs baseline ────────────────────────────────────────────────
    var todayHrvPct = ouraData.todayHrvPct;
    if (todayHrvPct != null) {
      var sign   = todayHrvPct >= 0 ? '+' : '';
      var hrvCls = todayHrvPct >= 3 ? 'tab-trend--up' : todayHrvPct <= -3 ? 'tab-trend--down' : 'tab-trend--flat';
      var arrow  = todayHrvPct >= 3 ? '↑' : todayHrvPct <= -3 ? '↓' : '→';
      var rel    = todayHrvPct >= 3 ? 'above' : todayHrvPct <= -3 ? 'below' : 'near';
      html += '<div class="tab-section-label" style="margin-top:14px;margin-bottom:4px">HRV vs Baseline</div>' +
        '<div class="tab-trend ' + hrvCls + '">' +
          arrow + ' HRV: ' + sign + Math.abs(todayHrvPct).toFixed(1) + '% ' + rel + ' your baseline' +
        '</div>';
    }

    // ── Readiness bar chart (7 days) ───────────────────────────────────
    if (r7.length) {
      html += '<div class="tab-section-label" style="margin-top:14px;margin-bottom:4px">Readiness — 7 Days</div>';
      html += buildRecChart(r7,
        function (d) { return d.score; }, 0, 100,
        function (v) { return v >= 80 ? '#4ade80' : v >= 60 ? '#facc15' : '#f87171'; },
        function (d) { return dayAbbr(d.day); },
        function (v) { return v != null ? String(v) : '—'; });
    }

    // ── Sleep duration bar chart (7 days) ─────────────────────────────
    if (s7.length) {
      html += '<div class="tab-section-label" style="margin-top:14px;margin-bottom:4px">Sleep Duration — 7 Days</div>';
      html += buildRecChart(s7,
        function (d) { return d.durationMin; }, 240, 600,
        function (v) { return v >= 420 ? '#4ade80' : v >= 360 ? '#facc15' : '#f87171'; },
        function (d) { return dayAbbr(d.day); },
        function (v) { return v != null ? Math.floor(v / 60) + 'h' + (v % 60 ? (v % 60) + 'm' : '') : '—'; });
    }

    // ── Resting HR trend (7 days) ──────────────────────────────────────
    var hrPts = s7.filter(function (d) { return d.restingHr != null; });
    if (hrPts.length) {
      var minHR = Math.min.apply(null, hrPts.map(function (d) { return d.restingHr; }));
      var maxHR = Math.max.apply(null, hrPts.map(function (d) { return d.restingHr; }));
      html += '<div class="tab-section-label" style="margin-top:14px;margin-bottom:4px">Resting HR — 7 Days</div>';
      html += buildRecChart(s7,
        function (d) { return d.restingHr; },
        Math.max(0, minHR - 4), maxHR + 4,
        function () { return '#60a5fa'; },
        function (d) { return dayAbbr(d.day); },
        function (v) { return v != null ? v + ' bpm' : '—'; });
    }

    el.innerHTML = html || '<div class="tab-empty">No Oura data for the past 7 days.</div>';
  }

  function buildRecChart(items, getValue, minV, maxV, getColor, getLabel, fmtVal) {
    var range = (maxV - minV) || 1;
    var cols  = items.map(function (item) {
      var v   = getValue(item);
      var pct = v != null ? Math.max(4, Math.round((v - minV) / range * 100)) : 4;
      var clr = v != null ? getColor(v) : 'rgba(255,255,255,0.08)';
      return '<div class="rec-chart-col">' +
        '<div class="rec-chart-val">' + fmtVal(v) + '</div>' +
        '<div class="rec-chart-bar-wrap">' +
          '<div class="rec-chart-bar" style="height:' + pct + '%;background:' + clr + '"></div>' +
        '</div>' +
        '<div class="rec-chart-lbl">' + getLabel(item) + '</div>' +
      '</div>';
    }).join('');
    return '<div class="rec-chart">' + cols + '</div>';
  }

  function dayAbbr(dateStr) {
    var d = new Date(dateStr + 'T12:00:00Z');
    return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][d.getUTCDay()];
  }

  /* ── Lap history sync ─────────────────────────────────────────────────────
     Retroactively analyzes the last 90 days of activities and caches lap data
     in Vercel KV so the AI coach has detailed workout pattern context.
     Skips entirely if KV shows sync < 24 hours ago (persists across devices).
     On subsequent syncs, only fetches new activities since last sync date.
  ──────────────────────────────────────────────────────────────────────────── */

  var LAP_SYNC_KEY = 'lap_sync_at';
  var _historySyncMeta = null; // { lastSyncAt, syncedUntil, count, finishedAt }

  function updateHistoryStatusBar(info) {
    if (info) {
      _historySyncMeta = Object.assign(_historySyncMeta || {}, info);
    }
    var bar = document.getElementById('history-status-bar');
    if (!bar || !_historySyncMeta) return;

    var parts = [];
    var count = (_historySyncMeta.count) || (window._insightsData && window._insightsData.meta && window._insightsData.meta.totalActivities);
    if (count) parts.push(count + ' sessions loaded');

    var syncTs = _historySyncMeta.finishedAt || _historySyncMeta.lastSyncAt;
    if (syncTs) {
      var d = new Date(syncTs);
      var MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      parts.push('last synced ' + MON[d.getMonth()] + ' ' + d.getDate());
    }

    if (_historySyncMeta.lapFetchDone && _historySyncMeta.lapFetchTotal) {
      parts.push(_historySyncMeta.lapFetchTotal + ' workouts detailed');
    }

    if (!parts.length) { bar.hidden = true; return; }
    bar.textContent = 'Training history: ' + parts.join(' · ');
    bar.hidden = false;
  }

  async function scheduleLapSync() {
    // Check KV-backed sync state first — persists across devices and sessions
    var kvLastSyncAt  = 0;
    var kvSyncedUntil = 0;
    try {
      var tsResp = await fetch('/api/training-summary?accessToken=' + encodeURIComponent(accessToken));
      if (tsResp.ok) {
        var tsData = await tsResp.json();
        kvLastSyncAt  = tsData.lastSyncAt  || 0;
        kvSyncedUntil = tsData.syncedUntil || 0;
        if (kvLastSyncAt) updateHistoryStatusBar({ lastSyncAt: kvLastSyncAt });
      }
    } catch (_) {}

    var oneDayMs = 24 * 60 * 60 * 1000;

    // Skip if KV shows synced < 24h ago
    if (Date.now() - kvLastSyncAt < oneDayMs) return;

    // Also skip if localStorage shows synced < 24h ago (works without KV)
    var lastSync = parseInt(localStorage.getItem(LAP_SYNC_KEY) || '0', 10);
    if (Date.now() - lastSync < oneDayMs) return;

    if (!dashboardData || !dashboardData.activities) return;
    runLapSync(kvSyncedUntil);
  }

  async function runLapSync(syncedUntilMs) {
    // Fetch only new activities since last sync (or 90 days if no prior sync)
    var since90Ms   = Date.now() - 90 * 24 * 60 * 60 * 1000;
    var afterMs     = (syncedUntilMs && syncedUntilMs > since90Ms) ? syncedUntilMs : since90Ms;
    var afterSec    = Math.floor(afterMs / 1000);
    var allActivities = [];
    try {
      var r = await fetch(
        'https://www.strava.com/api/v3/athlete/activities?after=' + afterSec + '&per_page=100',
        { headers: { Authorization: 'Bearer ' + accessToken } }
      );
      if (!r.ok) return;
      allActivities = await r.json();
    } catch (_) { return; }

    // Filter to runs only (laps make sense for running)
    var mem = loadMemory();
    var threshPaceMin = mem.paces && mem.paces.threshold
      ? ((mem.paces.threshold[0] + mem.paces.threshold[1]) / 2).toFixed(4)
      : null;

    var runs = allActivities.filter(function (a) {
      return /run/i.test(a.type || '') && (a.moving_time || 0) >= 300;
    }).map(function (a) {
      return {
        id:          a.id,
        date:        (a.start_date_local || a.start_date || '').slice(0, 10),
        name:        a.name  || a.type,
        type:        a.type,
        movingTime:  a.moving_time  || 0,
        distance:    a.distance     || 0,
        workoutType: a.workout_type || 0,
      };
    });

    if (!runs.length) return;

    // Show progress card
    var syncCard = document.createElement('div');
    syncCard.className  = 'sync-progress-card';
    syncCard.id         = 'lap-sync-card';
    var total           = runs.length;
    var synced          = 0;

    function updateCard(msg, done) {
      syncCard.innerHTML =
        '<div class="sync-progress__label">' +
          (done ? '\u2713 Training history synced' : '\u25cf Analyzing training history\u2026') +
        '</div>' +
        '<div class="sync-progress__detail">' + msg + '</div>' +
        (done ? '' : '<div class="sync-progress__bar"><div class="sync-progress__fill" style="width:' +
          Math.round(synced / total * 100) + '%"></div></div>');
      if (done) {
        setTimeout(function () {
          if (syncCard.parentNode) syncCard.parentNode.removeChild(syncCard);
        }, 4000);
      }
    }

    updateCard('0 / ' + total + ' activities', false);
    // Insert after first coach message
    var insertAfter = messagesEl.querySelector('.msg--coach');
    if (insertAfter && insertAfter.nextSibling) {
      messagesEl.insertBefore(syncCard, insertAfter.nextSibling);
    } else {
      messagesEl.appendChild(syncCard);
    }
    scrollToBottom();

    // Batch-send to /api/training-summary in groups of 25
    var BATCH = 25;
    for (var offset = 0; offset < runs.length; offset += BATCH) {
      var batch = runs.slice(offset, offset + BATCH);
      try {
        var resp = await fetch('/api/training-summary', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            accessToken,
            activities:    batch,
            threshPaceMin: threshPaceMin ? parseFloat(threshPaceMin) : null,
          }),
        });
        if (resp.ok) {
          var data = await resp.json();
          synced += (data.processed || 0) + (data.cached || 0);
          if (data.rateLimited) {
            updateCard('Rate limited by Strava — sync will resume tomorrow.', true);
            break;
          }
          updateCard(synced + ' / ' + total + ' activities', false);
          if (data.done && offset + BATCH >= runs.length) break;
        }
      } catch (_) {}
    }

    localStorage.setItem(LAP_SYNC_KEY, Date.now().toString());
    updateHistoryStatusBar({ lastSyncAt: Date.now() });
    updateCard(synced + ' activities analyzed · coach has 90-day workout history', true);
  }

  /* ── Weekly balance card ── */
  const TAG_DEFS = [
    { key: 'easy',     label: 'Easy',     cls: 'easy'     },
    { key: 'long',     label: 'Long',     cls: 'long'     },
    { key: 'tempo',    label: 'Tempo',    cls: 'tempo'    },
    { key: 'workout',  label: 'Workout',  cls: 'workout'  },
    { key: 'recovery', label: 'Recovery', cls: 'recovery' },
    { key: 'race',     label: 'Race',     cls: 'race'     },
  ];

  function renderBalanceCard(balance) {
    if (!balance) return;

    const card = document.createElement('div');
    card.className = 'balance-card';

    const title = document.createElement('div');
    title.className = 'balance-card__title';
    title.textContent = balance.total > 0
      ? `This week · ${balance.total} run${balance.total !== 1 ? 's' : ''}`
      : 'This week · no runs logged';
    card.appendChild(title);

    if (balance.total > 0) {
      const tags = document.createElement('div');
      tags.className = 'balance-card__tags';
      TAG_DEFS.forEach(({ key, label, cls }) => {
        const count = balance[key] || 0;
        if (!count) return;
        const tag = document.createElement('span');
        tag.className = `run-tag run-tag--${cls}`;
        tag.textContent = `${count} ${label}`;
        tags.appendChild(tag);
      });
      card.appendChild(tags);
    }

    (balance.warnings || []).forEach(w => {
      const warn = document.createElement('div');
      warn.className = 'balance-card__warning';
      warn.textContent = '\u26a0\ufe0f ' + w;
      card.appendChild(warn);
    });

    messagesEl.appendChild(card);
  }

  /* ── Training Load (ATL / CTL / TSB) ── */

  function isTrainingLoadQuery(text) {
    return /\b(form|fitness|fatigue|fatigued|fresh|ctl|atl|tsb|training load|training stress|overtraining|burned.?out|race.?ready|peaked?|taper)\b/i.test(text);
  }

  function renderTrainingLoadCard(load) {
    if (!load || !load.history) return;

    const { ctl, atl, tsb, history } = load;

    let tsbLabel, tsbColor;
    if      (tsb >  10) { tsbLabel = 'Fresh';      tsbColor = '#60a5fa'; }
    else if (tsb >= -10) { tsbLabel = 'Optimal';    tsbColor = '#4ade80'; }
    else if (tsb >= -20) { tsbLabel = 'Productive'; tsbColor = '#fb923c'; }
    else                 { tsbLabel = 'Fatigued';   tsbColor = '#f87171'; }

    const card = document.createElement('div');
    card.className = 'tl-card';

    card.innerHTML =
      '<div class="tl-card__title">Training Load · 6-Week Trend</div>' +
      '<div class="tl-metrics">' +
        '<div class="tl-metric">' +
          '<span class="tl-metric__label">CTL</span>' +
          '<span class="tl-metric__value tl-metric__value--ctl">' + Math.round(ctl) + '</span>' +
          '<span class="tl-metric__sub">Fitness</span>' +
        '</div>' +
        '<div class="tl-metric">' +
          '<span class="tl-metric__label">ATL</span>' +
          '<span class="tl-metric__value tl-metric__value--atl">' + Math.round(atl) + '</span>' +
          '<span class="tl-metric__sub">Fatigue</span>' +
        '</div>' +
        '<div class="tl-metric">' +
          '<span class="tl-metric__label">TSB</span>' +
          '<span class="tl-metric__value" style="color:' + tsbColor + '">' + (tsb > 0 ? '+' : '') + Math.round(tsb) + '</span>' +
          '<span class="tl-metric__sub" style="color:' + tsbColor + '">' + tsbLabel + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="tl-chart">' + buildLoadChart(history) + '</div>' +
      '<div class="tl-legend">' +
        '<span class="tl-legend__item tl-legend__ctl">● CTL</span>' +
        '<span class="tl-legend__item tl-legend__atl">● ATL</span>' +
        '<span class="tl-legend__item tl-legend__tsb">● TSB</span>' +
      '</div>';

    messagesEl.appendChild(card);
  }

  function buildLoadChart(history) {
    if (!history || history.length < 2) return '';

    var W = 300, H = 90;
    var n = history.length;

    // Y range covering CTL, ATL, and TSB with padding
    var allVals = [];
    history.forEach(function(d) { allVals.push(d.ctl, d.atl, d.tsb); });
    var yMax = Math.max.apply(null, allVals.concat([10]));
    var yMin = Math.min.apply(null, allVals.concat([-5]));
    var pad  = (yMax - yMin) * 0.08;
    var top  = yMax + pad;
    var bot  = yMin - pad;
    var rng  = top - bot;

    function xv(i) { return (i / (n - 1)) * W; }
    function yv(v) { return H - ((v - bot) / rng) * H; }

    // Polyline point strings
    function ptStr(key) {
      return history.map(function(d, i) {
        return xv(i).toFixed(1) + ',' + yv(d[key]).toFixed(1);
      }).join(' ');
    }

    var zY = yv(0);
    var showZero = zY > 1 && zY < H - 1;

    // Zero line
    var zeroLine = showZero
      ? '<line x1="0" y1="' + zY.toFixed(1) + '" x2="' + W + '" y2="' + zY.toFixed(1) + '" stroke="rgba(255,255,255,0.12)" stroke-width="1" stroke-dasharray="3,3"/>'
      : '';

    // TSB filled area: use clipPath trick to split green/red at zero line
    var tsbPts = history.map(function(d, i) {
      return xv(i).toFixed(1) + ',' + yv(d.tsb).toFixed(1);
    }).join(' ');
    var polyPts = '0,' + zY.toFixed(1) + ' ' + tsbPts + ' ' + W + ',' + zY.toFixed(1);

    var uid = 'tl' + Date.now();
    var defs =
      '<defs>' +
        '<clipPath id="ca-' + uid + '">' +
          '<rect x="0" y="0" width="' + W + '" height="' + zY.toFixed(1) + '"/>' +
        '</clipPath>' +
        '<clipPath id="cb-' + uid + '">' +
          '<rect x="0" y="' + zY.toFixed(1) + '" width="' + W + '" height="' + (H - zY).toFixed(1) + '"/>' +
        '</clipPath>' +
      '</defs>';

    var fills =
      '<polygon points="' + polyPts + '" fill="rgba(74,222,128,0.18)" clip-path="url(#ca-' + uid + ')"/>' +
      '<polygon points="' + polyPts + '" fill="rgba(248,113,113,0.18)" clip-path="url(#cb-' + uid + ')"/>';

    var lines =
      '<polyline points="' + ptStr('ctl') + '" fill="none" stroke="#60a5fa" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<polyline points="' + ptStr('atl') + '" fill="none" stroke="#fb923c" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<polyline points="' + ptStr('tsb') + '" fill="none" stroke="rgba(163,163,163,0.65)" stroke-width="1" stroke-linejoin="round" stroke-linecap="round"/>';

    return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" height="' + H + '" preserveAspectRatio="none">' +
      defs + zeroLine + fills + lines +
    '</svg>';
  }

  /* ── Full markdown renderer (tables, headers, code blocks, lists) ── */
  function renderMarkdown(raw) {
    var lines    = raw.split('\n');
    var html     = '';
    var inCode   = false;
    var codeBuf  = [];
    var codeLang = '';
    var inTable  = false;
    var tableRows = []; // array of cell-arrays, or 'SEP' for separator rows

    function esc(s) {
      return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
    }

    function inline(s) {
      var e = esc(s);
      e = e.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      e = e.replace(/\*(.+?)\*/g,     '<em>$1</em>');
      e = e.replace(/`([^`]+)`/g,     '<code>$1</code>');
      return e;
    }

    function flushTable() {
      var valid = tableRows.filter(function(r) { return r !== 'SEP'; });
      tableRows = []; inTable = false;
      if (!valid.length) return;
      var headers = valid[0];
      var body    = valid.slice(1);
      var t = '<div class="md-table-wrap"><table><thead><tr>';
      headers.forEach(function(h) { t += '<th>' + inline(h.trim()) + '</th>'; });
      t += '</tr></thead><tbody>';
      body.forEach(function(row) {
        t += '<tr>';
        for (var i = 0; i < headers.length; i++) {
          t += '<td>' + inline((row[i] || '').trim()) + '</td>';
        }
        t += '</tr>';
      });
      t += '</tbody></table></div>';
      html += t;
    }

    function flushCode() {
      html += '<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>';
      codeBuf = []; codeLang = ''; inCode = false;
    }

    lines.forEach(function(line) {
      // ── Code fence ──
      if (line.startsWith('```')) {
        if (inCode) { flushCode(); return; }
        if (inTable) flushTable();
        inCode = true; codeLang = line.slice(3).trim(); return;
      }
      if (inCode) { codeBuf.push(line); return; }

      // ── Table row ──
      if (line.trimStart().startsWith('|')) {
        inTable = true;
        var parts = line.split('|');
        // strip leading/trailing empty strings from split
        if (parts[0].trim() === '') parts = parts.slice(1);
        if (parts[parts.length - 1].trim() === '') parts = parts.slice(0, -1);
        if (parts.every(function(c) { return /^[\s\-:]+$/.test(c); })) {
          tableRows.push('SEP');
        } else {
          tableRows.push(parts);
        }
        return;
      }
      if (inTable) flushTable();

      // ── Blank line ──
      if (line.trim() === '') { html += '<div class="md-br"></div>'; return; }

      // ── Horizontal rule ──
      if (/^[-_*]{3,}\s*$/.test(line.trim())) { html += '<hr class="md-hr">'; return; }

      // ── Headers ──
      if (line.startsWith('### ')) { html += '<div class="md-h3">' + inline(line.slice(4))  + '</div>'; return; }
      if (line.startsWith('## '))  { html += '<div class="md-h2">' + inline(line.slice(3))  + '</div>'; return; }
      if (line.startsWith('# '))   { html += '<div class="md-h1">' + inline(line.slice(2))  + '</div>'; return; }

      // ── Numbered list ──
      var numM = line.match(/^(\d+)\.\s+(.*)/);
      if (numM) {
        html += '<div class="md-li"><span class="md-li-num">' + esc(numM[1]) + '.</span> ' + inline(numM[2]) + '</div>';
        return;
      }

      // ── Bullet list ──
      if (/^[-*•]\s/.test(line)) {
        html += '<div class="md-li">' + inline(line.replace(/^[-*•]\s+/, '')) + '</div>';
        return;
      }

      // ── Paragraph ──
      html += '<div class="md-p">' + inline(line) + '</div>';
    });

    if (inCode)  flushCode();
    if (inTable) flushTable();

    return html;
  }

  /* ── Utilities ── */
  function scrollToBottom() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function formatTime(date) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }

  // Initial scroll
  scrollToBottom();
})();
