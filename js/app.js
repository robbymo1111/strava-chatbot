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
    headerName.textContent = athlete.firstname + "'s Coach";
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
    return text.replace(/<memory-update>[\s\S]*?<\/memory-update>/g, '').trim();
  }

  // Modal open/close
  function openMemoryModal() {
    renderMemoryModal();
    memoryModal.classList.add('open');
    memoryModal.setAttribute('aria-hidden', 'false');
    fetchDashboard(); // pre-warm cache so data is ready when user switches tabs
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

  function fetchDashboard(onComplete) {
    var now = Date.now();
    if (dashboardData && now - dashboardFetchedAt < 5 * 60 * 1000) {
      if (onComplete) onComplete();
      return;
    }
    var mem = loadMemory();
    var qs  = '?accessToken=' + encodeURIComponent(accessToken);
    if (mem.paces && mem.paces.threshold) {
      var threshMid = (mem.paces.threshold[0] + mem.paces.threshold[1]) / 2;
      qs += '&threshPaceMin=' + threshMid.toFixed(4);
    }
    if (mem.maxHR) qs += '&maxHR=' + mem.maxHR;
    fetch('/api/dashboard' + qs)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) return;
        dashboardData      = data;
        dashboardFetchedAt = Date.now();
        // Re-render active dashboard tab if open
        var active = document.querySelector('.mem-tab.active');
        if (active) {
          var t = active.dataset.tab;
          if      (t === 'weekly')   renderWeeklyTab();
          else if (t === 'load')     renderLoadTab();
          else if (t === 'fitness')  renderFitnessTab();
          else if (t === 'log')      renderLogTab();
          else if (t === 'raceprep') renderRacePrepTab();
          else if (t === 'gear')     renderGearTab();
        }
        renderWorkoutSuggestionCard();
        if (onComplete) onComplete();
      })
      .catch(function () {});
  }

  // Eager background fetch on load so workout card appears quickly
  fetchDashboard(function () {
    // After dashboard loads, kick off lap history sync in background
    scheduleLapSync();
  });

  /* ── Tab switching ── */
  document.querySelectorAll('.mem-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.mem-tab').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.mem-tab-panel').forEach(function (p) { p.hidden = true; });
      btn.classList.add('active');
      var panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.hidden = false;

      var tab = btn.dataset.tab;
      if (tab === 'paces')    renderVDOTTab();
      if (tab === 'weekly')   { renderWeeklyTab();   fetchDashboard(); }
      if (tab === 'load')     { renderLoadTab();     fetchDashboard(); }
      if (tab === 'fitness')  { renderFitnessTab();  fetchDashboard(); }
      if (tab === 'log')      { renderLogTab();      fetchDashboard(); }
      if (tab === 'raceprep') { renderRacePrepTab(); fetchDashboard(); }
      if (tab === 'gear')     { renderGearTab();     fetchDashboard(); }
    });
  });

  updateMemoryDot();

  /* ── Welcome message ── */
  const firstName = athlete.firstname ? `, ${athlete.firstname}` : '';
  appendBotMessage(
    `Hey${firstName}! 👋 I'm your AI running coach. I can see your recent Strava activities and help you understand your training.\n\nTry asking me something like the suggestions below, or ask me anything about your workouts.`,
    false
  );

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
      scrollToBottom();
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
      '<span class="msg__sender msg__sender--coach">● Coach</span>' +
      '<span class="msg__time">' + formatTime(new Date()) + '</span>';

    var content = document.createElement('div');
    content.className = 'msg__content md-content';
    content.innerHTML = renderMarkdown(text);

    msg.appendChild(meta);
    msg.appendChild(content);
    messagesEl.appendChild(msg);
    scrollToBottom();
  }

  /* ── VDOT calculator UI ── */
  function renderVDOTTab() {
    var V   = window.VDOT;
    var mem = loadMemory();
    var section = document.getElementById('vdot-section');
    section.innerHTML = '';

    // Build form
    var distOptions = Object.entries(V.DISTANCES).map(function (entry) {
      var label = entry[0], m = entry[1];
      var sel   = mem.raceInput && Math.abs(mem.raceInput.distM - m) < 1 ? ' selected' : '';
      return '<option value="' + m + '"' + sel + '>' + label + '</option>';
    }).join('');

    var saved  = mem.raceInput || {};
    var hVal   = saved.timeSec ? Math.floor(saved.timeSec / 3600) : '';
    var mVal   = saved.timeSec ? Math.floor((saved.timeSec % 3600) / 60) : '';
    var sVal   = saved.timeSec ? Math.round(saved.timeSec % 60) : '';

    section.innerHTML =
      '<div class="vdot-form">' +
        '<div class="vdot-form__row">' +
          '<label class="vdot-label">Distance</label>' +
          '<select id="vdot-dist" class="vdot-select">' + distOptions + '</select>' +
        '</div>' +
        '<div class="vdot-form__row">' +
          '<label class="vdot-label">Finish time</label>' +
          '<div class="vdot-time">' +
            '<input type="number" id="vdot-h" class="vdot-time-part" placeholder="H"  min="0" max="9"  value="' + hVal + '">' +
            '<span class="vdot-colon">:</span>' +
            '<input type="number" id="vdot-m" class="vdot-time-part" placeholder="MM" min="0" max="59" value="' + mVal + '">' +
            '<span class="vdot-colon">:</span>' +
            '<input type="number" id="vdot-s" class="vdot-time-part" placeholder="SS" min="0" max="59" value="' + sVal + '">' +
          '</div>' +
        '</div>' +
        '<button id="vdot-calc-btn" class="vdot-calc-btn">Calculate</button>' +
      '</div>' +
      '<div id="vdot-results"></div>';

    // Show saved results — always recalculate paces from the VDOT score so
    // stale stored values (e.g. from a previous bug) are never displayed.
    if (mem.vdot) {
      var freshPaces = V.trainingPaces(mem.vdot);
      // If stored paces are missing or stale, correct them in memory
      if (!mem.paces || Math.abs((mem.paces.easy[0] || 0) - freshPaces.easy[0]) > 0.5) {
        var corrected = Object.assign({}, mem, {
          paces: { easy: freshPaces.easy, marathon: freshPaces.marathon,
                   threshold: freshPaces.threshold, interval: freshPaces.interval, rep: freshPaces.rep }
        });
        saveMemory(corrected);
      }
      renderVDOTResults(mem.vdot, freshPaces, mem.raceInput);
    }

    document.getElementById('vdot-calc-btn').addEventListener('click', function () {
      var distM   = parseFloat(document.getElementById('vdot-dist').value);
      var h       = parseInt(document.getElementById('vdot-h').value)  || 0;
      var m       = parseInt(document.getElementById('vdot-m').value)  || 0;
      var s       = parseInt(document.getElementById('vdot-s').value)  || 0;
      var timeSec = h * 3600 + m * 60 + s;

      if (!timeSec || !distM) {
        alert('Please enter both a distance and a finish time.');
        return;
      }

      var vdot  = V.calculate(distM, timeSec);
      var paces = V.trainingPaces(vdot);

      // Find label
      var distLabel = Object.entries(V.DISTANCES).find(function (e) {
        return Math.abs(e[1] - distM) < 1;
      });
      distLabel = distLabel ? distLabel[0] : 'Race';

      // Persist to memory (paces stored as [lo, hi] arrays of min/mile numbers)
      var currentMem = loadMemory();
      currentMem.vdot  = Math.round(vdot * 10) / 10;
      currentMem.paces = {
        easy:      paces.easy,
        marathon:  paces.marathon,
        threshold: paces.threshold,
        interval:  paces.interval,
        rep:       paces.rep,
      };
      currentMem.raceInput = { distLabel: distLabel, distM: distM, timeSec: timeSec };
      saveMemory(currentMem);

      renderVDOTResults(vdot, currentMem.paces, currentMem.raceInput);
    });
  }

  function renderVDOTResults(vdot, paces, raceInput) {
    var V       = window.VDOT;
    var results = document.getElementById('vdot-results');
    if (!results) return;

    var paceZones = [
      { label: 'Easy',      key: 'easy',      color: '#30d158' },
      { label: 'Marathon',  key: 'marathon',  color: '#0b84fe' },
      { label: 'Threshold', key: 'threshold', color: '#ff9f0a' },
      { label: 'Interval',  key: 'interval',  color: '#ff453a' },
      { label: 'Rep',       key: 'rep',       color: '#bf5af2' },
    ];

    var predDistances = [
      { label: '1 Mile',        distM: 1609.34  },
      { label: '5K',            distM: 5000     },
      { label: '10K',           distM: 10000    },
      { label: 'Half Marathon', distM: 21097.5  },
      { label: 'Marathon',      distM: 42195    },
    ];

    var sourceStr = raceInput
      ? ' <span class="vdot-score__source">from ' + raceInput.distLabel + ' ' + V.fmtTime(raceInput.timeSec) + '</span>'
      : '';

    var pacesHTML = paceZones.map(function (z) {
      var lo  = paces[z.key][0];
      var hi  = paces[z.key][1];
      var rng = V.fmtPace(lo) === V.fmtPace(hi)
        ? V.fmtPace(lo)
        : V.fmtPace(lo) + '–' + V.fmtPace(hi);
      return '<div class="vdot-pace-row">' +
        '<span class="vdot-pace-label" style="color:' + z.color + '">' + z.label + '</span>' +
        '<span class="vdot-pace-value">' + rng + '/mi</span>' +
      '</div>';
    }).join('');

    var predsHTML = predDistances.map(function (p) {
      var tSec    = V.predictTime(vdot, p.distM);
      var miles   = p.distM / 1609.34;
      var minMile = (tSec / 60) / miles;
      return '<div class="vdot-pace-row">' +
        '<span class="vdot-pace-label">' + p.label + '</span>' +
        '<span class="vdot-pace-value">' + V.fmtTime(tSec) +
          ' <span class="vdot-pace-sub">(' + V.fmtPace(minMile) + '/mi)</span>' +
        '</span>' +
      '</div>';
    }).join('');

    results.innerHTML =
      '<div class="vdot-score">' +
        '<div class="vdot-score__left">' +
          '<span class="vdot-score__label">VDOT</span>' +
          '<span class="vdot-score__value">' + vdot.toFixed(1) + '</span>' +
        '</div>' +
        sourceStr +
      '</div>' +
      '<div class="vdot-section-label">Training Paces</div>' +
      '<div class="vdot-paces">' + pacesHTML + '</div>' +
      '<div class="vdot-section-label">Race Predictions</div>' +
      '<div class="vdot-paces">' + predsHTML + '</div>';
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

  // ── Weekly Summary ──────────────────────────────────────────────────────
  function renderWeeklyTab() {
    var el = document.getElementById('tab-weekly-content');
    if (!el) return;
    if (!dashboardData) { el.innerHTML = '<div class="tab-loading">Loading…</div>'; return; }

    var s = dashboardData.weeklyStats;
    var b = dashboardData.weeklyBalance;

    var tagDefs = [
      { key: 'easy', cls: 'easy', label: 'Easy' },
      { key: 'long', cls: 'long', label: 'Long' },
      { key: 'tempo', cls: 'tempo', label: 'Tempo' },
      { key: 'workout', cls: 'workout', label: 'Workout' },
      { key: 'recovery', cls: 'recovery', label: 'Recovery' },
      { key: 'race', cls: 'race', label: 'Race' },
    ];
    var tags = tagDefs
      .filter(function (t) { return (b[t.key] || 0) > 0; })
      .map(function (t) {
        return '<span class="run-tag run-tag--' + t.cls + '">' + b[t.key] + '\u00a0' + t.label + '</span>';
      }).join('');

    var warnings = (b.warnings || [])
      .map(function (w) { return '<div class="tab-warning">\u26a0\ufe0f ' + w + '</div>'; })
      .join('');

    var rec = getWeeklyRec(b, s);

    el.innerHTML =
      '<div class="tab-stat-row">' +
        '<div class="tab-stat"><div class="tab-stat__val">' + s.totalMiles.toFixed(1) + '</div><div class="tab-stat__lbl">miles</div></div>' +
        '<div class="tab-stat"><div class="tab-stat__val">' + fmtDuration(s.totalTimeMin) + '</div><div class="tab-stat__lbl">time</div></div>' +
        '<div class="tab-stat"><div class="tab-stat__val">+' + s.totalElevFt.toLocaleString() + '</div><div class="tab-stat__lbl">ft elev</div></div>' +
      '</div>' +
      (s.runCount === 0 ? '<div class="tab-empty">No runs logged in the last 7 days.</div>' : '') +
      (tags ? '<div class="tab-tags">' + tags + '</div>' : '') +
      warnings +
      (rec ? '<div class="tab-rec">' + rec + '</div>' : '');
  }

  function getWeeklyRec(b, s) {
    var total = b.total || 0;
    if (total === 0) return '\uD83D\uDCA1 No runs this week — lace up and get moving.';
    if (b.quality > 2) return '\uD83D\uDCA1 High intensity load this week. Prioritize easy miles and recovery next week.';
    if (total >= 4 && !b.long) return '\uD83D\uDCA1 Consider adding a long run next week to build aerobic base.';
    if (b.quality === 0 && total >= 4) return '\uD83D\uDCA1 All easy miles — ready to add one quality session next week.';
    if (total >= 4 && b.long >= 1 && b.quality <= 2) return '\uD83D\uDCA1 Solid week. Maintain consistency and keep building gradually.';
    return '\uD83D\uDCA1 Good week of training. Stay consistent.';
  }

  // ── Training Load ───────────────────────────────────────────────────────
  function renderLoadTab() {
    var el = document.getElementById('tab-load-content');
    if (!el) return;
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

    el.innerHTML =
      '<div class="tl-metrics">' +
        '<div class="tl-metric"><span class="tl-metric__label">CTL</span><span class="tl-metric__value tl-metric__value--ctl">' + Math.round(ctl) + '</span><span class="tl-metric__sub">Fitness</span></div>' +
        '<div class="tl-metric"><span class="tl-metric__label">ATL</span><span class="tl-metric__value tl-metric__value--atl">' + Math.round(atl) + '</span><span class="tl-metric__sub">Fatigue</span></div>' +
        '<div class="tl-metric"><span class="tl-metric__label">TSB</span><span class="tl-metric__value" style="color:' + tsbColor + '">' + (tsb > 0 ? '+' : '') + Math.round(tsb) + '</span><span class="tl-metric__sub" style="color:' + tsbColor + '">' + tsbLabel + '</span></div>' +
      '</div>' +
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

    var V   = window.VDOT;
    var mem = loadMemory();

    if (!mem.vdot) {
      el.innerHTML = '<div class="tab-empty">Enter a race time in the Paces tab to unlock fitness predictions.</div>';
      return;
    }

    var vdot  = mem.vdot;
    var preds = [
      { label: 'Marathon',      distM: 42195   },
      { label: 'Half Marathon', distM: 21097.5 },
      { label: '10K',           distM: 10000   },
      { label: '5K',            distM: 5000    },
      { label: '1 Mile',        distM: 1609.34 },
    ];

    var predsHTML = preds.map(function (p) {
      var tSec   = V.predictTime(vdot, p.distM);
      var minMi  = (tSec / 60) / (p.distM / 1609.34);
      return '<div class="vdot-pace-row">' +
        '<span class="vdot-pace-label">' + p.label + '</span>' +
        '<span class="vdot-pace-value">' + V.fmtTime(tSec) +
          ' <span class="vdot-pace-sub">(' + V.fmtPace(minMi) + '/mi)</span></span>' +
      '</div>';
    }).join('');

    // Confidence
    var runCount = dashboardData ? (dashboardData.weeklyStats.runCount || 0) : 0;
    var confLevel = runCount >= 5 ? 'HIGH' : runCount >= 2 ? 'MEDIUM' : 'LOW';
    var confColor = confLevel === 'HIGH' ? '#4ade80' : confLevel === 'MEDIUM' ? '#fb923c' : '#f87171';

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

    var source = mem.raceInput
      ? 'VDOT\u00a0' + vdot.toFixed(1) + '\u00a0\u00b7\u00a0from\u00a0' + mem.raceInput.distLabel + '\u00a0' + V.fmtTime(mem.raceInput.timeSec)
      : 'VDOT\u00a0' + vdot.toFixed(1);

    el.innerHTML =
      '<div class="tab-vdot-badge">' + source + '</div>' +
      '<div class="tab-conf-row">Confidence <span style="color:' + confColor + ';font-weight:700">' + confLevel + '</span></div>' +
      '<div class="vdot-section-label" style="margin-top:14px">Race Predictions</div>' +
      '<div class="vdot-paces">' + predsHTML + '</div>' +
      trendHTML;

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

  // ── Workout Log ─────────────────────────────────────────────────────────
  function renderLogTab() {
    var el = document.getElementById('tab-log-content');
    if (!el) return;
    if (!dashboardData) { el.innerHTML = '<div class="tab-loading">Loading…</div>'; return; }

    var acts = dashboardData.activities || [];
    if (!acts.length) { el.innerHTML = '<div class="tab-empty">No activities in the last 30 days.</div>'; return; }

    var rows = acts.map(function (a) {
      var tagCls = CLS_TAG[a.classification];
      var tagHTML = tagCls
        ? '<span class="run-tag run-tag--' + tagCls + '">' + a.classification + '</span>'
        : (a.type ? '<span class="log-type">' + a.type + '</span>' : '');

      var stats = '';
      if (a.distMi)      stats += '<span class="log-stat">' + a.distMi.toFixed(1) + 'mi</span>';
      if (a.pace)        stats += '<span class="log-stat">' + a.pace + '/mi</span>';
      if (a.avgHR)       stats += '<span class="log-stat">\u2665\u00a0' + a.avgHR + '</span>';
      if (a.durationMin) stats += '<span class="log-stat">' + a.durationMin + 'min</span>';

      return '<div class="log-row">' +
        '<div class="log-row__head">' +
          '<span class="log-row__date">' + a.date + '</span>' + tagHTML +
        '</div>' +
        '<div class="log-row__name">' + a.name + '</div>' +
        (stats ? '<div class="log-row__stats">' + stats + '</div>' : '') +
      '</div>';
    }).join('');

    el.innerHTML = rows;
  }

  // ── Race Prep / Taper Calculator ────────────────────────────────────────
  function renderRacePrepTab() {
    var el = document.getElementById('tab-raceprep-content');
    if (!el) return;

    var load  = dashboardData && dashboardData.trainingLoad;
    var stats = dashboardData && dashboardData.weeklyStats;

    el.innerHTML =
      '<div class="taper-form">' +
        '<label class="vdot-label" for="race-dist-select">Race distance</label>' +
        '<select id="race-dist-select" class="taper-date-input">' +
          '<option value="5k">5K</option>' +
          '<option value="10k">10K</option>' +
          '<option value="half">Half Marathon</option>' +
          '<option value="marathon" selected>Marathon</option>' +
        '</select>' +
        '<label class="vdot-label" for="race-date-input">Race date</label>' +
        '<input type="date" id="race-date-input" class="taper-date-input">' +
        '<button id="taper-calc-btn" class="vdot-calc-btn">Calculate Taper</button>' +
      '</div>' +
      '<div id="taper-results"></div>';

    document.getElementById('taper-calc-btn').addEventListener('click', function () {
      var dateVal  = document.getElementById('race-date-input').value;
      var raceDist = document.getElementById('race-dist-select').value;
      if (!dateVal) { alert('Please select a race date.'); return; }
      var raceDate   = new Date(dateVal + 'T12:00:00');
      var today      = new Date();
      var daysToRace = Math.round((raceDate - today) / (1000 * 60 * 60 * 24));
      var weeklyMi   = stats ? stats.totalMiles : null;
      var ctl        = load  ? load.ctl : null;
      renderTaperResults(daysToRace, weeklyMi, ctl, raceDist);
    });
  }

  /**
   * Distance-specific taper logic based on Daniels/Pfitzinger principles:
   *   5K    — 7–10 days, minimal volume cut, keep intensity
   *   10K   — 10–14 days (2 weeks), −20% / −30%
   *   Half  — 2 weeks, −20% / −40%
   *   Marathon — 3 weeks, −20% / −40% / −60% with long run targets
   */
  function renderTaperResults(daysToRace, weeklyMiles, ctl, raceDist) {
    var el = document.getElementById('taper-results');
    if (!el) return;

    if (daysToRace < 0) {
      el.innerHTML = '<div class="tab-empty">That date has already passed.</div>'; return;
    }

    // Race-week final advice by distance
    if (daysToRace < 7) {
      var raceWeekTips = {
        '5k':       '3\u20134 short runs this week. Strides Wed/Thu at race pace. Rest the day before. Trust your speed.',
        '10k':      '3 runs this week. One set of 4\u00d7400m at race pace Tue/Wed. Rest 2 days before.',
        'half':     '3\u20134 easy runs. 2\u20133 mi at half marathon pace Wednesday. Rest Thursday/Saturday.',
        'marathon': '2\u20133 short easy runs. 2\u20133 strides Tue/Thu. Rest Friday\u2013Saturday. You\u2019re ready.',
      };
      var tip = raceWeekTips[raceDist] || raceWeekTips.marathon;
      el.innerHTML =
        '<div class="taper-race-week">' +
          '<div class="taper-race-week__label">Race Week!</div>' +
          '<div class="taper-race-week__detail">' + tip + '</div>' +
        '</div>';
      return;
    }

    // Base volume from last week (or CTL proxy)
    var baseMi = weeklyMiles && weeklyMiles > 5 ? weeklyMiles : (ctl ? Math.round(ctl * 0.6) : 30);

    // Distance-specific taper plans
    var distLabels = { '5k': '5K', '10k': '10K', 'half': 'Half Marathon', 'marathon': 'Marathon' };
    var plans = {
      '5k': {
        minDays: 7,
        weeks: [
          { label: 'This week', factor: 0.85, pct: 15,
            quality: '1 quality session — 6\u00d7400m at 5K pace, fresh legs for race day' },
        ],
        tip: 'Short taper for a short race. Keep your legs sharp — one quality session, then ease off. A week of light running makes you faster, not slower.',
      },
      '10k': {
        minDays: 10,
        weeks: [
          { label: 'Now (week\u00a01)', factor: 0.80, pct: 20,
            quality: 'One tempo — 3\u00d71mi at 10K pace with full recovery' },
          { label: 'Race week', factor: 0.50, pct: 50,
            quality: '4\u00d7400m at race pace Tuesday, rest 2 days before race' },
        ],
        tip: 'Two-week 10K taper. Cut volume but keep one quality session each week to stay sharp.',
      },
      'half': {
        minDays: 14,
        weeks: daysToRace >= 14
          ? [
              { label: 'Now (week\u00a01)', factor: 0.80, pct: 20,
                quality: 'One tempo — 3\u00d71mi at half marathon pace, or 40 min steady tempo' },
              { label: 'Race week', factor: 0.55, pct: 45,
                quality: '2\u20133 mi at HM goal pace Wednesday, rest Thursday\u2013Saturday' },
            ]
          : [
              { label: 'This week', factor: 0.65, pct: 35,
                quality: '2\u00d71mi at HM pace, keep it controlled' },
            ],
        longRun: daysToRace >= 14 ? '8\u201310 mi long run this week' : null,
        tip: 'Preserve your aerobic engine. Long run stays (shorter). One quality session. Race week is mostly easy with a short tune-up.',
      },
      'marathon': {
        minDays: 21,
        weeks: daysToRace >= 21
          ? [
              { label: 'Now (3 wks out)', factor: 0.80, pct: 20,
                quality: 'One quality session — 2\u00d72mi at marathon pace',
                longRun: '16\u201318 mi long run' },
              { label: '2 weeks out',     factor: 0.60, pct: 40,
                quality: 'One short tempo (20 min), no long intervals',
                longRun: '12\u201314 mi long run' },
              { label: 'Race week',       factor: 0.40, pct: 60,
                quality: 'Race-pace strides only, rest 2 days before race',
                longRun: '8\u201310 mi final long run Sunday/Monday' },
            ]
          : daysToRace >= 14
          ? [
              { label: 'Now (2 wks out)', factor: 0.70, pct: 30,
                quality: 'One short tempo (20 min), no long intervals',
                longRun: '12\u201314 mi long run' },
              { label: 'Race week',       factor: 0.45, pct: 55,
                quality: 'Race-pace strides Tue/Thu, full rest Fri\u2013Sat',
                longRun: '8\u201310 mi early in the week' },
            ]
          : [
              { label: 'This week',       factor: 0.60, pct: 40,
                quality: 'Easy miles only — it\u2019s too late to gain fitness',
                longRun: '10\u201312 mi — no more' },
            ],
        tip: 'The fitness is already built. These miles are just maintenance. Resist the urge to squeeze in extra work — the taper restores glycogen and repairs micro-damage.',
      },
    };

    var plan = plans[raceDist] || plans.marathon;

    var rowsHTML = plan.weeks.map(function (w) {
      var mi = Math.round(baseMi * w.factor * 10) / 10;
      return '<div class="taper-row">' +
        '<div class="taper-row__header">' +
          '<span class="taper-row__week">' + w.label + '</span>' +
          '<span class="taper-row__miles">' + mi.toFixed(1) + '\u00a0mi</span>' +
          '<span class="taper-row__pct">\u2193' + w.pct + '%</span>' +
        '</div>' +
        '<div class="taper-row__quality">' + w.quality + '</div>' +
        (w.longRun ? '<div class="taper-row__longrn">\uD83C\uDFC3\u00a0' + w.longRun + '</div>' : '') +
      '</div>';
    }).join('');

    var distLabel = distLabels[raceDist] || 'Race';

    el.innerHTML =
      '<div class="taper-header">' +
        '<span class="taper-days">' + daysToRace + '</span>' +
        '<span class="taper-days-label">days to ' + distLabel + '</span>' +
      '</div>' +
      '<div class="taper-base">Base: ' + baseMi.toFixed(1) + '\u00a0mi/wk \u00b7 ' + plan.weeks.length + '-week taper</div>' +
      rowsHTML +
      '<div class="taper-tip">' + plan.tip + '</div>';
  }

  // ── Gear / Shoe Tracker ──────────────────────────────────────────────────
  function renderGearTab() {
    var el = document.getElementById('tab-gear-content');
    if (!el) return;

    var shoes = dashboardData && dashboardData.shoes;
    if (!shoes) { el.innerHTML = '<div class="tab-loading">Loading\u2026</div>'; return; }
    if (!shoes.length) {
      el.innerHTML =
        '<div class="tab-empty">No shoes found on your Strava account.</div>' +
        '<div class="tab-rec">To track shoes, go to <strong>strava.com → Settings → My Gear</strong> and add your shoes there. They\'ll appear here after your next sync.</div>';
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

  // ── Tomorrow's Workout card ───────────────────────────────────────────────
  var workoutCardShown = false;

  function generateWorkoutSuggestion() {
    var load    = dashboardData && dashboardData.trainingLoad;
    var balance = dashboardData && dashboardData.weeklyBalance;
    var mem     = loadMemory();
    if (!load) return null;

    var tsb     = load.tsb    || 0;
    var ctl     = load.ctl    || 0;
    var paces   = mem.paces;
    var total   = (balance && balance.total)   || 0;
    var quality = (balance && balance.quality) || 0;
    var long    = (balance && balance.long)    || 0;

    // ── Day-of-week logic ──────────────────────────────────────────────────
    var todayDow    = new Date().getDay();                // 0=Sun, 1=Mon ... 6=Sat
    var tomorrowDow = (todayDow + 1) % 7;
    var longRunDay  = (mem.longRunDay !== undefined && mem.longRunDay !== null) ? mem.longRunDay : 0;
    var hardDays    = mem.hardDays || [2, 4];             // default: Tue, Thu
    var dayBefore   = (longRunDay + 6) % 7;              // rest/easy day before long run

    // 14-day lookback for hard-session count (more accurate than 7-day for planning)
    var acts         = (dashboardData && dashboardData.activities) || [];
    var fourteenAgo  = Date.now() - 14 * 24 * 60 * 60 * 1000;
    var recentHard14 = acts.filter(function(a) {
      return a.ts && a.ts > fourteenAgo &&
        (a.classification === 'Workout' || a.classification === 'Tempo Run' || a.classification === 'Race');
    }).length;

    // Check if long run was done in last 14 days
    var recentLong14 = acts.filter(function(a) {
      return a.ts && a.ts > fourteenAgo && a.classification === 'Long Run';
    }).length;

    function fp(v) {
      var m = Math.floor(v), s = Math.round((v - m) * 60);
      return m + ':' + String(s).padStart(2, '0');
    }
    function rng(arr) { return fp(arr[0]) + '\u2013' + fp(arr[1]); }

    var result;

    // ── Priority 1: Deep fatigue → rest regardless of day ──
    if (tsb < -25) {
      result = { emoji: '\uD83D\uDECC', title: 'Complete Rest Day',
        detail: 'TSB is ' + Math.round(tsb) + ' \u2014 deep fatigue. Full rest or light cross-training only.',
        shoeType: null };

    // ── Priority 2: Day before long run → easy/rest to be fresh ──
    } else if (tomorrowDow === longRunDay && tsb > -15) {
      var lrMi = Math.max(8, Math.round(ctl * 0.35));
      var lrPace = paces ? rng(paces.easy) + '/mi' : 'easy pace';
      result = { emoji: '\uD83C\uDFC3', title: lrMi + '-Mile Long Run',
        detail: lrMi + ' mi at ' + lrPace + '. Stay conversational. This is your long run day.',
        shoeType: 'long' };

    // ── Priority 3: Today is day before long run → go easy ──
    } else if (todayDow === dayBefore) {
      var ep0 = paces ? rng(paces.easy) + '/mi' : 'easy pace';
      result = { emoji: '\uD83D\uDEB6', title: 'Easy Shakeout',
        detail: '20\u201330 min at ' + ep0 + '. Tomorrow is your long run \u2014 save your legs.',
        shoeType: 'daily' };

    // ── Priority 4: High fatigue or too many quality sessions ──
    } else if (tsb < -15 || quality >= 3 || recentHard14 >= 4) {
      var ep = paces ? rng(paces.easy) + '/mi' : 'conversational pace';
      result = { emoji: '\uD83D\uDEB6', title: 'Easy Recovery Run',
        detail: '30\u201340 min at ' + ep + '. HR in easy zone. No hard efforts.',
        shoeType: 'daily' };

    // ── Priority 5: Hard day (Tue/Thu default) + TSB allows it ──
    } else if (hardDays.indexOf(tomorrowDow) !== -1 && tsb >= -10 && recentHard14 < 3) {
      if (recentHard14 === 0 || (paces && paces.interval && tsb >= -5)) {
        // Intervals when fresh and no recent hard work
        if (paces && paces.interval) {
          result = { emoji: '\u26A1', title: '6\u00d7800m Intervals',
            detail: '6 \u00d7 800m at ' + fp(paces.interval[0]) + '/mi with 90s rest. 1.5mi warm-up, 1mi cool-down.',
            shoeType: 'tempo' };
        } else {
          result = { emoji: '\u26A1', title: 'Interval Session',
            detail: '6 \u00d7 800m hard effort with 90s standing rest. 10 min easy warm-up.',
            shoeType: 'tempo' };
        }
      } else {
        // Tempo when TSB is more moderate
        if (paces && paces.threshold) {
          result = { emoji: '\uD83D\uDD25', title: '20-Minute Tempo Run',
            detail: '2mi easy, 20 min at ' + rng(paces.threshold) + '/mi threshold, 1mi cool-down.',
            shoeType: 'tempo' };
        } else {
          result = { emoji: '\uD83D\uDD25', title: 'Tempo Run',
            detail: '2mi easy warm-up, 20 min comfortably hard (7\u20138/10), 1mi cool-down.',
            shoeType: 'tempo' };
        }
      }

    // ── Priority 6: Long run overdue and fitness base exists ──
    } else if (recentLong14 === 0 && total >= 2 && ctl >= 15) {
      var lrMi2 = Math.max(8, Math.round(ctl * 0.35));
      var ep2   = paces ? rng(paces.easy) + '/mi' : 'easy pace';
      result = { emoji: '\uD83C\uDFC3', title: lrMi2 + '-Mile Long Run',
        detail: lrMi2 + ' mi at ' + ep2 + '. No long run in 2 weeks \u2014 time to rebuild base.',
        shoeType: 'long' };

    // ── Default: easy run ──
    } else {
      var ep3 = paces ? rng(paces.easy) + '/mi' : 'easy pace';
      result = { emoji: '\uD83D\uDE0A', title: 'Easy Run',
        detail: '45\u201360 min at ' + ep3 + '. Relax and breathe.',
        shoeType: 'daily' };
    }

    // Shoe recommendation
    var shoes          = (dashboardData && dashboardData.shoes) || [];
    var shoeCategories = (mem.shoeCategories) || {};
    result.shoeRec = getShoeRec(shoes, shoeCategories, result.shoeType);
    return result;
  }

  function getShoeRec(shoes, cats, workoutType) {
    if (!shoes.length || !workoutType) return null;
    var prefs = { tempo: ['tempo', 'race'], long: ['long', 'daily'], daily: ['daily', 'long'], race: ['race', 'tempo'] };
    var order = prefs[workoutType] || ['daily'];
    var valid = shoes.filter(function (s) { return s.distanceMi < 500; });
    // Try preferred categories first
    for (var i = 0; i < order.length; i++) {
      var match = valid.filter(function (s) {
        return cats[s.id] === order[i] || cats[s.name] === order[i];
      });
      if (match.length) return match[0];
    }
    // Fall back to least worn shoe
    if (!valid.length) return null;
    return valid.slice().sort(function (a, b) { return a.distanceMi - b.distanceMi; })[0];
  }

  function renderWorkoutSuggestionCard() {
    if (workoutCardShown) return;
    var suggestion = generateWorkoutSuggestion();
    if (!suggestion) return;
    workoutCardShown = true;

    var card = document.createElement('div');
    card.className = 'workout-card';

    var shoeHTML = '';
    if (suggestion.shoeRec) {
      var warn = suggestion.shoeRec.miles >= 400;
      shoeHTML = '<div class="workout-card__shoe' + (warn ? ' workout-card__shoe-warn' : '') + '">' +
        '\uD83D\uDC9F\u00a0Wear: ' + suggestion.shoeRec.name + ' (' + suggestion.shoeRec.miles + '\u00a0mi)' +
        (warn ? ' \u2014 getting worn' : '') +
      '</div>';
    }

    card.innerHTML =
      '<div class="workout-card__label">Tomorrow\u2019s Workout</div>' +
      '<div class="workout-card__title">' + suggestion.emoji + '\u00a0' + suggestion.title + '</div>' +
      '<div class="workout-card__detail">' + suggestion.detail + '</div>' +
      shoeHTML;

    // Insert after the welcome message (first coach msg)
    var firstMsg = messagesEl.querySelector('.msg--coach');
    if (firstMsg && firstMsg.nextSibling) {
      messagesEl.insertBefore(card, firstMsg.nextSibling);
    } else {
      messagesEl.appendChild(card);
    }
    scrollToBottom();
  }

  /* ── Lap history sync ─────────────────────────────────────────────────────
     Retroactively analyzes the last 90 days of activities and caches lap data
     in Vercel KV so the AI coach has detailed workout pattern context.
     Runs once per 24 hours (or when forced). Progress shown as a dismissable
     card in the chat stream.
  ──────────────────────────────────────────────────────────────────────────── */

  var LAP_SYNC_KEY = 'lap_sync_at';

  function scheduleLapSync() {
    var lastSync = parseInt(localStorage.getItem(LAP_SYNC_KEY) || '0', 10);
    var oneDayMs = 24 * 60 * 60 * 1000;
    if (Date.now() - lastSync < oneDayMs) return; // already synced today
    if (!dashboardData || !dashboardData.activities) return;

    // Use all activities from dashboard (last 30 days with IDs)
    // plus a separate fetch for the older 60 days
    runLapSync();
  }

  async function runLapSync() {
    // Fetch 90 days of activity metadata from Strava (lightweight: just IDs + metadata)
    var since90 = Math.floor((Date.now() - 90 * 24 * 60 * 60 * 1000) / 1000);
    var allActivities = [];
    try {
      var r = await fetch(
        'https://www.strava.com/api/v3/athlete/activities?after=' + since90 + '&per_page=100',
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
    // Insert after workout card (or after first coach message)
    var workoutCard = document.querySelector('.workout-card');
    var insertAfter = workoutCard || messagesEl.querySelector('.msg--coach');
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
    scrollToBottom();
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
    scrollToBottom();
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
