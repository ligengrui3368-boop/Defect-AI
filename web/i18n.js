/* Lathe language switch (English / 中文).
   Loaded in <head>. When Chinese is on, it translates the page's text and placeholders from
   the translations table, keeps translating whatever the page renders later, and shows an EN / 中文 switch.
   Factory pages (app.html?f=…, po.html) have their own Chinese mode and are left alone. */
(function () {
  if (/[?&](f|demo)=/.test(location.search)) return;
  var KEY = 'lathe-lang';
  var lang = 'en';
  try { lang = localStorage.getItem(KEY) || ((navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'); } catch (e) {}
  var zh = lang === 'zh';
  window.LatheLang = lang;
  var root = document.documentElement;
  if (zh) { root.lang = 'zh-CN'; root.classList.add('i18n-wait'); setTimeout(function () { root.classList.remove('i18n-wait'); }, 1500); }

  var css = document.createElement('style');
  css.textContent = 'html.i18n-wait body{visibility:hidden}' +
    '.lang-switch{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:999px;border:1px solid rgba(127,127,127,.28);background:rgba(127,127,127,.08);color:inherit;font:600 12.5px/1 Inter,system-ui,-apple-system,"PingFang SC",sans-serif;cursor:pointer;user-select:none;flex-shrink:0}' +
    '.lang-switch span{padding:6px 10px;border-radius:999px;color:inherit;opacity:.55;transition:background .15s ease,opacity .15s ease}' +
    '.lang-switch span.on{opacity:1;background:#fff;color:#1d1d1f;box-shadow:0 1px 2px rgba(0,0,0,.12)}' +
    '.lang-switch:hover span:not(.on){opacity:.85}.lang-switch:active{transform:scale(.96)}' +
    '.rail .lang-switch{margin:-4px 2px 14px;align-self:flex-start}' +
    '.lang-float{position:fixed;right:16px;bottom:16px;z-index:50}';
  document.head.appendChild(css);

  var D = {};
  var MON = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12, January: 1, February: 2, March: 3, April: 4, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
  var WD = { Mon: '周一', Tue: '周二', Wed: '周三', Thu: '周四', Fri: '周五', Sat: '周六', Sun: '周日', Monday: '星期一', Tuesday: '星期二', Wednesday: '星期三', Thursday: '星期四', Friday: '星期五', Saturday: '星期六', Sunday: '星期日' };
  var M = '(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec|January|February|March|April|June|July|August|September|October|November|December)';
  var plural = function (n) { return n.replace(/,/g, ''); };
  // Sentences built from numbers and names: rewritten as a whole.
  var RULES = [
    [new RegExp('^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), ' + M + ' (\\d{1,2})\\. ?(.*)$'), function (m, w, mo, d, rest) { return MON[mo] + '月' + d + '日 ' + WD[w] + '。' + (rest ? tr(rest) || rest : ''); }],
    [new RegExp('^' + M + ' (\\d{1,2}), (\\d{4})$'), function (m, mo, d, y) { return y + '年' + MON[mo] + '月' + d + '日'; }],
    [new RegExp('^' + M + ' (\\d{1,2})$'), function (m, mo, d) { return MON[mo] + '月' + d + '日'; }],
    [/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/, function (m, w) { return WD[w]; }],
    [/^Good (morning|afternoon|evening), (.+)$/, function (m, t, n) { return { morning: '早上好', afternoon: '下午好', evening: '晚上好' }[t] + '，' + n; }],
    [/^Hi (.+)$/, function (m, n) { return '你好，' + n; }],
    [/^(\d[\d,]*) requests? needs? you\.$/, function (m, n) { return '有 ' + n + ' 个需求等你处理。'; }],
    [/^(\d[\d,]*) open requests?$/, function (m, n) { return n + ' 个进行中的需求'; }],
    [/^Answer (\d+) questions? from intake$/, function (m, n) { return '回答需求录入提出的 ' + n + ' 个问题'; }],
    [/^(\d+) factor(?:y is|ies are) waiting on you$/, function (m, n) { return n + ' 家工厂在等你回复'; }],
    [/^Negotiating with (\d+|the) factor(?:y|ies)$/, function (m, n) { return n === 'the' ? '正在与工厂谈判' : '正在与 ' + n + ' 家工厂谈判'; }],
    [/^(\d[\d,]*) units$/, function (m, n) { return n + ' 件'; }],
    [/^target (.+)$/, function (m, v) { return '目标 ' + v; }],
    [/^created (.+)$/, function (m, v) { return '创建于 ' + (tr(v) || v); }],
    [/^HTS (.+)$/, function (m, v) { return 'HTS ' + v; }],
    [/^(\d+) min ago$/, function (m, n) { return n + ' 分钟前'; }],
    [/^(\d+) h ago$/, function (m, n) { return n + ' 小时前'; }],
    [/^(\d+) closed\.$/, function (m, n) { return '已关闭 ' + n + ' 个。'; }],
    [/^(\d+) log entries$/, function (m, n) { return n + ' 条记录'; }],
    [/^(\d+) listings, (\d+) new, ranked (\d+)$/, function (m, a, b, c) { return '找到 ' + a + ' 个商品，新增 ' + b + ' 个，已排序 ' + c + ' 个'; }],
    [/^(Intake|Sourcing|Shortlist|Negotiating|Quoted|Approved|Ordered|Closed) (\d+)$/, function (m, s, n) { return (D[s] || s) + ' ' + n; }],
    [/^Duties & tariffs \(([\d.]+)%\)$/, function (m, p) { return '关税与加征关税（' + p + '%）'; }],
    [/^Our commission \(([\d.]+)%\)$/, function (m, p) { return '我们的佣金（' + p + '%）'; }],
    [/^Lathe commission \(([\d.]+)%\)$/, function (m, p) { return 'Lathe 佣金（' + p + '%）'; }],
    [/^Effective (.+)$/, function (m, v) { return '生效日期 ' + (tr(v) || v); }],
    [/^Spec is ready for$/, function () { return '规格已整理好：'; }],
    [/^\. Rough factory price is around ¥([\d.]+) a unit\.$/, function (m, p) { return '。出厂价大约每件 ¥' + p + '。'; }],
    [/^I created$/, function () { return '已创建'; }],
    [/^, but intake failed: (.+)$/, function (m, e) { return '，但需求录入失败：' + e; }],
    [/^\$?([\d.,]+) \/ unit$/, function (m, v) { return m.replace(' / unit', ' / 件'); }],
    [/^Spec is ready for (.+)\. Rough factory price is around ¥([\d.]+) a unit\.$/, function (m, t, p) { return t + ' 的规格已整理好。出厂价大约每件 ¥' + p + '。'; }],
    [/^Spec is ready for (.+)\.$/, function (m, t) { return t + ' 的规格已整理好。'; }],
    [/^That didn't work: (.+)$/, function (m, e) { return '没有成功：' + e; }],
    [/^Saved\. Intake failed: (.+)$/, function (m, e) { return '已保存。需求录入失败：' + e; }],
    [/^(.+) · (.+)$/, function (m, a, b) { var x = tr(a), y = tr(b); return (x || y) ? (x || a) + ' · ' + (y || b) : null; }],
    [/^(.+), (.+)$/, function (m, a, b) { var x = tr(a), y = tr(b); return (x || y) ? (x || a) + '，' + (y || b) : null; }]
  ];
  function tr(s) {
    if (!s) return null;
    if (Object.prototype.hasOwnProperty.call(D, s)) return D[s];
    for (var i = 0; i < RULES.length; i++) {
      var r = RULES[i], m = s.match(r[0]);
      if (m) { var out = r[1].apply(null, m); if (out) return out; }
    }
    return null;
  }
  window.LatheT = function (s) { return zh ? (tr(s) || s) : s; };

  var SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 };
  function skipped(el) {
    for (var e = el; e && e.nodeType === 1; e = e.parentNode) {
      if (SKIP[e.tagName] || e.isContentEditable || e.getAttribute('translate') === 'no' || e.hasAttribute('data-noi18n')) return true;
    }
    return false;
  }
  function doText(n) {
    var raw = n.nodeValue; if (!raw || !/[A-Za-z]/.test(raw)) return;
    var t = raw.trim(); if (!t || skipped(n.parentNode)) return;
    var out = tr(t); if (out == null || out === t) return;
    var lead = raw.match(/^\s*/)[0], tail = raw.match(/\s*$/)[0];
    n.nodeValue = lead + out + tail;
  }
  var ATTRS = ['placeholder', 'title', 'aria-label'];
  function doEl(el) {
    // Text boxes keep what people type, but their placeholder and label are translated.
    if (el.tagName === 'TEXTAREA' ? (el.parentNode && el.parentNode.nodeType === 1 && skipped(el.parentNode)) : skipped(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute(ATTRS[i]); if (!v || !/[A-Za-z]/.test(v)) continue;
      var out = tr(v.trim()); if (out) el.setAttribute(ATTRS[i], out);
    }
    if (el.tagName === 'INPUT' && (el.type === 'button' || el.type === 'submit') && el.value) { var o2 = tr(el.value.trim()); if (o2) el.value = o2; }
    if (el.tagName === 'OPTION' && el.textContent) { var o3 = tr(el.textContent.trim()); if (o3) el.textContent = o3; }
  }
  function walk(rootNode) {
    if (!rootNode) return;
    if (rootNode.nodeType === 3) { doText(rootNode); return; }
    if (rootNode.nodeType !== 1 && rootNode.nodeType !== 9 && rootNode.nodeType !== 11) return;
    if (rootNode.nodeType === 1) { if (skipped(rootNode)) return; doEl(rootNode); }
    var w = document.createTreeWalker(rootNode, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    var n; while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else if (n.nodeType === 1) doEl(n); }
  }
  var observing = false;
  function start() {
    walk(document.body);
    var t = tr(document.title); if (t) document.title = t;
    root.classList.remove('i18n-wait');
    if (observing) return; observing = true;
    new MutationObserver(function (list) {
      for (var i = 0; i < list.length; i++) {
        var m = list[i];
        if (m.type === 'characterData') doText(m.target);
        else if (m.type === 'attributes') doEl(m.target);
        else for (var j = 0; j < m.addedNodes.length; j++) walk(m.addedNodes[j]);
      }
      var tt = tr(document.title); if (tt) document.title = tt;
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  // The switch
  function sw() {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'lang-switch'; b.setAttribute('translate', 'no');
    b.setAttribute('aria-label', zh ? 'Switch to English' : '切换到中文');
    b.innerHTML = '<span class="' + (zh ? '' : 'on') + '">EN</span><span class="' + (zh ? 'on' : '') + '">中文</span>';
    b.onclick = function () { try { localStorage.setItem(KEY, zh ? 'en' : 'zh'); } catch (e) {} location.reload(); };
    return b;
  }
  function placeSwitch() {
    if (document.querySelector('.lang-switch')) return;
    var rail = document.querySelector('.rail');
    if (rail) { var brand = rail.querySelector('.brand'); rail.insertBefore(sw(), brand ? brand.nextSibling : rail.firstChild); return; }
    var app = Array.prototype.find.call(document.querySelectorAll('header a, nav a'), function (a) { return /Open the app|打开应用/.test(a.textContent); });
    if (app && app.parentNode) { var s = sw(); s.style.marginRight = '8px'; app.parentNode.insertBefore(s, app); return; }
    var top = document.querySelector('body > .top');
    if (top) { top.appendChild(sw()); return; }
    var f = sw(); f.classList.add('lang-float'); document.body.appendChild(f);
  }

  function ready(fn) { if (document.readyState !== 'loading') fn(); else document.addEventListener('DOMContentLoaded', fn); }
  ready(function () {
    placeSwitch();
    // Pages that rebuild the sidebar later get the switch back.
    new MutationObserver(function () { if (!document.querySelector('.lang-switch')) placeSwitch(); }).observe(document.body, { childList: true, subtree: true });
  });
  if (!zh) return;
  var cacheKey = 'lathe-zh-dict';
  try { var c = JSON.parse(localStorage.getItem(cacheKey) || 'null'); if (c && c.d) D = c.d; } catch (e) {}
  var haveCache = Object.keys(D).length > 0;
  if (haveCache) ready(start);
  // The dictionary lives in the database (table translations), so wording can be fixed without a code change.
  var SB = 'https://jkgevzgfacfqcjqxosnm.supabase.co', AK = (window.DEFECT_CHECK_CONFIG && window.DEFECT_CHECK_CONFIG.supabaseAnonKey) || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImprZ2V2emdmYWNmcWNqcXhvc25tIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTA4MDMxNjcsImV4cCI6MjEwNjM3OTE2N30.8oH74iljLIfeXa6Gua2OcqmKufU-U8OHhshjxpb90PM';
  fetch(SB + '/rest/v1/translations?select=body&lang=eq.zh', { headers: { apikey: AK, Authorization: 'Bearer ' + AK } }).then(function (r) { return r.json(); }).then(function (rows) {
    var d = rows && rows[0] && rows[0].body; if (!d) throw new Error('no dictionary');
    D = d; try { localStorage.setItem(cacheKey, JSON.stringify({ d: d })); } catch (e) {}
    ready(start); if (haveCache) walk(document.body);
  }).catch(function () { root.classList.remove('i18n-wait'); });
})();
