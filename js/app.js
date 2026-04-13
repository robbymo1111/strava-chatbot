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
        { goals: [], prs: [], injuries: [], notes: [], vdot: null, paces: null, raceInput: null },
        stored
      );
    } catch (_) {
      return { goals: [], prs: [], injuries: [], notes: [], vdot: null, paces: null, raceInput: null };
    }
  }

  function saveMemory(mem) {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(mem));
    updateMemoryDot();
  }

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
      saveMemory({
        goals:    update.goals    ?? current.goals,
        prs:      update.prs      ?? current.prs,
        injuries: update.injuries ?? current.injuries,
        notes:    update.notes    ?? current.notes,
      });
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
      saveMemory({ goals: [], prs: [], injuries: [], notes: [], vdot: null, paces: null, raceInput: null });
      renderMemoryModal();
    }
  });

  /* ── Tab switching ── */
  document.querySelectorAll('.mem-tab').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.mem-tab').forEach(function (b) { b.classList.remove('active'); });
      document.querySelectorAll('.mem-tab-panel').forEach(function (p) { p.hidden = true; });
      btn.classList.add('active');
      var panel = document.getElementById('tab-' + btn.dataset.tab);
      if (panel) panel.hidden = false;
      if (btn.dataset.tab === 'paces') renderVDOTTab();
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

    // Show saved results right away if available
    if (mem.vdot) renderVDOTResults(mem.vdot, mem.paces, mem.raceInput);

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
