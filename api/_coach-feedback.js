'use strict';

/**
 * PLAIN-LANGUAGE FEEDBACK
 *
 * Turns the derived numbers into sentences a runner can act on. CTL is not
 * "CTL", it is how fit you are. Gray zone is not a percentage, it is "you ran
 * your easy days too hard, here is what it cost you."
 *
 * Pure functions. Shared by the dashboard and the MCP server so the coach in
 * Claude chat says exactly what the dashboard says.
 */

/* ── time helpers ──────────────────────────────────────────────────────────── */

function fmtTime(sec) {
  sec = Math.round(sec);
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0
    ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
    : m + ':' + String(s).padStart(2, '0');
}
function parseTime(str) {
  if (typeof str === 'number') return str;
  if (typeof str !== 'string') return null;
  var p = str.trim().split(':').map(Number);
  if (p.some(function (n) { return !isFinite(n); })) return null;
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return null;
}
function paceOf(totalSec, miles) { return fmtTime(totalSec / miles) + '/mi'; }
function plural(n, one, many) { return n === 1 ? one : (many || one + 's'); }
function F_pace(minMi) {
  var m = Math.floor(minMi), sec = Math.round((minMi - m) * 60);
  if (sec === 60) { m += 1; sec = 0; }
  return m + ':' + String(sec).padStart(2, '0') + '/mi';
}

/* ── race projection ───────────────────────────────────────────────────────── */

/**
 * Project a marathon from the most recent one, correcting for conditions.
 *
 * Deliberately NOT a fitness model. It anchors on a real result the athlete
 * actually ran and applies only the heat correction from the knowledge base's
 * dewpoint table. Anything more would be inventing precision we do not have.
 *
 * @param {object} last  { timeSec, name, date, hot }
 * @param {object} opts  { adjustLoPct, adjustHiPct }  conditions gain
 */
function projectMarathon(last, opts) {
  if (!last || !last.timeSec) return null;
  var lo = (opts && opts.adjustLoPct != null) ? opts.adjustLoPct : 2;
  var hi = (opts && opts.adjustHiPct != null) ? opts.adjustHiPct : 4;

  var fast = last.timeSec * (1 - hi / 100);
  var slow = last.timeSec * (1 - lo / 100);

  return {
    basis:      last.name || 'last marathon',
    basisTime:  fmtTime(last.timeSec),
    basisDate:  last.date || null,
    fastSec:    fast,
    slowSec:    slow,
    range:      fmtTime(fast) + '–' + fmtTime(slow),
    fastPace:   paceOf(fast, 26.2),
    slowPace:   paceOf(slow, 26.2),
    subThree:   fast < 3 * 3600,
    adjustLoPct: lo,
    adjustHiPct: hi,
  };
}

/* ── the feedback cards ────────────────────────────────────────────────────── */

/**
 * @param {object} d the coach-dashboard payload
 * @returns {Array} [{ key, title, body, tone }]  tone: good | neutral | warn | bad
 */
function buildFeedback(d) {
  var out = [];
  if (!d) return out;

  var lb = d.loadBudget || {};
  var today = d.today || {};

  /* ── This week — load first, distance as the translation ──────────────── */
  var wp = d.weekPlan;
  if (wp) {
    var dow0 = new Date(today.date + 'T12:00:00Z').getUTCDay();
    var dLeft = dow0 === 0 ? 1 : 8 - dow0;

    var wb = '';
    if (wp.remainMi <= 0) {
      wb = 'You have banked this week\'s training load — ' + wp.doneMi + ' miles done. ' +
           'Anything more is a bonus.';
    } else {
      wb = 'About ' + wp.remainMi + ' more ' + plural(Math.round(wp.remainMi), 'mile') +
           ' this week, on top of the ' + wp.doneMi + ' you have run. ';
      wb += dLeft > 1 ? 'That is roughly ' + (wp.remainMi / dLeft).toFixed(1) + ' a day over ' +
                        dLeft + ' days. ' : 'Today is the last day of the week. ';
    }

    // The part that makes it a load target rather than a mileage target
    if (wp.movedBy != null && Math.abs(wp.movedBy) >= 0.5 && wp.actualPace) {
      wb += wp.movedBy < 0
        ? 'The target came down from ' + wp.baselineMi + ' miles because you have been running ' +
          'faster than expected (' + F_pace(wp.actualPace) + ' against ' + F_pace(wp.expectedPace) +
          ') — you banked the same work in fewer miles.'
        : 'The target went up from ' + wp.baselineMi + ' miles because you have been running ' +
          'easier than expected (' + F_pace(wp.actualPace) + ' against ' + F_pace(wp.expectedPace) +
          ') — easier miles bank less, so it takes more of them.';
    }
    if (wp.phaseWhy) wb += ' The week is sized for ' + wp.phaseWhy + '.';

    // The rules outrank the load target. If the ceiling is lower than what the
    // load maths asks for, the ceiling wins and must be said out loud —
    // Kaizen has no injury rules, this does.
    var clamped = lb.headroomMi != null && wp.remainMi > lb.headroomMi;
    if (clamped) {
      wb += ' Your rules cap you at ' + lb.headroomMi + ' more ' +
            plural(lb.headroomMi, 'mile') + ' though' +
            (lb.bindingRule === 'calf'
              ? ' — the calf combination that has broken every build'
              : lb.bindingRule === 3
                ? ', to stay inside a 10% step up from your recent average'
                : lb.bindingRule === 'taper' ? ', because it is race week' : '') +
            ', so take the lower number.';
    }

    out.push({ key: 'week', title: 'This week', body: wb,
               tone: clamped ? 'warn' : 'neutral' });

  } else if (lb.headroomMi != null) {
    // Fallback when there is no fitness number to size a load target from
    out.push({ key: 'week', title: 'This week', tone: 'neutral',
      body: 'You have run ' + lb.spentMi + ' miles. Without a current fitness number there is no ' +
            'load target to size the week against — the rules allow up to ' + lb.headroomMi +
            ' more, but that is a ceiling, not a goal.' });
  }

  /* ── Time since the last hard session ──────────────────────────────────── */
  if (lb.hoursSinceQuality != null) {
    var days = Math.round(lb.hoursSinceQuality / 24);
    var t, b;
    if (lb.hoursSinceQuality < 72) {
      t = 'bad';
      b = 'Your last hard session was ' + lb.hoursSinceQuality + ' hours ago. You need 72 hours between ' +
          'hard efforts, so today should be easy.';
    } else if (days <= 7) {
      t = 'good';
      b = 'Last hard session was ' + days + ' ' + plural(days, 'day') + ' ago. You are clear to go hard again.';
    } else if (days <= 14) {
      t = 'neutral';
      b = 'It has been ' + days + ' days since a hard session. You are well recovered, but sharpness fades ' +
          'after about two weeks without one.';
    } else {
      t = 'warn';
      b = 'It has been ' + days + ' days since a hard session. You are rested but going flat — ' +
          'the next quality session matters.';
    }
    out.push({ key: 'quality', title: 'Hard sessions', body: b, tone: t });
  }

  /* ── Fitness and freshness, in words ───────────────────────────────────── */
  if (d.load) {
    var ctl = d.load.ctl, tsb = d.load.tsb, acwr = d.load.acwr;
    var fresh = tsb > 10 ? 'very fresh' : tsb >= -10 ? 'fresh' : tsb >= -20 ? 'carrying normal training fatigue' : 'deeply fatigued';
    var bb = 'Your fitness is at ' + ctl + ' and you are ' + fresh + '. ';
    if (tsb > 15 && ctl < 40) {
      bb += 'High freshness with low fitness usually means detraining rather than taper — you have room to train.';
    } else if (tsb > 10) {
      bb += 'This is a good state to race from.';
    } else if (tsb < -20) {
      bb += 'Back off before you feel you need to — the aerobic system lies at peak fitness.';
    } else {
      bb += 'That is a normal, productive place to be mid-block.';
    }
    if (acwr != null && acwr > 1.3) {
      bb += ' Your recent load is ' + Math.round((acwr - 1) * 100) + '% above your baseline, which is the injury-risk zone.';
    }
    out.push({ key: 'fitness', title: 'Fitness and freshness',
               body: bb, tone: tsb < -20 || (acwr != null && acwr > 1.3) ? 'warn' : 'good' });
  }

  /* ── Gray zone — the flagship error ────────────────────────────────────── */
  if (d.grayZone && d.grayZone.length) {
    var flagged = d.grayZone.filter(function (g) { return g.flagged; });
    var worst = d.grayZone.slice().sort(function (a, b) { return b.grayPct - a.grayPct; })[0];
    var gt, gb;
    if (flagged.length === 0) {
      gt = 'good';
      gb = 'All of your recent easy runs stayed genuinely easy. This is the discipline that makes the hard days work.';
    } else {
      var share = Math.round(flagged.length / d.grayZone.length * 100);
      gt = share >= 50 ? 'bad' : 'warn';
      gb = flagged.length + ' of your last ' + d.grayZone.length + ' runs were easy days run too hard — ' +
           'too much time at a heart rate between 136 and 152. ';
      gb += 'The worst was ' + worst.date + ' at ' + worst.grayPct + '%. ';
      gb += 'This is the single most common error in your history. Easy days that drift here leave you ' +
            'tired for the sessions that actually build fitness, without building any themselves.';
    }
    out.push({ key: 'grayzone', title: 'Easy-day discipline', body: gb, tone: gt });
  }

  /* ── Strength — Rule 5, untracked until now ────────────────────────────── */
  if (d.strength) {
    var st = d.strength;
    var short = st.sessionsThisWeek < st.gluteTarget;
    out.push({
      key: 'strength', title: 'Strength work',
      tone: short ? 'warn' : 'good',
      body: short
        ? 'You have logged ' + st.sessionsThisWeek + ' strength ' + plural(st.sessionsThisWeek, 'session') +
          ' this week against a target of ' + st.gluteTarget + ' glute and ' + st.calfTarget + ' calf sessions. ' +
          'Your legs and glutes were what gave out at Chicago, and this is the first block where it is ' +
          'being tracked at all. Only Strava-logged sessions count here — work you did but did not log is invisible.'
        : 'Strength work is on target this week. Keep it going — it is the cheapest injury insurance you have.',
    });
  }

  /* ── Next session ──────────────────────────────────────────────────────── */
  if (d.keySessions && d.keySessions.length) {
    var k = d.keySessions[0];
    var when = k.daysAway === 0 ? 'today' : k.daysAway === 1 ? 'tomorrow' : 'in ' + k.daysAway + ' days';
    out.push({
      key: 'next', title: 'Next key session', tone: 'neutral',
      body: 'Your next scheduled session is ' + when + ' (' + k.date + '): ' + k.detail,
    });
  }

  return out;
}

module.exports = {
  buildFeedback,
  projectMarathon,
  fmtTime,
  parseTime,
  paceOf,
};
