/* Shared sidebar for every app page. Placed right after the page's <nav class="rail">, it
   replaces that nav's links with one grouped menu, keeps the ids each page's script writes to
   (navReq, navAtt, sync, navClients), marks where you are from the URL, and asks the browser to
   preload pages on hover so moving between them is instant. */
(function () {
  var rail = document.currentScript && document.currentScript.previousElementSibling;
  if (!rail || !rail.classList || !rail.classList.contains('rail')) rail = document.querySelector('nav.rail');
  if (!rail || rail.dataset.dc) return;
  var file = location.pathname.split('/').pop() || 'index.html';
  var has = function (id) { return !!rail.querySelector('#' + id); };
  var syncEl = rail.querySelector('#sync');
  var keep = { navReq: has('navReq'), navAtt: has('navAtt'), sync: !!syncEl, navClients: has('navClients') };
  var syncText = syncEl ? syncEl.textContent : '';
  var I = {
    home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-6h4v6"/>',
    src: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
    req: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>',
    fac: '<path d="M3 21V10l5 3V10l5 3V6l8 4v11z"/>',
    cli: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18.5 14.5c1.9.8 3 2.7 3 5.5"/>',
    rate: '<path d="M4 20V4M4 20h16"/><path d="M8 16v-5M12 16V8M16 16v-3"/>',
    qc: '<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z"/><path d="M9 12l2 2 4-4"/>',
    ord: '<path d="M6 3h9l3 3v15H6z"/><path d="M9 10h6M9 14h6"/>',
    prod: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
    def: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5M12 16.5v.01"/>',
    sup: '<path d="M3 21h18M5 21V8l7-4 7 4v13"/><path d="M9 21v-5h6v5"/>',
    web: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.6 2.5 14.4 0 17M12 3.5c-2.5 2.6-2.5 14.4 0 17"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    acct: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20c1.2-3.6 4-5.5 7-5.5s5.8 1.9 7 5.5"/>'
  };
  var svg = function (k) { return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + I[k] + '</svg>'; };
  var link = function (k, href, label, icon, badge) {
    return '<a class="nv" data-k="' + k + '" href="' + href + '">' + svg(icon) + '<span>' + label + '</span>' +
      (badge !== undefined ? '<small' + (badge ? ' id="' + badge + '"' : '') + '></small>' : '') + '</a>';
  };
  var group = function (g, label, icon, items) {
    return '<div class="grp" data-g="' + g + '"><div class="gh">' + svg(icon) + '<span>' + label + '</span></div><div class="gl">' + items + '</div></div>';
  };
  // The Quality (QC) pages are kept in the codebase but hidden while Lathe focuses on sourcing.
  // Flip this to true to bring the Quality section back.
  var SHOW_QC = false;
  window.LATHE_SHOW_QC = SHOW_QC;
  rail.dataset.dc = '1';
  rail.innerHTML =
    '<a class="brand" href="./"><i aria-hidden="true"></i>Lathe</a>' +
    link('home', './', 'Home', 'home') +
    group('src', 'Sourcing', 'src',
      link('requests', 'sourcing.html#/requests', 'Requests', 'req', keep.navReq ? 'navReq' : '') +
      link('factories', 'sourcing.html#/factories', 'Factories', 'fac') +
      link('clients', 'sourcing.html#/clients', 'Clients', 'cli')) +
    (SHOW_QC ? group('qc', 'Quality', 'qc',
      link('orders', 'ops.html#/orders', 'Orders', 'ord', keep.navAtt ? 'navAtt' : '') +
      link('products', 'app.html', 'Products', 'prod') +
      link('defects', 'ops.html#/defects', 'Defects', 'def') +
      link('suppliers', 'ops.html#/suppliers', 'Suppliers', 'sup')) : '') +
    (keep.navClients ? '<div class="sect">Your clients</div><div class="clients" id="navClients"></div><a class="nv quiet" href="sourcing.html#/clients">' + svg('plus') + '<span>Add a client</span></a>' : '') +
    '<div class="grow"></div>' +
    '<a class="nv quiet" data-k="account" href="sourcing.html#/account">' + svg('acct') + '<span>Account &amp; team</span></a>' +
    '<a class="nv quiet" data-k="rates" href="sourcing.html#/rates">' + svg('rate') + '<span>Rate cards</span></a>' +
    '<a class="nv quiet" href="site/">' + svg('web') + '<span>Website</span></a>' +
    '<div class="meta"' + (keep.sync ? ' id="sync"' : '') + '>' + (syncText || '') + '</div>';

  function where() {
    var h = location.hash || '';
    if (file === 'index.html') return 'home';
    if (file === 'app.html') return 'products';
    if (file === 'sourcing.html') return /^#\/(factories|factory)/.test(h) ? 'factories' : /^#\/clients/.test(h) ? 'clients' : /^#\/rates/.test(h) ? 'rates' : /^#\/(account|join)/.test(h) ? 'account' : 'requests';
    if (file === 'ops.html') return /^#\/defects/.test(h) ? 'defects' : /^#\/suppliers/.test(h) ? 'suppliers' : 'orders';
    return '';
  }
  function mark() {
    var k = where();
    rail.querySelectorAll('a.nv').forEach(function (a) { if (a.dataset.k === k) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    rail.querySelectorAll('.grp').forEach(function (g) { g.classList.toggle('on', !!g.querySelector('[aria-current="page"]')); });
  }
  mark();
  window.addEventListener('hashchange', mark);

  // Updates: what other people (clients, teammates, factory inspections, background searches) did since you last
  // looked. Reads the activity timeline with the signed-in user's own token, so it only sees their workspace.
  (function updates() {
    var cfg = window.DEFECT_CHECK_CONFIG || {}, tok = null, me = null;
    try { Object.keys(localStorage).forEach(function (k) { if (/^sb-.*-auth-token$/.test(k)) { var v = JSON.parse(localStorage.getItem(k)); if (v && v.access_token) { tok = v.access_token; me = v.user && v.user.email; } } }); } catch (e) {}
    if (!tok || !cfg.supabaseUrl || /[?&](f|demo)=/.test(location.search) || file === 'login.html' || file === 'portal.html') return;
    var ws = null; try { ws = localStorage.getItem('lathe-ws'); } catch (e) {}
    var SEEN = 'lathe-updates-seen', seen = 0; try { seen = +localStorage.getItem(SEEN) || 0; } catch (e) {}
    var home = rail.querySelector('a.nv[data-k="home"]'); if (!home) return;
    var btn = document.createElement('a'); btn.href = '#'; btn.className = 'nv'; btn.setAttribute('role', 'button');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 8 3 8H3s3-1 3-8"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/></svg><span>Updates</span><small class="nb" style="display:none"></small>';
    home.insertAdjacentElement('afterend', btn);
    var css = document.createElement('style');
    css.textContent = '#updPop{position:fixed;z-index:9990;width:min(380px,calc(100vw - 24px));max-height:70vh;overflow:auto;background:var(--panel,#fff);border:1px solid var(--line,#ececec);border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.18);padding:8px}' +
      '#updPop a{display:block;padding:10px 12px;border-radius:10px;color:inherit;text-decoration:none;font-size:13.5px;line-height:1.45}#updPop a:hover{background:var(--sunk,#f3f3f1)}#updPop small{display:block;color:var(--muted,#86868b);font-size:12px}' +
      '#updPop a.new{background:var(--harbor-bg,#eaf2ff)}#updPop h4{margin:6px 12px 8px;font-size:13px;color:var(--muted,#86868b);text-transform:uppercase;letter-spacing:.06em}';
    document.head.appendChild(css);
    var items = [], titles = {};
    var H = { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + tok };
    var esc = function (x) { return String(x == null ? '' : x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
    var ago = function (d) { var m = (Date.now() - new Date(d)) / 60000; return m < 1 ? 'just now' : m < 60 ? Math.round(m) + ' min ago' : m < 1440 ? Math.round(m / 60) + ' h ago' : new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); };
    var fresh = function (a) { return new Date(a.at).getTime() > seen && a.actor !== me; };
    function paint() { var n = items.filter(fresh).length, b = btn.querySelector('.nb'); b.style.display = n ? '' : 'none'; b.textContent = n ? (n > 9 ? '9+' : n) : ''; }
    function load() {
      fetch(cfg.supabaseUrl + '/rest/v1/activity?select=at,actor,body,request_id&order=at.desc&limit=20' + (ws ? '&workspace_id=eq.' + ws : ''), { headers: H })
        .then(function (r) { return r.ok ? r.json() : []; }).then(function (rows) {
          items = Array.isArray(rows) ? rows : []; paint();
          var ids = items.map(function (a) { return a.request_id; }).filter(function (x, i, arr) { return x && !titles[x] && arr.indexOf(x) === i; });
          if (ids.length) fetch(cfg.supabaseUrl + '/rest/v1/sourcing_requests?select=id,title&id=in.(' + ids.join(',') + ')', { headers: H }).then(function (r) { return r.ok ? r.json() : []; }).then(function (rs) { (rs || []).forEach(function (x) { titles[x.id] = x.title; }); });
        }).catch(function () {});
    }
    function close() { var p = document.getElementById('updPop'); if (p) p.remove(); document.removeEventListener('click', outside, true); }
    function outside(e) { var p = document.getElementById('updPop'); if (p && !p.contains(e.target) && !btn.contains(e.target)) close(); }
    btn.onclick = function (e) {
      e.preventDefault(); if (document.getElementById('updPop')) return close();
      var p = document.createElement('div'); p.id = 'updPop';
      p.innerHTML = '<h4>Updates</h4>' + (items.length ? items.map(function (a) { return '<a class="' + (fresh(a) ? 'new' : '') + '" href="' + (a.request_id ? 'sourcing.html#/request/' + a.request_id : 'sourcing.html#/requests') + '">' + esc(a.body) + '<small>' + esc(titles[a.request_id] || '') + (titles[a.request_id] ? ' · ' : '') + esc(a.actor === me ? 'You' : (a.actor || 'Lathe')) + ' · ' + ago(a.at) + '</small></a>'; }).join('') : '<a>Nothing yet.</a>');
      var r = btn.getBoundingClientRect(); p.style.left = Math.min(r.right + 8, innerWidth - 392) + 'px'; p.style.top = Math.max(12, Math.min(r.top, innerHeight - 420)) + 'px';
      if (innerWidth < 760) { p.style.left = '12px'; p.style.top = (r.bottom + 8) + 'px'; }
      document.body.appendChild(p); setTimeout(function () { document.addEventListener('click', outside, true); }, 0);
      seen = Date.now(); try { localStorage.setItem(SEEN, String(seen)); } catch (e) {} paint();
    };
    load(); setInterval(load, 60000);
  })();

  // Products: show the sidebar straight away instead of after the page has loaded its data.
  if (file === 'app.html' && !/[?&](f|demo)=/.test(location.search)) document.body.classList.add('shell');

  // Preload a page as soon as the pointer rests on its link (Chrome and Edge), so the click is instant.
  try {
    if (HTMLScriptElement.supports && HTMLScriptElement.supports('speculationrules')) {
      var s = document.createElement('script'); s.type = 'speculationrules';
      s.textContent = JSON.stringify({ prerender: [{ source: 'document', where: { and: [{ selector_matches: '.rail a.nv, .rail a.brand' }, { not: { href_matches: '*site/*' } }] }, eagerness: 'moderate' }] });
      document.head.appendChild(s);
    }
  } catch (e) {}
})();
