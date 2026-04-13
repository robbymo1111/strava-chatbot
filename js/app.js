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
          history: history.slice(-8), // last 4 exchanges for context
          accessToken
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
      const reply = data.reply || '(No response)';

      history.push({ role: 'assistant', content: reply });
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
