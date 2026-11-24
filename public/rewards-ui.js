/**
 * rewards-ui.js
 *  - "Rewards" = the old Access / Refer / Earn pages behind ONE bottom-nav tab, with a segmented switch on top
 *    of each page (the pages and their logic are unchanged).
 *  - "Profile" page: the Admin button and the theme toggle moved here from the crowded Home topbar
 *    (same DOM nodes, same ids, so all existing JS keeps working).
 */
(function () {
  var tg = window.Telegram && window.Telegram.WebApp;
  var R = window.RewardsUI = {};
  var TABS = ['earn', 'refer', 'access'];
  var LABELS = { earn: 'Spin & Earn', refer: 'Refer', access: 'Access' };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  function injectSegments() {
    TABS.forEach(function (t) {
      var page = $('page-' + t);
      if (!page || page.querySelector('.rw-seg')) return;
      var seg = document.createElement('div');
      seg.className = 'rw-seg';
      seg.setAttribute('role', 'tablist');
      seg.innerHTML = TABS.map(function (k) {
        return '<button role="tab" aria-selected="' + (k === t) + '" class="' + (k === t ? 'on' : '') + '" onclick="switchNavTab(\'' + k + '\')">' + LABELS[k] + '</button>';
      }).join('');
      var head = page.querySelector('.page-header, .topbar');
      if (head) head.insertAdjacentElement('afterend', seg); else page.insertBefore(seg, page.firstChild);
    });
  }

  function moveNodes() {
    var slot = $('pfAdminSlot'), admin = $('adminBtn');
    if (slot && admin && admin.parentNode !== slot) slot.appendChild(admin);          // keeps id + its show/hide logic
    var row = $('pfThemeRow'), toggle = document.querySelector('.theme-toggle');
    if (row && toggle && toggle.parentNode !== row) row.appendChild(toggle);
  }

  // Called from switchNavTab(): highlight the right dock tab
  R.onTab = function (tab) {
    document.body.classList.toggle('no-fab', tab === 'study' || tab === 'profile');      // floating support button is in the way there
    if (tab === 'earn') R.fillRef();
    var nr = $('navRewards'), np = $('navProfile');
    if (nr) nr.classList.toggle('active', TABS.indexOf(tab) >= 0);
    if (np) np.classList.toggle('active', tab === 'profile');
  };

  // Spin & Earn shows a short referral code (the last part of the invite link) with a Copy button
  R.fillRef = function () {
    var box = $('rwRefCode'); if (!box) return;
    var link = (typeof getReferLink === 'function') ? getReferLink() : '';
    if (link) window._referLink = link;                                      // copyReferLink() reads this
    box.textContent = link ? (link.split('start=')[1] || link) : 'Open via Telegram';
  };

  R.renderProfile = function () {
    var u = {};
    try { u = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || {}; } catch (_) {}
    var name = ((u.first_name || '') + ' ' + (u.last_name || '')).trim() || 'Student';
    if ($('pfName')) $('pfName').textContent = name;
    if ($('pfSub')) $('pfSub').textContent = u.username ? '@' + u.username : (u.id ? 'ID ' + u.id : '');
    var av = $('pfAv');
    if (av) av.innerHTML = u.photo_url ? '<img src="' + esc(u.photo_url) + '" alt="" referrerpolicy="no-referrer">' : esc(name.charAt(0).toUpperCase());
  };

  R.contact = function () {
    var url = window._contactLink || (window._botUsername ? 'https://t.me/' + window._botUsername : '');
    if (!url) return;
    if (typeof openLink === 'function') openLink(url, 'contact');
    else if (tg && tg.openTelegramLink) tg.openTelegramLink(url);
  };

  // When ads are paused the app hides Earn + Access and keeps only Refer (see applyModerationUI in index.html).
  // Rewards then opens Refer directly, the segmented switch disappears and Profile drops its Access row.
  R.setAdsPaused = function (paused) {
    document.body.classList.toggle('ads-paused', !!paused);
    var nr = $('navRewards');
    if (nr) nr.setAttribute('onclick', "switchNavTab('" + (paused ? 'refer' : 'earn') + "')");
    var label = nr && nr.querySelector('.nav-label'); if (label) label.textContent = paused ? 'Refer' : 'Rewards';
  };

  // While a text field is focused the on-screen keyboard shrinks the viewport and the fixed bottom dock would
  // float above the keyboard. Hide the dock while typing, on every page.
  var TEXTY = /^(text|search|email|url|tel|number|password|)$/i;
  function isTextField(el) { return !!el && ((el.tagName === 'INPUT' && TEXTY.test(el.type || '')) || el.tagName === 'TEXTAREA'); }
  document.addEventListener('focusin', function (e) { if (isTextField(e.target)) document.body.classList.add('kb-open'); });
  document.addEventListener('focusout', function (e) {
    if (!isTextField(e.target)) return;
    setTimeout(function () { if (!isTextField(document.activeElement)) document.body.classList.remove('kb-open'); }, 150);
  });

  function init() { injectSegments(); moveNodes(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
