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
      return JSON.parse(localStorage.getItem(MEMORY_KEY)) ||
        { goals: [], prs: [], injuries: [], notes: [] };
    } catch (_) {
      return { goals: [], prs: [], injuries: [], notes: [] };
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
      saveMemory({ goals: [], prs: [], injuries: [], notes: [] });
      renderMemoryModal();
    }
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
      const res = await fetch('/.netlify/functions/chat', {
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
    const group = document.createElement('div');
    group.className = 'msg-group msg-group--user';

    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble--user';
    bubble.textContent = text;

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date());

    group.appendChild(bubble);
    group.appendChild(time);
    messagesEl.appendChild(group);
    scrollToBottom();
  }

  function appendBotMessage(text, isError = false) {
    const group = document.createElement('div');
    group.className = 'msg-group msg-group--bot';

    const bubble = document.createElement('div');
    bubble.className = 'bubble bubble--bot';
    if (isError) bubble.style.borderColor = 'rgba(255,69,58,0.4)';

    // Render markdown-lite: bold, line breaks
    bubble.innerHTML = renderMarkdownLite(text);

    const time = document.createElement('div');
    time.className = 'msg-time';
    time.textContent = formatTime(new Date());

    group.appendChild(bubble);
    group.appendChild(time);
    messagesEl.appendChild(group);
    scrollToBottom();
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

  /* ── Minimal markdown renderer (no deps) ── */
  function renderMarkdownLite(text) {
    // Escape HTML first
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // **bold**
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // *italic*
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // `code`
    html = html.replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.1);padding:1px 4px;border-radius:4px;font-family:monospace;font-size:13px">$1</code>');

    // Numbered lists: lines starting with "1. " etc.
    html = html.replace(/^(\d+)\. (.+)$/gm, '<span style="display:block;padding-left:4px"><strong>$1.</strong> $2</span>');

    // Bullet lists: lines starting with "- " or "• "
    html = html.replace(/^[-•] (.+)$/gm, '<span style="display:block;padding-left:4px">• $1</span>');

    // Double newlines → paragraph break
    html = html.replace(/\n\n/g, '<br><br>');

    // Single newlines
    html = html.replace(/\n/g, '<br>');

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
