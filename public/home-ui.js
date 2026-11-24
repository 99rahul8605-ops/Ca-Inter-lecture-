/**
 * home-ui.js — the Home screen from the approved design:
 *   header · headline · "Today's goal" card · chips (search / All / Free / Premium / Saved)
 *   · bento batch tiles (1 big + 2 small) · lime "Spin & earn" strip.
 *
 * It replaces renderBatches() / switchBatchTab() from index.html (same names, loaded later) and keeps every
 * batch feature: favourite, lock, Buy, Free Redeem, View Demo, reward-access timer, admin draft badge.
 * Needs these globals from index.html: batches, canManageContent, canBypassRestrictions, getUserId,
 * hasBatchRewardAccess, myActiveBatchRewards, fmtRewardDuration, isFavoriteBatch, _loadFavorites,
 * toggleFavoriteBatch, _getAllDemoLectures, isLectureWatched, openBatch, buyBatch, openDemoModal.
 */
(function () {
  var H = window.HomeUI = {};
  var COLORS = ['#FFD9C2', '#CDEBDD', '#DCD6F7', '#CFE6F5'];     // peach · mint · lavender · sky (design palette)
  var filter = 'all', lastHtml = null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function initials(name) {
    var w = String(name || '?').trim().split(/\s+/);
    return esc(((w[0] || '?').charAt(0) + (w[1] ? w[1].charAt(0) : (w[0] || '').charAt(1) || '')).toUpperCase());
  }
  // watched / total lectures of a batch (lectures inside units count too; "coming soon" ones don't)
  function progress(b) {
    var total = 0, done = 0;
    (b.subjects || []).forEach(function (s) {
      (s.chapters || []).forEach(function (c) {
        var all = (c.lectures || []).slice();
        (c.units || []).forEach(function (u) { all = all.concat(u.lectures || []); });
        all.forEach(function (l) { if (l.comingSoon) return; total++; if (isLectureWatched(l._id)) done++; });
      });
    });
    return { total: total, done: done, pct: total ? Math.round(done / total * 100) : 0 };
  }

  // ── one tile ──────────────────────────────────────────────────────────────────
  function tile(b, locked, color, size) {
    var prem = !!b.isPremium, fav = isFavoriteBatch(b._id), pr = progress(b);
    var draft = canManageContent() && b.isPublic !== true;
    var badge = (prem ? '<span class="bt-badge bt-prem"><i class="ti ti-crown"></i>PREMIUM</span>' : '<span class="bt-badge">FREE</span>') +
      (draft ? '<span class="bt-badge bt-draft"><i class="ti ti-lock"></i>DRAFT</span>' : '');
    var heart = '<button class="bt-fav' + (fav ? ' on' : '') + '" aria-label="' + (fav ? 'Remove from saved' : 'Save batch') + '" onclick="event.stopPropagation();toggleFavoriteBatch(\'' + b._id + '\')"><i class="ti ' + (fav ? 'ti-heart-filled' : 'ti-heart') + '"></i></button>';

    var meta = (b.subjects || []).length + ' subjects';
    if (locked) meta += ' · <span class="bt-lock"><i class="ti ti-lock"></i>Locked</span>';
    else {
      if (pr.total) meta += ' · ' + pr.pct + '% done';
      if (b.price) meta += ' · <span class="bt-price">₹' + esc(b.price) + '</span>';
    }
    if (!locked && prem && !canBypassRestrictions()) {                       // temporary (reward) access: show the time left
      var perm = !!(b.premiumUsers && b.premiumUsers.indexOf(String(getUserId())) >= 0);
      if (!perm && hasBatchRewardAccess(b._id)) meta += ' · <span class="bt-gift">🎁 ' + esc(fmtRewardDuration(myActiveBatchRewards[b._id] - new Date())) + '</span>';
    }

    var demo = _getAllDemoLectures(b);
    var buy = locked ? '<button class="batch-buy-btn" data-bid="' + b._id + '" onclick="event.stopPropagation();buyBatch(this.dataset.bid)"><i class="ti ti-shopping-cart"></i> Buy' + (b.price ? ' ₹' + esc(b.price) : '') + '</button>' : '';
    var redeem = (locked && prem && b.rewardEligible !== false) ? '<button class="batch-redeem-btn" onclick="event.stopPropagation();switchNavTab(\'refer\')"><i class="ti ti-gift"></i> Free Redeem</button>' : '';
    var view = (!locked && prem) ? '' : (demo.length ? '<button class="batch-view-btn" data-bid="' + b._id + '" onclick="event.stopPropagation();openDemoModal(this.dataset.bid)"><i class="ti ti-player-play"></i> View Demo</button>' : '');
    var acts = (buy || redeem || view) ? '<div class="bt-acts">' + view + buy + redeem + '</div>' : '';

    var big = size === 'big' || size === 'wide';
    var bar = big ? '<div class="bt-bar"><i style="width:' + pr.pct + '%"></i></div>' : '';
    var arrow = big ? '' : '<i class="ti ti-arrow-up-right bt-arrow"></i>';
    return '<div class="bt-tile bt-' + size + (draft ? ' is-draft' : '') + '" style="background:' + color + '" role="button" tabindex="0" onclick="openBatch(\'' + b._id + '\')" onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();openBatch(\'' + b._id + '\')}">' +
      (big ? '<span class="bt-wm" aria-hidden="true">' + initials(b.name) + '</span>' : '') +
      '<div class="bt-top"><div class="bt-badges">' + badge + '</div><div class="bt-right">' + heart + arrow + '</div></div>' +
      '<div class="bt-bot"><div class="bt-name">' + esc(b.name) + '</div><div class="bt-sub">' + meta + '</div>' + bar + acts + '</div></div>';
  }

  // 3 tiles = [big | small + small]; the big side alternates. Leftover: 2 -> side by side, 1 -> full width.
  function layout(items) {
    var out = '', i = 0, n = items.length, row = 0;
    var T = function (k, size) { return tile(items[k].b, items[k].locked, COLORS[k % COLORS.length], size); };
    while (n - i >= 3) {
      var bigT = T(i, 'big'), col = '<div class="bt-col">' + T(i + 1, 'small') + T(i + 2, 'small') + '</div>';
      out += '<div class="bt-row">' + (row % 2 ? col + bigT : bigT + col) + '</div>';
      i += 3; row++;
    }
    if (n - i === 2) out += '<div class="bt-row bt-half">' + T(i, 'small') + T(i + 1, 'small') + '</div>';
    else if (n - i === 1) out += '<div class="bt-row">' + T(i, 'wide') + '</div>';
    return out;
  }

  var EMPTY = {
    all: ['ti-school', 'No batches yet'], free: ['ti-school', 'No free batches yet'], premium: ['ti-crown', 'No premium batches yet'],
    favorite: ['ti-heart', 'No saved batches yet. Tap the heart on any batch.']
  };

  // Replaces the original renderBatches(list) from index.html
  window.renderBatches = function (list) {
    var el = $('batchBento'); if (!el) return;
    list = list || (typeof batches !== 'undefined' ? batches : []) || [];
    var visible = canManageContent() ? list : list.filter(function (b) { return b.isPublic === true; });
    visible = visible.slice().reverse();                                       // newest first
    var hasPrem = visible.some(function (b) { return b.isPremium === true; });
    var chip = $('hmChipPremium'); if (chip) chip.style.display = hasPrem ? '' : 'none';
    if (filter === 'premium' && !hasPrem) setFilterState('all');

    var uid = getUserId();
    var isLocked = function (b) {
      if (!b.isPremium) return false;
      var perm = !!(b.premiumUsers && b.premiumUsers.indexOf(String(uid)) >= 0);
      return !canBypassRestrictions() && !perm && !hasBatchRewardAccess(b._id);
    };
    var favs = filter === 'favorite' ? _loadFavorites() : null;
    var pool = visible.filter(function (b) {
      return filter === 'free' ? !b.isPremium : filter === 'premium' ? b.isPremium === true : filter === 'favorite' ? favs.indexOf(b._id) >= 0 : true;
    });
    var html = pool.length
      ? layout(pool.map(function (b) { return { b: b, locked: isLocked(b) }; }))
      : '<div class="empty"><i class="ti ' + EMPTY[filter][0] + '"></i>' + EMPTY[filter][1] + '</div>';
    if (html !== lastHtml) { el.innerHTML = html; lastHtml = html; }          // the list auto-refreshes every 5s: only touch the DOM on change
  };

  // ── chips / search ────────────────────────────────────────────────────────────
  function setFilterState(f) {
    filter = f; window._activeBatchTab = f === 'all' ? 'free' : f;
    var chips = document.querySelectorAll('#hmChips .hm-chip');
    for (var i = 0; i < chips.length; i++) { var on = chips[i].getAttribute('data-f') === f; chips[i].classList.toggle('on', on); chips[i].setAttribute('aria-pressed', on); }
  }
  H.setFilter = function (f) {
    setFilterState(f); lastHtml = null;
    var q = $('searchInput') && $('searchInput').value;
    if (q && typeof handleSearch === 'function') handleSearch(q); else window.renderBatches(typeof batches !== 'undefined' ? batches : []);
  };
  window.switchBatchTab = function (tab) { H.setFilter(tab === 'favorite' ? 'favorite' : tab === 'premium' ? 'premium' : 'free'); };

  H.toggleSearch = function () {
    var box = $('hmSearch'), btn = $('hmSearchBtn'), inp = $('searchInput'); if (!box) return;
    var open = box.hasAttribute('hidden');
    if (open) { box.removeAttribute('hidden'); if (inp) inp.focus(); }
    else { box.setAttribute('hidden', ''); if (inp && inp.value) { inp.value = ''; if (typeof handleSearch === 'function') handleSearch(''); } }
    if (btn) { btn.setAttribute('aria-expanded', open); btn.classList.toggle('on', open); }
  };

  // ── rewards strip (live access timer) ─────────────────────────────────────────
  H.openRewards = function () { switchNavTab(window._adsPaused ? 'refer' : 'earn'); };
  H.syncStrip = function () {
    var strip = $('hmStrip'), sub = $('hmStripSub'); if (!strip) return;
    if (window._adsPaused) { strip.style.display = 'none'; return; }               // moderation mode: no ad/earn features
    strip.style.display = '';
    var t = (typeof getTimeLeft === 'function') ? getTimeLeft() : null;
    if (sub) sub.textContent = t ? 'Access left: ' + formatCountdown() : 'Watch an ad to unlock lectures';
    var rt = $('rwTimerTxt'); if (rt) rt.textContent = t ? formatCountdown() : 'No access';             // Spin & Earn header pill
  };
  var _uht = window.updateHomeTimer;                                                // refresh the strip whenever the old timer ticks
  if (typeof _uht === 'function') window.updateHomeTimer = function () { try { return _uht.apply(this, arguments); } finally { H.syncStrip(); } };
  setInterval(H.syncStrip, 2000);

  // ── "continue" memory for the goal card ───────────────────────────────────────
  var _oc = window.openChapter;
  if (typeof _oc === 'function') window.openChapter = function (bid, sid, cid) {
    try { localStorage.setItem('edubot_continue', JSON.stringify({ bid: bid, sid: sid, cid: cid })); } catch (_) {}
    return _oc.apply(this, arguments);
  };
  H.continueInfo = function () {
    try {
      var c = JSON.parse(localStorage.getItem('edubot_continue') || 'null'); if (!c || typeof batches === 'undefined') return null;
      var b = batches.filter(function (x) { return x._id === c.bid; })[0]; if (!b) return null;
      var s = (b.subjects || []).filter(function (x) { return x._id === c.sid; })[0]; if (!s) return null;
      var ch = (s.chapters || []).filter(function (x) { return x._id === c.cid; })[0]; if (!ch) return null;
      return { bid: c.bid, sid: c.sid, cid: c.cid, title: ch.name, sub: s.name };
    } catch (_) { return null; }
  };
  H.goContinue = function (ev) {
    if (ev && ev.stopPropagation) ev.stopPropagation();
    var c = H.continueInfo();
    if (c) openChapter(c.bid, c.sid, c.cid); else switchNavTab('study');
  };

  setFilterState('all');
})();
