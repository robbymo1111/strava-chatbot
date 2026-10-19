'use strict';

/**
 * Training dashboard.
 *
 * Renders the derived intelligence the Strava connector cannot compute:
 * load budget against the binding rule, gray-zone discipline, readiness
 * signals, block position, and Rule 5 strength compliance.
 *
 * Charts are hand-built SVG — single-series, one hue, threshold lines rather
 * than a second axis, and a hover tooltip on every mark. No chart library.
 */

(function () {
  var token = sessionStorage.getItem('strava_access_token');
  var root  = document.getElementById('root');
  var tip   = document.getElementById('tooltip');

  if (!token) {
    root.innerHTML = '<div class="err">Not signed in. <a href="/" style="color:inherit">Connect with Strava</a> first.</div>';
    return;
  }

  fetch('/api/brain?action=coach-dashboard&accessToken=' + encodeURIComponent(token))
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d.error) throw new Error(d.error);
      render(d);
    })
    .catch(function (e) {
      root.innerHTML = '<div class="err">Could not load the dashboard: ' + esc(e.message) + '</div>';
    });

  /* ── helpers ──────────────────────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function el(html) { var t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }

  function showTip(evt, text) {
    tip.textContent = text;
    tip.style.opacity = '1';
    var pad = 12, w = tip.offsetWidth, h = tip.offsetHeight;
    var x = Math.min(Math.max(evt.clientX - w / 2, pad), window.innerWidth - w - pad);
    var y = evt.clientY - h - pad;
    if (y < pad) y = evt.clientY + pad;
    tip.style.left = x + 'px'; tip.style.top = y + 'px';
  }
  function hideTip() { tip.style.opacity = '0'; }

  /* ── bar chart: one hue, optional threshold line, hover on every mark ─── */

  function barChart(opts) {
    var data = opts.data, n = data.length;
    if (!n) return '';

    // A real coordinate space, scaled uniformly. The first version used
    // preserveAspectRatio="none", which stretched the corner radii into pills
    // and squashed the axis labels into each other.
    var W = 340, H = opts.height || 110, PAD_B = 16;
    var plotH = H - PAD_B;
    var max = Math.max.apply(null, data.map(function (d) { return d.value; })
                                      .concat([opts.threshold || 0])) * 1.12 || 1;
    var gap = Math.min(6, 160 / n), bw = (W - gap * (n - 1)) / n;

    var bars = data.map(function (d, i) {
      var h = Math.max((d.value / max) * plotH, d.value > 0 ? 2 : 0);
      var x = i * (bw + gap);
      var r = Math.min(3, bw / 3, h / 2);
      return '<rect class="bar" x="' + x.toFixed(1) + '" y="' + (plotH - h).toFixed(1) +
             '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
             '" rx="' + r.toFixed(1) + '" fill="' + (d.color || 'var(--accent)') +
             '" data-tip="' + esc(d.tip) + '"></rect>';
    }).join('');

    var thresh = '';
    if (opts.threshold != null) {
      var ty = plotH - (opts.threshold / max) * plotH;
      thresh = '<line class="thresh-line" x1="0" x2="' + W + '" y1="' + ty.toFixed(1) +
               '" y2="' + ty.toFixed(1) + '"></line>';
    }

    // Thin the labels until they fit, so they never collide.
    var step = Math.max(1, Math.ceil(n / Math.floor(W / 34)));
    var labels = data.map(function (d, i) {
      if (!d.label) return '';
      if (i % step !== 0 && i !== n - 1) return '';
      var x = i * (bw + gap) + bw / 2;
      return '<text class="axis-label" x="' + x.toFixed(1) + '" y="' + (plotH + 11) +
             '" text-anchor="middle">' + esc(d.label) + '</text>';
    }).join('');

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H +
           '" role="img" aria-label="' + esc(opts.aria || '') + '">' +
           thresh + bars + labels + '</svg>';
  }


  /* ── Progress ring — the headline. Shows the week as a proportion, with
       what you have run at the centre. ─────────────────────────────────── */
  function ring(opts) {
    var R = 54, C = 2 * Math.PI * R, pct = Math.max(0, Math.min(opts.pct, 1));
    var dash = (C * pct).toFixed(1) + ' ' + (C * (1 - pct)).toFixed(1);
    return '<svg viewBox="0 0 140 140" class="ring" role="img" aria-label="' + esc(opts.aria || '') + '">' +
      '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="var(--surface3)" stroke-width="11"></circle>' +
      '<circle cx="70" cy="70" r="' + R + '" fill="none" stroke="' + (opts.color || 'var(--accent)') +
        '" stroke-width="11" stroke-linecap="round" stroke-dasharray="' + dash +
        '" transform="rotate(-90 70 70)"></circle>' +
      '<text x="70" y="64" text-anchor="middle" class="ring-v">' + esc(opts.value) + '</text>' +
      '<text x="70" y="80" text-anchor="middle" class="ring-u">' + esc(opts.unit || '') + '</text>' +
      '<text x="70" y="95" text-anchor="middle" class="ring-k">' + esc(opts.caption || '') + '</text>' +
      '</svg>';
  }

  function feedbackCards(list) {
    if (!list || !list.length) return '';
    return list.map(function (c) {
      return '<div class="fb fb-' + esc(c.tone) + '">' +
             '<div class="fb-t">' + esc(c.title) + '</div>' +
             '<div class="fb-b">' + esc(c.body) + '</div></div>';
    }).join('');
  }

  function wireTips(scope) {
    scope.querySelectorAll('[data-tip]').forEach(function (nd) {
      nd.addEventListener('mousemove', function (e) { showTip(e, nd.getAttribute('data-tip')); });
      nd.addEventListener('mouseleave', hideTip);
      nd.addEventListener('touchstart', function (e) {
        showTip(e.touches[0], nd.getAttribute('data-tip'));
        setTimeout(hideTip, 2200);
      }, { passive: true });
    });
  }

  /* ── render ───────────────────────────────────────────────────────────── */

  function render(d) {
    var html = '';

    /* Hero — the week as a ring, the way Kaizen leads. What you have run is
       the number; the race countdown is the context around it. */
    var days = d.today.daysToRace;
    var lb0  = d.loadBudget || {};
    var wp0  = d.weekPlan;
    // The ring tracks the adaptive LOAD target, not the rule ceiling. The
    // ceiling is a limit; this is the goal.
    var pct  = wp0 ? wp0.pctComplete
             : (lb0.rampCeilingMi > 0 ? lb0.spentMi / lb0.rampCeilingMi : 0);
    var ringVal = wp0 ? (wp0.remainMi > 0 ? wp0.remainMi : 0) : lb0.spentMi;
    var ringCap = wp0 ? (wp0.remainMi > 0 ? 'left to run' : 'week banked') : 'run this week';

    html += '<header class="dash">' +
      '<div class="eyebrow">' + esc(d.block.name) + '</div>' +
      '<div class="hero-grid">' +
        ring({ pct: pct, value: ringVal, unit: 'miles', caption: ringCap,
               aria: 'Miles left against this week\'s adaptive load target' }) +
        '<div class="hero-side">' +
          '<div class="hero-days">' + (days >= 0 ? days : '—') + '<span>days to race</span></div>' +
          '<p class="hero-sub">' + esc(d.today.raceDateLong || d.block.raceDate) + '</p>' +
          '<p class="hero-meta">' + esc(d.today.long) + '<br>week ' + (d.today.blockWeek || '?') +
            ' of the block · goal ' + esc(d.block.target) + '</p>' +
        '</div>' +
      '</div></header>';

    /* Race projection — what the training actually points at */
    if (d.projection) {
      var pj = d.projection;
      html += '<section class="card proj"><h2>What you are on pace for</h2>' +
        '<div class="proj-range">' + esc(pj.range) + '</div>' +
        '<div class="proj-pace">' + esc(pj.fastPace) + ' – ' + esc(pj.slowPace) + '</div>' +
        '<p class="note">Anchored on <b style="color:var(--text)">' + esc(pj.basis) + ' ' +
        esc(pj.basisTime) + '</b>' + (pj.basisDate ? ' (' + esc(pj.basisDate) + ')' : '') +
        ', run in the heat. The range is that same fitness in cold December air — a ' +
        pj.adjustLoPct + '–' + pj.adjustHiPct + '% conditions gain, nothing more. ' +
        (pj.subThree
          ? 'The fast end breaks three hours. It assumes you hold the first half honestly.'
          : 'Breaking three would need fitness gains on top of conditions.') +
        '</p></section>';
    }

    /* Plain-language read, before any chart */
    if (d.feedback && d.feedback.length) {
      html += '<section class="card"><h2>What this means</h2>' + feedbackCards(d.feedback) + '</section>';
    }

    html += '<nav class="tabs">' +
      '<a href="https://claude.ai/new" target="_blank" rel="noopener">Ask your coach ↗</a>' +
      '</nav>';

    /* Load budget — the Kaizen idea: prescribe load, not sessions */
    var lb = d.loadBudget;
    var ceilPct = lb.rampCeilingMi > 0 ? Math.min(lb.spentMi / lb.rampCeilingMi * 100, 100) : 0;
    html += '<section class="card"><h2>Load budget · this week</h2>' +
      '<div class="budget"><div class="budget-track">' +
        '<div class="budget-fill" style="width:' + ceilPct.toFixed(1) + '%"></div>' +
        '<div class="budget-ceiling" style="left:calc(100% - 2px)" title="ramp ceiling"></div>' +
      '</div>' +
      '<div class="budget-legend"><span>' + lb.spentMi + ' mi run</span>' +
      '<span>ceiling ' + lb.rampCeilingMi + ' mi</span></div></div>' +
      '<div class="tiles" style="margin-top:16px">' +
        tile(lb.headroomMi != null ? lb.headroomMi + '<span style="font-size:13px;color:var(--text-sub)"> mi</span>' : '—', 'Headroom left') +
        tile(lb.trailing4wkAvgMiles + '<span style="font-size:13px;color:var(--text-sub)"> mi</span>', '4-week avg') +
        tile(lb.quality, 'Quality done') +
        tile(lb.hoursSinceQuality != null ? lb.hoursSinceQuality + '<span style="font-size:13px;color:var(--text-sub)">h</span>' : '—', 'Since quality') +
      '</div>' +
      (lb.bindingReason
        ? '<p class="note">Headroom is set by <b style="color:var(--text)">' +
          (lb.bindingRule === 'calf' ? 'the calf conjunction' : 'Rule ' + esc(lb.bindingRule)) +
          '</b> — ' + esc(lb.bindingReason) + '.</p>' : '') +
      '<p class="note">Sub-T: ' + (lb.subTMinutes != null
        ? lb.subTMinutes + ' min (' + lb.subTPct + '% of weekly time) against a 20–25% target'
        : 'unknown — no lap data cached for this week') + '.</p>' +
      '</section>';

    /* Weekly mileage — change over time, single series, ceiling as threshold */
    var wk = d.weeks.map(function (w) {
      return {
        value: w.miles,
        label: w.current ? 'now' : w.week.slice(5).replace('-', '/'),
        tip: w.week + '\n' + w.miles + ' mi · ' + w.minutes + ' min\n' + w.quality + ' quality',
        color: w.current ? 'var(--accent)' : 'var(--s-easy)',
      };
    });
    html += '<section class="card"><h2>Weekly volume · 9 weeks</h2>' +
      '<div id="wk-chart">' + barChart({ data: wk, height: 118, threshold: lb.rampCeilingMi,
        aria: 'Weekly running miles over the last nine weeks' }) + '</div>' +
      '<p class="note">Dashed line is the ramp ceiling (' + lb.rampCeilingMi +
      ' mi — 110% of the 4-week average). Current week in chartreuse.</p></section>';

    /* Gray zone — the flagship error metric */
    if (d.grayZone && d.grayZone.length) {
      var gz = d.grayZone.map(function (g) {
        return {
          value: g.grayPct,
          label: '',
          tip: g.date + '  ' + g.type + '\n' + g.name + '\n' + g.distMi + ' mi · ' +
               g.grayPct + '% gray · ' + g.easyPct + '% under 136',
          color: g.flagged ? 'var(--warn)' : 'var(--s-easy)',
        };
      });
      var flaggedCount = d.grayZone.filter(function (g) { return g.flagged; }).length;
      html += '<section class="card"><h2>Gray zone · last ' + d.grayZone.length + ' runs</h2>' +
        '<div id="gz-chart">' + barChart({ data: gz, height: 118, threshold: 10,
          aria: 'Percentage of each run spent at heart rate 136 to 152' }) + '</div>' +
        '<p class="note">Time at <b style="color:var(--text)">HR 136–152</b> as a share of each run. ' +
        'Amber bars are easy/long runs above the 10% line — the primary historical error. ' +
        'Quality sessions pass through this band by design and are not flagged.<br>' +
        '<b style="color:var(--warn)">' + flaggedCount + ' of ' + d.grayZone.length +
        '</b> flagged.</p></section>';
    }

    /* Readiness — status palette, icon + label, never colour alone */
    if (d.readiness) {
      var r = d.readiness;
      html += '<section class="card"><h2>Readiness</h2>' +
        '<div class="verdict ' + r.level + '">' +
        (r.level === 'good' ? '✓' : r.level === 'warning' ? '!' : '✕') + ' ' + esc(r.verdict) +
        ' · ' + r.count + ' of 5 signals</div>' +
        r.signals.map(function (s) {
          return '<div class="row"><span class="dot" style="background:' +
            (s.fired ? 'var(--bad)' : 'var(--ok)') + '"></span>' +
            '<span class="label">' + esc(s.label) + '</span>' +
            '<span class="val">' + esc(s.value) + '</span></div>';
        }).join('') + '</section>';
    }

    /* Training load */
    if (d.load) {
      html += '<section class="card"><h2>Training load</h2><div class="tiles">' +
        tile(d.load.ctl, 'CTL fitness') + tile(d.load.atl, 'ATL fatigue') +
        tile((d.load.tsb > 0 ? '+' : '') + d.load.tsb, 'TSB form') +
        tile(d.load.acwr != null ? d.load.acwr : '—', 'ACWR') +
        '</div></section>';
    }

    /* Rule 5 — strength. Untracked until now, and named as a Chicago failure point. */
    var st = d.strength;
    var strengthShort = st.sessionsThisWeek < st.gluteTarget;
    html += '<section class="card"><h2>Strength · Rule 5</h2><div class="tiles">' +
      tile('<span style="color:' + (strengthShort ? 'var(--bad)' : 'var(--ok)') + '">' +
           st.sessionsThisWeek + '</span>', 'Sessions this wk') +
      tile(st.gluteTarget + '×', 'Glute target') +
      tile(st.calfTarget + '×', 'Calf raise target') +
      tile(st.crossTraining.length, 'Cross-training') +
      '</div>' +
      (strengthShort
        ? '<p class="note" style="color:var(--warn)">Below the 2×/week glute target. ' +
          'Glutes were a named failure point at Chicago, and this is the first block where it is tracked at all. ' +
          'Only Strava-logged strength activities count — work done but not logged is invisible here.</p>'
        : '<p class="note">Meeting the standing target.</p>') +
      '</section>';

    /* Next key sessions */
    html += '<section class="card"><h2>Next key sessions</h2>' +
      (d.keySessions && d.keySessions.length
        ? d.keySessions.map(function (k) {
            var when = k.daysAway === 0 ? 'Today' : k.daysAway === 1 ? 'Tomorrow' : 'in ' + k.daysAway + ' days';
            return '<div class="sess"><div class="sess-when">' + esc(k.date) + ' · ' + esc(when) +
                   ' · ' + esc(k.type) + '</div><div class="sess-detail">' + esc(k.detail) + '</div></div>';
          }).join('')
        : '<div class="empty">No scheduled sessions ahead.</div>') +
      '</section>';

    /* Paces */
    if (d.block.paces) {
      var p = d.block.paces;
      var rows = [['Easy', 'easy'], ['Long run', 'longRun'], ['GRAY ZONE', 'grayZone'],
                  ['Marathon pace', 'mp'], ['Sub-T long', 'subTLong'], ['Sub-T short', 'subTShort'],
                  ['Threshold', 'threshold']];
      html += '<section class="card"><h2>Pace bands · MP ' + esc(d.block.mp) + '</h2><table class="paces">' +
        rows.map(function (row) {
          var b = p[row[1]]; if (!b) return '';
          var cls = row[1] === 'grayZone' ? ' class="gray-row"' : '';
          return '<tr' + cls + '><td>' + esc(row[0]) + '</td><td>' + esc(b.text) +
                 '/mi</td><td style="color:var(--text-sub)">HR ' + esc(b.hr) + '</td></tr>';
        }).join('') + '</table>' +
        '<p class="note">All bands cascade from marathon pace. Change MP and every band moves with it.</p></section>';
    }

    /* Waived rules — visible precisely because they are waived */
    if (d.rules && d.rules.configured && d.rules.configured.length) {
      html += '<section class="card"><h2>Waived rules</h2>' +
        d.rules.configured.map(function (o) {
          return '<div class="override"><b>Rule ' + esc(o.rule) + ' — waived' +
            (o.date ? ' ' + esc(o.date) : '') + '</b><br>' + esc(o.reason) + '</div>';
        }).join('') +
        '<p class="note">A waived rule still runs and still reports — it just stops blocking.</p></section>';
    }

    root.innerHTML = html;
    wireTips(root);
  }

  function tile(v, k) {
    return '<div class="tile"><div class="v">' + v + '</div><div class="k">' + esc(k) + '</div></div>';
  }
})();
