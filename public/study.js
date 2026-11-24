/**
 * study.js  —  Study tab (core): shell, focus timer, daily plan, stats.
 * Groups / Global Room / chat live in study-social.js (same `Study` namespace).
 *
 * Globals used from index.html: apiFetch, toast, switchNavTab, tg
 * Backend: /api/study/*  (see routes/study.js)
 */
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var S = window.Study = { me: null, tab: 'timer', polls: [], ACT: {}, ui: {} };
  var COLORS = ['#FFB38A', '#7FD1A8', '#A79BE8', '#7DB8E8', '#F2B544', '#E88FB4'];

  // ── helpers ────────────────────────────────────────────────────────────────
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  S.esc = esc; S.$ = $; S.COLORS = COLORS;
  S.hms = function (sec) { sec = Math.max(0, Math.floor(sec)); return pad(Math.floor(sec / 3600)) + ':' + pad(Math.floor(sec % 3600 / 60)) + ':' + pad(sec % 60); };
  S.dur = function (sec) { sec = Math.max(0, Math.round(sec / 60)); var h = Math.floor(sec / 60), m = sec % 60; return h ? h + 'h ' + pad(m) + 'm' : m + 'm'; };
  S.api = function (path, method, body) { return apiFetch('/api/study' + path, method, body); };
  S.err = function (e) { try { return JSON.parse(e.message).error || 'Something went wrong'; } catch (_) { return e && e.message && e.message.length < 120 ? e.message : 'Something went wrong'; } };
  S.say = function (m, t) { try { toast(m, t); } catch (_) {} };
  S.haptic = function (k) { try { tg.HapticFeedback.impactOccurred(k || 'light'); } catch (_) {} };
  S.confirm = function (msg, cb) { if (tg && tg.showConfirm) tg.showConfirm(msg, function (ok) { if (ok) cb(); }); else if (window.confirm(msg)) cb(); };
  S.avatarColor = function (name) { var h = 0; String(name || '?').split('').forEach(function (c) { h = (h * 31 + c.charCodeAt(0)) % COLORS.length; }); return COLORS[h]; };
  S.initial = function (name) { return esc((String(name || '?').trim()[0] || '?').toUpperCase()); };

  // ── sheet (bottom popup) ───────────────────────────────────────────────────
  function ensureSheet() {
    if ($('stSheet')) return;
    var el = document.createElement('div');
    el.id = 'stSheet'; el.className = 'st-sheet';
    el.innerHTML = '<div class="st-dim" data-act="sheetClose"></div><div class="st-panel" role="dialog" aria-modal="true"><div class="st-grab"></div><div id="stSheetBody"></div></div>';
    document.body.appendChild(el);
    el.addEventListener('click', onClick);
  }
  S.sheet = function (html) { ensureSheet(); $('stSheetBody').innerHTML = html; $('stSheet').classList.add('open'); };
  S.closeSheet = function () { var s = $('stSheet'); if (s) s.classList.remove('open'); };

  // ── polling (cleared whenever the view changes) ────────────────────────────
  S.poll = function (fn, ms) { fn(); var id = setInterval(fn, ms); S.polls.push(id); return id; };
  S.stopPolls = function () { S.polls.forEach(clearInterval); S.polls = []; };

  // ── events ─────────────────────────────────────────────────────────────────
  function onClick(ev) {
    var el = ev.target.closest('[data-act]');
    if (!el) return;
    var fn = S.ACT[el.getAttribute('data-act')];
    if (fn) { if (el.tagName !== 'INPUT') ev.preventDefault(); fn(el, ev); }   // never block a checkbox toggling
  }

  // ═════════════════════════════════════════════════════════════════════════
  // SHELL
  // ═════════════════════════════════════════════════════════════════════════
  var TABS = [['timer', 'Timer', 'ti-clock'], ['plan', 'Plan', 'ti-checklist'], ['groups', 'Groups', 'ti-users'], ['stats', 'Stats', 'ti-chart-bar']];

  function shell() {
    var root = $('page-study');
    if (root.getAttribute('data-ready')) return;
    root.setAttribute('data-ready', '1');
    $('stScroll').innerHTML = '<div class="st-seg" id="stSeg">' + TABS.map(function (t) { return '<button data-act="tab" data-tab="' + t[0] + '"><i class="ti ' + t[2] + '"></i>' + t[1] + '</button>'; }).join('') + '</div>' +
      '<div id="stBody" class="st-body"></div>';
    root.addEventListener('click', onClick);
  }
  S.ACT.tab = function (el) { S.go(el.getAttribute('data-tab')); };
  S.ACT.sheetClose = function () { S.closeSheet(); };

  S.go = function (tab, arg) {
    S.stopPolls(); S.closeSheet();
    S.tab = tab; S.arg = arg;
    document.body.classList.toggle('st-chat-mode', tab === 'group' && !!arg && arg.view === 'chat');   // messenger layout
    var pg = $('page-study'); if (pg) pg.classList.toggle('st-dark', tab === 'timer');                    // Timer = dark focus mode (design)
    document.body.classList.toggle('st-focus', tab === 'timer');
    var btns = document.querySelectorAll('#stSeg button');
    for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === (tab === 'room' || tab === 'group' || tab === 'manage' ? 'groups' : tab));
    var map = { timer: renderTimer, plan: renderPlan, stats: renderStats };
    if (map[tab]) map[tab]();
    else if (S.social && S.social[tab]) S.social[tab](arg);
    if ($('stScroll')) $('stScroll').scrollTop = 0;
  };

  S.open = async function () {
    shell();
    try {
      S.me = await S.api('/me');
      S.serverOffset = S.me.serverNow - Date.now();
      restoreTimer();
    } catch (e) { if (!S.me) { $('stBody').innerHTML = '<div class="st-empty">' + esc(S.err(e)) + '</div>'; return; } }
    $('stStreak').innerHTML = S.me.streak ? '<i class="ti ti-flame"></i>' + S.me.streak + ' day' + (S.me.streak > 1 ? 's' : '') : '';
    S.go(S.tab === 'group' || S.tab === 'manage' || S.tab === 'room' ? 'groups' : S.tab || 'timer');
  };
  S.leave = function () { S.stopPolls(); S.closeSheet(); document.body.classList.remove('st-chat-mode', 'st-focus'); var pg = $('page-study'); if (pg) pg.classList.remove('st-dark'); };   // the timer keeps running in the background
  S.reloadMe = async function () {
    S.me = await S.api('/me');
    $('stStreak').innerHTML = S.me.streak ? '<i class="ti ti-flame"></i>' + S.me.streak + ' day' + (S.me.streak > 1 ? 's' : '') : '';
  };

  // ═════════════════════════════════════════════════════════════════════════
  // TIMER STATE MACHINE
  // ═════════════════════════════════════════════════════════════════════════
  // T.phase: idle | focus | break.  Countdown modes keep `left` (sec at last resume) + `resumedAt`.
  var LS_KEY = 'edubot_study_timer_v1';
  var T = { mode: 'pomodoro', phase: 'idle', running: false, left: 0, total: 0, elapsed: 0, resumedAt: 0, round: 0, subjectId: null, taskId: null, customMin: 45 };
  var hbId = null, tickId = null;
  S.T = T;
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(T)); } catch (_) {} }
  function pm() { return (S.me && S.me.profile.pomodoro) || { focus: 25, shortBreak: 5, longBreak: 15, rounds: 4 }; }
  function nowSec() { return Date.now() / 1000; }
  function remaining() { return T.running ? Math.max(0, T.left - (nowSec() - T.resumedAt)) : T.left; }
  function elapsedNow() { return T.running ? T.elapsed + (nowSec() - T.resumedAt) : T.elapsed; }
  function isCountdown() { return T.mode !== 'stopwatch'; }
  function subjectOf(id) { return (S.me && S.me.subjects || []).filter(function (s) { return s.id === id; })[0]; }

  function restoreTimer() {
    try {
      var saved = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (saved && saved.phase !== 'idle' && S.me.timer) { Object.assign(T, saved); }       // server still has an active session
      else if (!S.me.timer) { T.phase = 'idle'; T.running = false; }
    } catch (_) {}
    if (T.phase !== 'idle') startLoops();
  }
  function startLoops() {
    if (!hbId) hbId = setInterval(beat, 30000);
    if (!tickId) tickId = setInterval(tick, 1000);
  }
  function stopLoops() { clearInterval(hbId); clearInterval(tickId); hbId = tickId = null; }
  function status() { return T.phase === 'break' ? 'break' : (T.running ? 'focus' : 'paused'); }

  async function beat() {
    if (T.phase === 'idle') return;
    try { await S.api('/timer/beat', 'POST', { status: status() }); }
    catch (e) {
      if (/no_timer/.test(e.message || '') && T.phase !== 'idle') {                  // server dropped us (restart / long background)
        try { await S.api('/timer/start', 'POST', { mode: T.mode, subjectId: T.subjectId, taskId: T.taskId }); } catch (_) {}
      }
    }
  }

  function tick() {
    if (T.phase === 'idle') return;
    if (isCountdown() && T.running && remaining() <= 0) { phaseEnd(); return; }
    if (S.tab === 'timer') paintTimer();
  }

  function phaseEnd() {
    S.haptic('heavy');
    if (T.mode === 'custom') { S.say('Session complete! Great work.'); return stopTimer(true); }
    var p = pm();
    if (T.phase === 'focus') {
      T.round++;
      var long = T.round % p.rounds === 0;
      T.phase = 'break'; T.total = (long ? p.longBreak : p.shortBreak) * 60; T.left = T.total; T.resumedAt = nowSec();
      S.say(long ? 'Focus done. Take a long break.' : 'Focus done. Short break time.');
    } else {
      T.phase = 'focus'; T.total = p.focus * 60; T.left = T.total; T.resumedAt = nowSec();
      S.say('Break over. Back to focus.');
    }
    T.running = true; save(); beat(); paintTimer(true);
  }

  async function beginTimer(subjectId, taskId) {
    T.subjectId = subjectId || null; T.taskId = taskId || null;
    var p = pm();
    try {
      await S.api('/timer/start', 'POST', { mode: T.mode, subjectId: T.subjectId, taskId: T.taskId });
    } catch (e) { S.say(S.err(e), 'error'); return; }
    T.phase = 'focus'; T.running = true; T.round = 0; T.elapsed = 0; T.resumedAt = nowSec();
    if (T.mode === 'pomodoro') T.total = p.focus * 60;
    else if (T.mode === 'custom') T.total = (T.customMin || 45) * 60;
    else T.total = 0;
    T.left = T.total;
    save(); startLoops(); S.haptic('medium'); S.closeSheet();
    if (S.tab === 'timer') renderTimer();
  }

  async function stopTimer(silent) {
    stopLoops();
    var wasActive = T.phase !== 'idle';
    T.phase = 'idle'; T.running = false; T.left = 0; T.elapsed = 0; T.round = 0; save();
    if (wasActive) {
      try {
        var r = await S.api('/timer/stop', 'POST');
        if (!silent && r.saved) S.say('Saved ' + S.dur(r.durationSec) + ' of study time');
        else if (!silent && !r.saved) S.say('Too short to save (under 30 sec)');
      } catch (_) {}
      try { await S.reloadMe(); } catch (_) {}
    }
    if (S.tab === 'timer') renderTimer();
  }

  function togglePause() {
    if (T.phase === 'idle') return;
    if (T.running) {                                   // pause: freeze the counters
      if (isCountdown()) T.left = remaining(); else T.elapsed = elapsedNow();
      T.running = false;
    } else { T.running = true; T.resumedAt = nowSec(); }
    save(); beat(); S.haptic(); paintTimer(true);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // TIMER VIEW
  // ═════════════════════════════════════════════════════════════════════════
  var C = 729;
  function ringHtml() {
    return '<div class="st-ring"><svg viewBox="0 0 260 260" aria-hidden="true"><circle cx="130" cy="130" r="116" class="st-ring-bg"/><circle id="stRingFg" cx="130" cy="130" r="116" class="st-ring-fg" stroke-dasharray="' + C + '" stroke-dashoffset="' + C + '" transform="rotate(-90 130 130)"/></svg>' +
      '<div class="st-ring-in"><div class="st-phase" id="stPhase"></div><div class="st-time" id="stTime">00:00</div><div class="st-round" id="stRound"></div></div></div>';
  }

  function renderTimer() {
    var p = pm(), act = T.phase !== 'idle';
    var subj = subjectOf(T.subjectId);
    var today = S.me ? S.me.summary.totalSec : 0, target = S.me ? S.me.profile.dailyTargetMin * 60 : 14400;
    var html = '';
    html += '<div class="st-seg st-seg-sm" ' + (act ? 'style="opacity:.5;pointer-events:none"' : '') + '>' +
      ['pomodoro', 'stopwatch', 'custom'].map(function (m) { return '<button data-act="mode" data-mode="' + m + '" class="' + (T.mode === m ? 'on' : '') + '">' + m[0].toUpperCase() + m.slice(1) + '</button>'; }).join('') + '</div>';
    html += ringHtml();
    if (T.mode === 'custom' && !act) {
      html += '<div class="st-chips st-center">' + [15, 30, 45, 60, 90].map(function (m) { return '<button class="st-chip ' + (T.customMin === m ? 'on' : '') + '" data-act="customMin" data-min="' + m + '">' + m + 'm</button>'; }).join('') + '</div>';
    }
    html += '<div class="st-row st-between">' +
      '<button class="st-pill" data-act="' + (act ? 'noop' : 'pickSubject') + '"><i class="st-dot" style="background:' + (subj ? subj.color : 'var(--text2)') + '"></i>' + esc(subj ? subj.name : (act ? 'No subject' : 'Choose subject')) + (act ? '' : '<i class="ti ti-chevron-down"></i>') + '</button>' +
      '<span class="st-muted" id="stToday">' + S.dur(today) + ' / ' + S.dur(target) + '</span></div>';
    html += '<div class="st-controls">' + (act
      ? '<button class="st-round-btn" data-act="stop" aria-label="Stop and save"><i class="ti ti-player-stop-filled"></i></button>' +
        '<button class="st-big" data-act="pause" id="stPauseBtn" aria-label="Pause or resume"><i class="ti ti-player-pause-filled"></i></button>' +
        (T.mode === 'pomodoro' ? '<button class="st-round-btn" data-act="skip" aria-label="Skip phase"><i class="ti ti-player-skip-forward-filled"></i></button>' : '<span class="st-round-btn st-ghost"></span>')
      : '<button class="st-big st-start" data-act="pickSubject" aria-label="Start"><i class="ti ti-player-play-filled"></i></button>') + '</div>';
    if (T.mode === 'pomodoro') {
      html += '<div class="st-dots" id="stDots" aria-hidden="true">' + Array.from({ length: p.rounds }).map(function (_, i) { return '<i class="' + (i < (T.round % p.rounds) ? 'on' : '') + '"></i>'; }).join('') + '</div>';
    }
    html += '<button class="st-live" data-act="goRoom"><span class="st-avs" id="stLiveAvs"></span><span class="st-live-t"><b id="stLiveCount">Global Room</b><small>See who is studying right now</small></span><i class="ti ti-chevron-right"></i></button>';
    html += '<button class="st-link" data-act="timerSettings"><i class="ti ti-adjustments"></i>Timer settings</button>';
    $('stBody').innerHTML = html;
    paintTimer(true);
    S.api('/live').then(function (r) {
      var c = $('stLiveCount'); if (!c) return;
      c.textContent = r.count + ' studying right now';
      $('stLiveAvs').innerHTML = r.items.slice(0, 3).map(function (i) { return '<i style="background:' + S.avatarColor(i.name) + '">' + S.initial(i.name) + '</i>'; }).join('');
    }).catch(function () {});
  }

  function paintTimer(force) {
    var time = $('stTime'); if (!time) return;
    var act = T.phase !== 'idle', cd = isCountdown();
    var p = pm(), sec, prog;
    if (!act) {
      sec = T.mode === 'pomodoro' ? p.focus * 60 : T.mode === 'custom' ? (T.customMin || 45) * 60 : 0;
      prog = 0;
    } else if (cd) { sec = remaining(); prog = T.total ? 1 - sec / T.total : 0; }
    else { sec = elapsedNow(); prog = (sec % 3600) / 3600; }
    time.textContent = (sec >= 3600 || T.mode === 'stopwatch') ? S.hms(sec) : pad(Math.floor(sec / 60)) + ':' + pad(Math.floor(sec % 60));
    $('stRingFg').setAttribute('stroke-dashoffset', String(C * (1 - Math.min(1, Math.max(0, prog)))));
    $('stRingFg').classList.toggle('st-break', T.phase === 'break');
    $('stPhase').textContent = !act ? 'READY' : T.phase === 'break' ? 'BREAK' : (T.running ? 'FOCUS' : 'PAUSED');
    $('stRound').textContent = T.mode === 'pomodoro' ? 'Session ' + (Math.floor(T.round % p.rounds) + 1) + ' of ' + p.rounds : T.mode === 'custom' ? (act ? '' : 'Set your own length') : 'No limit';
    if (force && $('stPauseBtn')) $('stPauseBtn').innerHTML = '<i class="ti ti-player-' + (T.running ? 'pause' : 'play') + '-filled"></i>';
  }

  S.ACT.noop = function () {};
  S.ACT.mode = function (el) { if (T.phase !== 'idle') return; T.mode = el.getAttribute('data-mode'); save(); renderTimer(); };
  S.ACT.customMin = function (el) { T.customMin = +el.getAttribute('data-min'); save(); renderTimer(); };
  S.ACT.pause = function () { togglePause(); };
  S.ACT.stop = function () { S.confirm('Stop and save this session?', function () { stopTimer(false); }); };
  S.ACT.skip = function () { if (T.phase !== 'idle') phaseEnd(); };
  S.ACT.goRoom = function () { S.go('room'); };

  // ── subject picker (shown before every start) ───────────────────────────────
  var pick = { subjectId: null, taskId: null };
  S.ACT.pickSubject = function () {
    pick.subjectId = T.subjectId || (S.me.subjects[0] && S.me.subjects[0].id) || null; pick.taskId = null;
    renderPick();
  };
  function renderPick() {
    var by = {}; S.me.summary.bySubject.forEach(function (x) { if (x.subjectId) by[x.subjectId] = x.sec; });
    var open = S.me.tasks.filter(function (t) { return !t.done; });
    var subj = subjectOf(pick.subjectId);
    S.sheet('<h2 class="st-h2">What are you studying?</h2><p class="st-muted">Time is added to the subject you pick</p>' +
      '<div class="st-lbl">Subject</div><div class="st-list">' +
      S.me.subjects.map(function (s) {
        return '<button class="st-opt ' + (pick.subjectId === s.id ? 'on' : '') + '" data-act="pickSubj" data-id="' + s.id + '"><i class="st-dot" style="background:' + s.color + '"></i><span>' + esc(s.name) + '</span><small>today ' + S.dur(by[s.id] || 0) + '</small>' + (pick.subjectId === s.id ? '<i class="ti ti-check"></i>' : '') + '</button>';
      }).join('') +
      '<button class="st-opt st-dashed" data-act="addSubject" data-back="pick"><i class="ti ti-plus"></i><span>New subject</span></button></div>' +
      (open.length ? '<div class="st-lbl">Task (optional)</div><div class="st-chips">' +
        open.slice(0, 8).map(function (t) { return '<button class="st-chip ' + (pick.taskId === t.id ? 'on' : '') + '" data-act="pickTask" data-id="' + t.id + '">' + esc(t.text.slice(0, 28)) + '</button>'; }).join('') + '</div>' : '') +
      '<button class="st-cta" data-act="pickGo" ' + (pick.subjectId ? '' : 'disabled') + '><i class="ti ti-player-play-filled"></i>Start Focus' + (subj ? ' \u00b7 ' + esc(subj.name) : '') + '</button>' +
      (S.me.subjects.length ? '' : '<p class="st-muted" style="margin-top:8px">Add a subject first so your time is tracked.</p>'));
  }
  S.ACT.pickSubj = function (el) { pick.subjectId = el.getAttribute('data-id'); renderPick(); };
  S.ACT.pickTask = function (el) {
    var id = el.getAttribute('data-id'); pick.taskId = pick.taskId === id ? null : id;
    var t = S.me.tasks.filter(function (x) { return x.id === id; })[0];
    if (pick.taskId && t && t.subjectId) pick.subjectId = t.subjectId;
    renderPick();
  };
  S.ACT.pickGo = function () { if (pick.subjectId) beginTimer(pick.subjectId, pick.taskId); };
  S.startFromTask = function (taskId) {
    var t = S.me.tasks.filter(function (x) { return x.id === taskId; })[0]; if (!t) return;
    if (T.phase !== 'idle') { S.say('Stop the running timer first', 'error'); return; }
    S.tab = 'timer'; S.go('timer'); pick.subjectId = t.subjectId || (S.me.subjects[0] && S.me.subjects[0].id) || null; pick.taskId = taskId; renderPick();
  };

  // ── timer settings (pomodoro lengths, anonymous) ────────────────────────────
  S.ACT.timerSettings = function () {
    var p = pm();
    function f(id, label, v, min, max) { return '<label class="st-field"><span>' + label + '</span><input id="' + id + '" type="number" inputmode="numeric" min="' + min + '" max="' + max + '" value="' + v + '"></label>'; }
    S.sheet('<h2 class="st-h2">Timer settings</h2>' +
      '<div class="st-grid2">' + f('pmFocus', 'Focus (min)', p.focus, 1, 180) + f('pmShort', 'Short break', p.shortBreak, 1, 60) + f('pmLong', 'Long break', p.longBreak, 1, 90) + f('pmRounds', 'Sessions / round', p.rounds, 1, 12) + '</div>' +
      '<label class="st-toggle"><span><b>Hide my name in Global Room</b><small>You will show as "Anonymous" to everyone outside your groups</small></span><input id="pmAnon" type="checkbox" ' + (S.me.profile.anonymous ? 'checked' : '') + '></label>' +
      '<button class="st-cta" data-act="saveSettings">Save</button>');
  };
  S.ACT.saveSettings = async function () {
    try {
      var r = await S.api('/profile', 'PUT', { anonymous: $('pmAnon').checked, pomodoro: { focus: +$('pmFocus').value, shortBreak: +$('pmShort').value, longBreak: +$('pmLong').value, rounds: +$('pmRounds').value } });
      S.me.profile = r.profile; S.closeSheet(); if (T.phase === 'idle') renderTimer(); S.say('Saved');
    } catch (e) { S.say(S.err(e), 'error'); }
  };

  // ═════════════════════════════════════════════════════════════════════════
  // PLAN VIEW  (daily target, subjects, to-do)
  // ═════════════════════════════════════════════════════════════════════════
  function renderPlan() {
    var me = S.me, tgtSec = me.profile.dailyTargetMin * 60, done = me.summary.totalSec;
    var pct = Math.min(100, Math.round(done / tgtSec * 100)), left = Math.max(0, tgtSec - done);
    var by = {}; me.summary.bySubject.forEach(function (x) { if (x.subjectId) by[x.subjectId] = x.sec; });
    var dn = me.tasks.filter(function (t) { return t.done; }).length;
    var html = '<div class="st-card st-dark"><div class="st-mini-ring"><svg viewBox="0 0 96 96"><circle cx="48" cy="48" r="40" class="st-ring-bg"/><circle cx="48" cy="48" r="40" class="st-ring-fg" stroke-dasharray="251" stroke-dashoffset="' + (251 * (1 - pct / 100)) + '" transform="rotate(-90 48 48)"/></svg><b>' + pct + '%</b></div>' +
      '<div class="st-grow"><div class="st-eyebrow">DAILY TARGET</div><div class="st-big-n">' + S.dur(tgtSec) + '</div><div class="st-muted">' + S.dur(done) + ' done \u00b7 ' + (left ? S.dur(left) + ' left' : 'target reached') + '</div></div>' +
      '<button class="st-btn-sm" data-act="editTarget">Edit</button></div>';
    html += '<div class="st-lbl">My subjects \u00b7 today</div><div class="st-chips">' +
      me.subjects.map(function (s) { return '<button class="st-chip" data-act="editSubject" data-id="' + s.id + '"><i class="st-dot" style="background:' + s.color + '"></i>' + esc(s.name) + ' \u00b7 ' + S.dur(by[s.id] || 0) + '</button>'; }).join('') +
      '<button class="st-chip st-dashed" data-act="addSubject"><i class="ti ti-plus"></i>Add subject</button></div>';
    html += '<div class="st-row st-between st-mt"><div><span class="st-lbl" style="margin:0">To-do</span> <span class="st-muted">' + dn + ' of ' + me.tasks.length + ' done</span></div><button class="st-btn-acc" data-act="addTask"><i class="ti ti-plus"></i>Add task</button></div>';
    html += '<div class="st-list">' + (me.tasks.length ? me.tasks.map(function (t) {
      var s = subjectOf(t.subjectId);
      return '<div class="st-task ' + (t.done ? 'done' : '') + '"><button class="st-chk" data-act="toggleTask" data-id="' + t.id + '" aria-label="' + (t.done ? 'Mark not done' : 'Mark done') + '" aria-pressed="' + t.done + '">' + (t.done ? '<i class="ti ti-check"></i>' : '') + '</button>' +
        '<div class="st-grow"><div class="st-task-t">' + esc(t.text) + '</div>' + (s ? '<span class="st-tag" style="background:' + s.color + '">' + esc(s.name) + '</span>' : '') + (t.carried ? '<span class="st-tag st-tag-m">carried over</span>' : '') + '</div>' +
        (t.done ? '' : '<button class="st-play" data-act="taskPlay" data-id="' + t.id + '" aria-label="Start timer for this task"><i class="ti ti-player-play-filled"></i></button>') +
        '<button class="st-x" data-act="delTask" data-id="' + t.id + '" aria-label="Delete task"><i class="ti ti-trash"></i></button></div>';
    }).join('') : '<div class="st-empty">No tasks yet. Add what you plan to study today.</div>') + '</div>';
    $('stBody').innerHTML = html;
  }

  S.ACT.editTarget = function () {
    var m = S.me.profile.dailyTargetMin;
    S.sheet('<h2 class="st-h2">Daily target</h2><div class="st-chips">' + [120, 180, 240, 360, 480].map(function (v) { return '<button class="st-chip ' + (m === v ? 'on' : '') + '" data-act="setTargetQuick" data-min="' + v + '">' + v / 60 + 'h</button>'; }).join('') + '</div>' +
      '<label class="st-field"><span>Or type minutes</span><input id="tgtMin" type="number" inputmode="numeric" min="10" max="1440" value="' + m + '"></label><button class="st-cta" data-act="saveTarget">Save target</button>');
  };
  S.ACT.setTargetQuick = function (el) { $('tgtMin').value = el.getAttribute('data-min'); };
  S.ACT.saveTarget = async function () {
    try { var r = await S.api('/profile', 'PUT', { dailyTargetMin: +$('tgtMin').value }); S.me.profile = r.profile; S.closeSheet(); renderPlan(); }
    catch (e) { S.say(S.err(e), 'error'); }
  };

  var draft = { color: COLORS[0] };
  S.ACT.addSubject = function (el) {
    var back = el && el.getAttribute && el.getAttribute('data-back');
    draft = { color: COLORS[S.me.subjects.length % COLORS.length], back: back };
    S.sheet('<h2 class="st-h2">New subject</h2><label class="st-field"><span>Name</span><input id="subjName" maxlength="40" placeholder="e.g. Advanced Accounting"></label>' +
      '<div class="st-swatches">' + COLORS.map(function (c) { return '<button class="' + (c === draft.color ? 'on' : '') + '" style="background:' + c + '" data-act="subjColor" data-c="' + c + '" aria-label="Colour ' + c + '"></button>'; }).join('') + '</div>' +
      '<button class="st-cta" data-act="saveSubject">Add subject</button>');
  };
  S.ACT.subjColor = function (el) { draft.color = el.getAttribute('data-c'); var b = el.parentNode.children; for (var i = 0; i < b.length; i++) b[i].classList.toggle('on', b[i] === el); };
  S.ACT.saveSubject = async function () {
    try {
      var r = await S.api('/subjects', 'POST', { name: $('subjName').value, color: draft.color });
      if (!S.me.subjects.some(function (s) { return s.id === r.subject.id; })) S.me.subjects.push(r.subject);
      if (draft.back === 'pick') { pick.subjectId = r.subject.id; renderPick(); } else { S.closeSheet(); if (S.tab === 'plan') renderPlan(); }
    } catch (e) { S.say(S.err(e), 'error'); }
  };
  S.ACT.editSubject = function (el) {
    var id = el.getAttribute('data-id'), s = subjectOf(id); draft = { color: s.color, id: id };
    S.sheet('<h2 class="st-h2">Edit subject</h2><label class="st-field"><span>Name</span><input id="subjName" maxlength="40" value="' + esc(s.name) + '"></label>' +
      '<div class="st-swatches">' + COLORS.map(function (c) { return '<button class="' + (c === s.color ? 'on' : '') + '" style="background:' + c + '" data-act="subjColor" data-c="' + c + '" aria-label="Colour ' + c + '"></button>'; }).join('') + '</div>' +
      '<button class="st-cta" data-act="updateSubject">Save</button><button class="st-cta st-danger" data-act="delSubject">Delete subject</button>');
  };
  S.ACT.updateSubject = async function () {
    try { var r = await S.api('/subjects/' + draft.id, 'PUT', { name: $('subjName').value, color: draft.color }); var s = subjectOf(draft.id); s.name = r.subject.name; s.color = r.subject.color; S.closeSheet(); renderPlan(); }
    catch (e) { S.say(S.err(e), 'error'); }
  };
  S.ACT.delSubject = function () {
    S.confirm('Delete this subject? Your past study time stays in the stats.', async function () {
      try { await S.api('/subjects/' + draft.id, 'DELETE'); S.me.subjects = S.me.subjects.filter(function (s) { return s.id !== draft.id; }); S.closeSheet(); renderPlan(); }
      catch (e) { S.say(S.err(e), 'error'); }
    });
  };

  S.ACT.addTask = function () {
    draft = { subjectId: S.me.subjects[0] ? S.me.subjects[0].id : null };
    S.sheet('<h2 class="st-h2">New task</h2><label class="st-field"><span>What will you study?</span><input id="taskText" maxlength="120" placeholder="e.g. Revise WDV method"></label>' +
      '<div class="st-lbl">Subject</div><div class="st-chips" id="taskSubj">' + taskSubjChips() + '</div><button class="st-cta" data-act="saveTask">Add task</button>');
  };
  function taskSubjChips() {
    return S.me.subjects.map(function (s) { return '<button class="st-chip ' + (draft.subjectId === s.id ? 'on' : '') + '" data-act="taskSubj" data-id="' + s.id + '"><i class="st-dot" style="background:' + s.color + '"></i>' + esc(s.name) + '</button>'; }).join('') +
      '<button class="st-chip ' + (!draft.subjectId ? 'on' : '') + '" data-act="taskSubj" data-id="">None</button>';
  }
  S.ACT.taskSubj = function (el) { draft.subjectId = el.getAttribute('data-id') || null; $('taskSubj').innerHTML = taskSubjChips(); };
  S.ACT.saveTask = async function () {
    try { var r = await S.api('/tasks', 'POST', { text: $('taskText').value, subjectId: draft.subjectId }); S.me.tasks.push(r.task); S.closeSheet(); renderPlan(); }
    catch (e) { S.say(S.err(e), 'error'); }
  };
  S.ACT.toggleTask = async function (el) {
    var t = S.me.tasks.filter(function (x) { return x.id === el.getAttribute('data-id'); })[0]; if (!t) return;
    var was = t.done; t.done = !was; renderPlan(); S.haptic();                 // optimistic
    try { await S.api('/tasks/' + t.id, 'PUT', { done: t.done }); } catch (e) { t.done = was; renderPlan(); S.say(S.err(e), 'error'); }
  };
  S.ACT.delTask = function (el) {
    var id = el.getAttribute('data-id');
    S.confirm('Delete this task?', async function () {
      try { await S.api('/tasks/' + id, 'DELETE'); S.me.tasks = S.me.tasks.filter(function (t) { return t.id !== id; }); renderPlan(); } catch (e) { S.say(S.err(e), 'error'); }
    });
  };
  S.ACT.taskPlay = function (el) { S.startFromTask(el.getAttribute('data-id')); };

  // ═════════════════════════════════════════════════════════════════════════
  // STATS VIEW
  // ═════════════════════════════════════════════════════════════════════════
  var statRange = 'week';
  async function renderStats() {
    var body = $('stBody');
    body.innerHTML = '<div class="st-seg st-seg-sm"><button data-act="range" data-r="week" class="' + (statRange === 'week' ? 'on' : '') + '">Week</button><button data-act="range" data-r="month" class="' + (statRange === 'month' ? 'on' : '') + '">Month</button></div><div id="stStatsBody"><div class="st-empty">Loading\u2026</div></div>';
    try {
      var d = await S.api('/stats?range=' + statRange);
      var color = {}; d.subjects.forEach(function (s) { color[s.subjectId || 'none'] = s.color; });
      var maxSec = Math.max(d.targetSec, d.days.reduce(function (m, r) { return Math.max(m, r.totalSec); }, 0)) || 1;
      var H = 150, tLine = Math.round(d.targetSec / maxSec * H), today = S.me ? S.me.today : '';
      var DAYN = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
      var bars = d.days.map(function (r, i) {
        var segs = r.bySubject.map(function (b) { return '<i style="height:' + Math.max(2, Math.round(b.sec / maxSec * H)) + 'px;background:' + (color[b.subjectId || 'none'] || '#B8B2A3') + '"></i>'; }).join('');
        var lab = statRange === 'week' ? DAYN[i] : (i % 5 === 0 ? r.day.slice(8) : '');
        return '<div class="st-col ' + (r.day === today ? 'today' : '') + '"><div class="st-stack" style="height:' + H + 'px">' + (segs || '<i class="st-nil"></i>') + '</div><span>' + lab + '</span></div>';
      }).join('');
      var bestLbl = d.best ? new Date(d.best.day + 'T12:00:00').toLocaleDateString('en-IN', { weekday: 'short' }) + ' ' + S.dur(d.best.sec) : '\u2014';
      $('stStatsBody').innerHTML = '<div class="st-cards3"><div><small>' + (statRange === 'week' ? 'This week' : '30 days') + '</small><b>' + S.dur(d.totalSec) + '</b></div><div><small>Daily avg</small><b>' + S.dur(d.avgSec) + '</b></div><div><small>Best day</small><b>' + bestLbl + '</b></div></div>' +
        '<div class="st-card"><div class="st-card-t">Which subject, each day</div><div class="st-chart" role="img" aria-label="Daily study time by subject"><div class="st-tline" style="bottom:' + (tLine + 22) + 'px"><span>target</span></div><div class="st-cols ' + statRange + '">' + bars + '</div></div></div>' +
        '<div class="st-card"><div class="st-card-t">Subject-wise</div>' + (d.subjects.length ? d.subjects.map(function (s) {
          return '<div class="st-srow"><div class="st-srow-h"><i class="st-dot" style="background:' + s.color + '"></i><span>' + esc(s.name) + '</span><b>' + S.dur(s.sec) + '</b></div><div class="st-bar"><div style="width:' + s.pct + '%;background:' + s.color + '"></div></div></div>';
        }).join('') : '<div class="st-empty">Start a timer to see your subject-wise time here.</div>') + '</div>';
    } catch (e) { $('stStatsBody').innerHTML = '<div class="st-empty">' + esc(S.err(e)) + '</div>'; }
  }
  S.ACT.range = function (el) { statRange = el.getAttribute('data-r'); renderStats(); };

  // ── Home page "Today's study" card ──────────────────────────────────────────
  S.homeCard = async function () {
    var el = $('homeStudyCard'); if (!el) return;
    try {
      var me = await S.api('/me'); S.me = me;
      var tgt = me.profile.dailyTargetMin * 60, done = me.summary.totalSec, pct = Math.min(100, Math.round(done / tgt * 100));
      var ci = window.HomeUI && HomeUI.continueInfo ? HomeUI.continueInfo() : null;
      el.innerHTML =
        '<div class="hm-goal-l"><div class="hm-eyebrow">Today\'s goal</div>' +
        '<div class="hm-goal-t">' + esc(ci ? ci.title : 'Pick a lecture to start') + '</div>' +
        '<button class="hm-goal-btn" onclick="HomeUI.goContinue(event)"><i class="ti ti-player-play-filled"></i>' + (ci ? 'Open lecture' : 'Start studying') + '</button></div>' +
        '<div class="hm-ring"><svg viewBox="0 0 96 96" aria-hidden="true"><circle class="bg" cx="48" cy="48" r="40"/><circle class="fg" cx="48" cy="48" r="40" stroke-dasharray="251" stroke-dashoffset="' + (251 * (1 - pct / 100)) + '" transform="rotate(-90 48 48)"/></svg>' +
        '<div class="hm-ring-in"><b>' + pct + '%</b><small>' + S.dur(done) + ' / ' + S.dur(tgt) + '</small></div></div>';
      el.style.display = 'flex';
      var st = $('hmStreakTxt'); if (st) st.textContent = me.streak ? me.streak + ' day streak' : 'Start a streak';
    } catch (_) { el.style.display = 'none'; }                 // not logged in yet / offline: just hide the card
  };
  (function bootHome() { var n = 0; (function t() { if (tg && tg.initData) S.homeCard(); else if (n++ < 12) setTimeout(t, 500); })(); })();

  // Resume loops if a timer was already running when the page loaded
  document.addEventListener('visibilitychange', function () { if (!document.hidden && T.phase !== 'idle') { tick(); beat(); } });
})();
