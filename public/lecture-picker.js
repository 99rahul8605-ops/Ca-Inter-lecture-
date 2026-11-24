/**
 * lecture-picker.js
 * Replaces the long per-lecture rows with two big buttons (Lectures / Notes).
 * Each opens a bottom-sheet of small numbered cards in sequence; the student
 * ticks as many as they like and sends them to the bot in ONE tap.
 *
 * Needs these globals from index.html: _currentOpenBid, isLectureWatched,
 * markLectureWatched, apiFetch, openLink, toast.
 */
(function () {
  // Stored values are either a bare bot code ("RbZUHU") or a t.me link (same dual format as openLecLink()).
  // Anything else that looks like a web address (Drive, telegra.ph ...) can't be sent by the bot: it opens directly.
  function isBotRef(v) {
    v = String(v == null ? '' : v).trim();
    if (!v) return false;
    if (/^[A-Za-z0-9_-]{4,64}$/.test(v)) return true;
    return /^(https?:\/\/)?(www\.)?t(elegram)?\.me\//i.test(v);
  }
  function askConfirm(msg) {
    return new Promise(function (resolve) {
      try { if (window.Telegram && Telegram.WebApp && Telegram.WebApp.showConfirm) return Telegram.WebApp.showConfirm(msg, resolve); } catch (_) {}
      resolve(window.confirm(msg));
    });
  }
  function openExternal(url) {
    url = String(url).trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (typeof openLecLink === 'function') openLecLink(url, 'notes'); else openLink(url, 'notes');
  }
  var P = { bid: null, lectures: [], sel: { lecture: {}, notes: {} }, type: 'lecture', sending: false };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function hasLecture(l) { return !l.comingSoon && !!l.link; }
  function hasNotes(l) { return !l.comingSoon && !!l.notes; }
  // The bot keeps at most N lecture videos in a chat (the next one deletes the oldest) and N/day, so more than N
  // lectures at once would just be thrown away. Notes are not limited. The owner is exempt (same as the bot).
  function lecCap() { return window._isOwnerUser ? 30 : (window._maxActiveVideos || 3); }
  function selCount() { return Object.keys(P.sel.lecture).length + Object.keys(P.sel.notes).length; }

  // ── Two big buttons shown in place of the old row list ────────────────────
  function bigButtons() {
    var L = P.lectures;
    var lecN = L.filter(function (l) { return !l.comingSoon; }).length;
    var watched = L.filter(function (l) { return isLectureWatched(l._id); }).length;
    var notesN = L.filter(hasNotes).length;
    var nl = Object.keys(P.sel.lecture).length, nn = Object.keys(P.sel.notes).length;
    return '' +
      '<button class="lp-big lp-big-lec" onclick="LecPicker.open(\'lecture\')">' +
        '<span class="lp-ico"><i class="ti ti-player-play-filled"></i></span>' +
        '<span class="lp-txt"><b>Lectures</b><small>' + lecN + ' lectures \u00b7 ' + watched + ' watched</small></span>' +
        (nl ? '<span class="lp-badge">' + nl + '</span>' : '<i class="ti ti-chevron-right lp-arr"></i>') +
      '</button>' +
      (notesN
        ? '<button class="lp-big lp-big-notes" onclick="LecPicker.open(\'notes\')">' +
            '<span class="lp-ico"><i class="ti ti-notes"></i></span>' +
            '<span class="lp-txt"><b>Notes</b><small>' + notesN + ' notes</small></span>' +
            (nn ? '<span class="lp-badge">' + nn + '</span>' : '<i class="ti ti-chevron-right lp-arr"></i>') +
          '</button>'
        : '');
  }

  // Called from openChapter()/openUnit() instead of rendering one row per lecture.
  window._lecPickerHtml = function (lectures) {
    P.bid = (typeof _currentOpenBid !== 'undefined') ? _currentOpenBid : null;
    P.lectures = (lectures || []).slice();
    P.sel = { lecture: {}, notes: {} };
    if (!P.lectures.length) return '<div class="empty"><i class="ti ti-video"></i>No lectures yet</div>';
    return '<div class="lp-wrap" id="lpWrap">' + bigButtons() + '</div>';
  };

  function refreshButtons() { var w = document.getElementById('lpWrap'); if (w) w.innerHTML = bigButtons(); }

  // ── The sheet ─────────────────────────────────────────────────────────────
  function ensureSheet() {
    var el = document.getElementById('lpSheet');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'lpSheet';
    el.className = 'lp-sheet';
    el.innerHTML = '<div class="lp-dim" onclick="LecPicker.close()"></div>' +
      '<div class="lp-panel" role="dialog" aria-modal="true" aria-labelledby="lpTitle">' +
        '<div class="lp-grab"></div>' +
        '<div class="lp-head"><div><div class="lp-title" id="lpTitle"></div><div class="lp-sub" id="lpSub"></div></div>' +
        '<button class="lp-x" aria-label="Close" onclick="LecPicker.close()"><i class="ti ti-x"></i></button></div>' +
        '<div class="lp-quick"><button onclick="LecPicker.selectAll()">Select all</button><button class="lp-ghost" onclick="LecPicker.clear()">Clear</button></div>' +
        '<div class="lp-grid" id="lpGrid"></div>' +
        '<div class="lp-foot"><div class="lp-count" id="lpCount"></div>' +
        '<button class="lp-send" id="lpSend" onclick="LecPicker.send()"><i class="ti ti-brand-telegram"></i><span>Send to bot</span></button></div>' +
      '</div>';
    document.body.appendChild(el);
    return el;
  }

  function renderSheet() {
    var isLec = P.type === 'lecture';
    document.getElementById('lpTitle').textContent = isLec ? 'Select lectures' : 'Select notes';
    var list = P.lectures.map(function (l, i) { return { l: l, n: i + 1 }; })
      .filter(function (x) { return isLec ? true : hasNotes(x.l); });
    document.getElementById('lpSub').textContent = list.length + (isLec ? ' lectures \u00b7 max ' + lecCap() + ' at a time' : ' notes') + ' \u00b7 tap to select';
    var qb = document.querySelector('#lpSheet .lp-quick button');
    if (qb) qb.textContent = isLec ? 'Select first ' + lecCap() : 'Select all';
    document.getElementById('lpGrid').innerHTML = list.map(function (x) {
      var l = x.l, id = l._id, key = isLec ? 'lecture' : 'notes';
      var cls = 'lp-card', icon = '', attrs = '';
      if (l.comingSoon) { cls += ' lp-cs'; attrs = ' disabled'; }
      else if (isLec && !l.link) { cls += ' lp-lock'; icon = '<i class="ti ti-lock"></i>'; attrs = ' data-lock="1"'; }
      else if (!isLec && !isBotRef(l.notes)) { cls += ' lp-ext'; icon = '<i class="ti ti-external-link"></i>'; attrs = ' data-ext="1"'; }
      else if (P.sel[key][id]) { cls += ' lp-on'; icon = '<i class="ti ti-check"></i>'; attrs = ' aria-pressed="true"'; }
      else { if (isLec && isLectureWatched(id)) { cls += ' lp-done'; icon = '<i class="ti ti-check lp-dim-ic"></i>'; } attrs = ' aria-pressed="false"'; }
      return '<button class="' + cls + '"' + attrs + ' data-id="' + esc(id) + '" onclick="LecPicker.tap(this)">' +
        '<span class="lp-no">' + x.n + '</span><span class="lp-nm">' + esc(l.comingSoon ? 'Coming soon' : l.name) + '</span>' + icon + '</button>';
    }).join('');
    renderFoot();
  }

  function renderFoot() {
    var nl = Object.keys(P.sel.lecture).length, nn = Object.keys(P.sel.notes).length, n = nl + nn;
    var cnt = document.getElementById('lpCount'), btn = document.getElementById('lpSend');
    cnt.innerHTML = n ? '<b>' + n + ' selected</b><small>' + nl + ' lectures \u00b7 ' + nn + ' notes</small>' : '<small>Nothing selected yet</small>';
    btn.disabled = !n || P.sending;
    var label = 'Send to bot';
    if (n) label = 'Send ' + n + ' ' + (nn === 0 ? (n === 1 ? 'lecture' : 'lectures') : nl === 0 ? (n === 1 ? 'note' : 'notes') : (n === 1 ? 'item' : 'items')) + ' to bot';
    btn.querySelector('span').textContent = P.sending ? 'Preparing\u2026' : label;
  }

  var API = {
    open: function (type) {
      ensureSheet(); P.type = type === 'notes' ? 'notes' : 'lecture';
      renderSheet();
      document.getElementById('lpSheet').classList.add('lp-open');
    },
    close: function () { var s = document.getElementById('lpSheet'); if (s) s.classList.remove('lp-open'); refreshButtons(); },
    tap: function (btn) {
      var id = btn.getAttribute('data-id');
      var l = P.lectures.filter(function (x) { return x._id === id; })[0];
      if (!l) return;
      if (btn.getAttribute('data-lock')) { toast('Premium access required for this lecture', 'error'); return; }
      if (btn.getAttribute('data-ext')) { openExternal(l.notes); return; }
      var key = P.type === 'notes' ? 'notes' : 'lecture';
      if (P.sel[key][id]) delete P.sel[key][id];
      else {
        if (key === 'lecture' && Object.keys(P.sel.lecture).length >= lecCap()) {
          toast('Ek time pe max ' + lecCap() + ' lectures select ho sakte hain. Pehle koi hatao.', 'error');
          try { Telegram.WebApp.HapticFeedback.notificationOccurred('warning'); } catch (_) {}
          return;
        }
        P.sel[key][id] = true;
      }
      renderSheet();
    },
    selectAll: function () {
      var key = P.type === 'notes' ? 'notes' : 'lecture';
      P.lectures.forEach(function (l) {
        if (key === 'lecture' && Object.keys(P.sel.lecture).length >= lecCap()) return;      // stop at the cap
        if (key === 'lecture' ? hasLecture(l) : (hasNotes(l) && isBotRef(l.notes))) P.sel[key][l._id] = true;
      });
      renderSheet();
    },
    clear: function () { P.sel = { lecture: {}, notes: {} }; renderSheet(); },
    send: async function () {
      if (P.sending || !selCount()) return;
      var items = [];
      P.lectures.forEach(function (l) {                       // sequence order, lecture then its notes
        if (P.sel.lecture[l._id]) items.push({ lectureId: l._id, type: 'lecture' });
        if (P.sel.notes[l._id]) items.push({ lectureId: l._id, type: 'notes' });
      });
      P.sending = true; renderFoot();
      try {
        var res = await apiFetch('/api/lectures/send', 'POST', { batchId: P.bid, items: items });
        if (!res.link) {
          var rs = (res.skipped || []).map(function (s) { return s.reason; });
          var why = rs.indexOf('no_access') >= 0 ? 'Premium access required for the selected lectures.'
            : rs.indexOf('not_found') >= 0 ? 'These files are not available in the bot yet. Ask the admin to re-upload.'
            : rs.indexOf('unsupported_link') >= 0 ? 'These links are not Telegram files, so they cannot be sent to the bot.'
            : 'Could not send these. They may be locked or unavailable.';
          toast(why, 'error'); return;
        }
        if (res.replaces > 0 && !(await askConfirm('Aapke chat ke ' + res.replaces + ' purane lecture video hat jayenge (ek time pe max ' + (res.max || lecCap()) + ' videos). Continue?'))) return;
        var skip = {}; (res.skipped || []).forEach(function (s) { skip[s.lectureId + ':' + s.type] = true; });
        items.forEach(function (it) { if (it.type === 'lecture' && !skip[it.lectureId + ':lecture'] && typeof markLectureWatched === 'function') markLectureWatched(it.lectureId); });
        if ((res.skipped || []).length) toast((res.skipped.length) + ' item(s) skipped (locked or unavailable)', 'error');
        P.sel = { lecture: {}, notes: {} };
        API.close();
        openLink(res.link, 'lecture');
      } catch (e) {
        var msg = 'Something went wrong. Try again.';
        try { msg = JSON.parse(e.message).error || msg; } catch (_) { if (e.message && e.message.length < 120) msg = e.message; }
        toast(msg, 'error');
      } finally { P.sending = false; if (document.getElementById('lpSend')) renderFoot(); }
    }
  };
  window.LecPicker = API;
})();
