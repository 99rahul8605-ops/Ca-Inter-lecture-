/**
 * admin-ui.js — Admin panel = dashboard (design) in front of the existing forms.
 * Opening the panel shows tiles; a tile opens the same form as before (via the original switchTab()),
 * with a back arrow to the dashboard. Tiles/rows the admin has no permission for are not shown.
 * The old tab row stays in the DOM (hidden) because switchTab() toggles it.
 */
(function () {
  var A = window.AdminUI = {};
  var $ = function (id) { return document.getElementById(id); };
  var TITLES = { batch: 'Add Batch', subject: 'Add Subject', chapter: 'Add Chapter', unit: 'Add Unit', lecture: 'Add Lecture',
    manage: 'Manage content', premium: 'Premium access', coupons: 'Coupons', admins: 'Admins & permissions' };
  var CONTENT = [['batch', 'Batch', '#FFD9C2'], ['subject', 'Subject', '#CDEBDD'], ['chapter', 'Chapter', '#DCD6F7'], ['unit', 'Unit', '#CFE6F5']];
  var MANAGE = [['manage', 'Manage content', 'ti-list'], ['premium', 'Premium access', 'ti-crown'], ['coupons', 'Coupons', 'ti-ticket'], ['admins', 'Admins & permissions', 'ti-shield']];
  var allowed = function (n) { return typeof _adminTabAllowed === 'function' ? !!_adminTabAllowed(n) : true; };
  var esc = function (s) { return String(s).replace(/&/g, '&amp;'); };

  function dashHtml() {
    var h = '<div class="ad-top"><h1 class="ad-h1">Admin</h1><span class="ad-role">' + ((typeof isOwner !== 'undefined' && isOwner) ? 'Super admin' : 'Admin') + '</span></div>';
    var cont = CONTENT.filter(function (c) { return allowed(c[0]); }), hasLec = allowed('lecture');
    if (hasLec || cont.length) {
      h += '<div class="ad-lbl">Add content</div>';
      if (hasLec) h += '<button class="ad-big" onclick="AdminUI.go(\'lecture\')"><span class="ad-p ad-p-lg"><i class="ti ti-plus"></i></span><span class="ad-big-t"><b>Add Lecture</b><small>Bot link + notes</small></span></button>';
      if (cont.length) h += '<div class="ad-grid">' + cont.map(function (c) { return '<button class="ad-k" style="background:' + c[2] + '" onclick="AdminUI.go(\'' + c[0] + '\')"><span class="ad-p"><i class="ti ti-plus"></i></span>' + c[1] + '</button>'; }).join('') + '</div>';
    }
    var rows = MANAGE.filter(function (r) { return allowed(r[0]); });
    if (rows.length) h += '<div class="ad-lbl">Manage</div><div class="ad-rows">' + rows.map(function (r) { return '<button class="ad-r" onclick="AdminUI.go(\'' + r[0] + '\')"><span class="ad-p"><i class="ti ' + r[2] + '"></i></span><span class="ad-r-t">' + esc(r[1]) + '</span><i class="ti ti-chevron-right"></i></button>'; }).join('') + '</div>';
    return h;
  }

  A.show = function (view, name) {
    var m = $('adminModal'); if (!m) return;
    m.classList.toggle('ad-dash', view === 'dash'); m.classList.toggle('ad-form', view === 'form');
    if (view === 'dash') $('adminDash').innerHTML = dashHtml();
    else $('adminFormHead').innerHTML = '<button class="ad-back" aria-label="Back to Admin" onclick="AdminUI.back()"><i class="ti ti-arrow-left"></i></button><div><div class="ad-sub">Admin</div><h2 class="ad-h2">' + esc(TITLES[name] || 'Admin') + '</h2></div>';
  };
  A.go = function (name) { switchTab(name); };               // original function loads the form's data; the wrapper below shows it
  A.back = function () { A.show('dash'); };

  var _st = window.switchTab;
  window.switchTab = function (name) {
    var r = _st.apply(this, arguments);
    if (allowed(name) && $('adminModal') && $('adminModal').classList.contains('show')) A.show('form', name);
    return r;
  };
  var _oa = window.openAdmin;
  window.openAdmin = function (tab) {
    var r = _oa.apply(this, arguments);
    if ($('adminModal') && $('adminModal').classList.contains('show')) A.show(tab && allowed(tab) ? 'form' : 'dash', tab);
    return r;
  };
})();
