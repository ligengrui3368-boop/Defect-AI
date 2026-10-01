// Demo mode for the marketing site. Active only with ?demo=factory or ?demo=buyer in the URL.
// It swaps the Supabase client for an in-memory sample backend, feeds the camera a drawn scene,
// and plays the flow automatically. Nothing is sent to the real backend, and the visitor's own
// app settings are left untouched. Any real tap or click stops the autoplay.
(() => {
  const P = new URLSearchParams(location.search), MODE = P.get('demo');
  if (MODE !== 'factory' && MODE !== 'buyer') return;
  const LANG = P.get('lang') === 'zh' ? 'zh' : 'en';
  const lsGet = Storage.prototype.getItem, lsSet = Storage.prototype.setItem;
  Storage.prototype.getItem = function (k) { if (k === 'dc_lang') return LANG; if (k === 'dc_worker') return 'Li Wei'; return lsGet.call(this, k); };
  Storage.prototype.setItem = function (k, v) { if (/^dc_/.test(k)) return; return lsSet.call(this, k, v); };
  window.print = () => { };
  window.confirm = () => true;
  const SID = '3732b17d-8304-4529-a0f8-bb4777960ac8', now = Date.now(), ago = m => new Date(now - m * 60000).toISOString();
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ---------- drawn scene: an open carton with its QR label, and the product ---------- */
  let qrLib = null;
  const qrReady = new Promise(res => { const s = document.createElement('script'); s.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js'; s.onload = () => { qrLib = window.qrcode; res(); }; s.onerror = res; document.head.appendChild(s); });
  const qrCache = {};
  function drawQR(x, text, px, py, size) {
    if (!qrLib) return;
    let q = qrCache[text]; if (!q) { q = qrLib(0, 'M'); q.addData(text); q.make(); qrCache[text] = q; }
    const n = q.getModuleCount(), m = size / (n + 2);
    x.fillStyle = '#fff'; x.fillRect(px, py, size, size); x.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) x.fillRect(px + (c + 1) * m, py + (r + 1) * m, Math.ceil(m), Math.ceil(m));
  }
  function bars(x, px, py, w, h) {
    x.fillStyle = '#fff'; x.fillRect(px, py, w, h); x.fillStyle = '#111';
    let cx = px + 8, i = 0; const pat = [2, 1, 3, 1, 1, 2, 2, 3, 1, 1, 2, 1, 3, 2, 1, 1, 2, 2, 1, 3];
    while (cx < px + w - 10) { const bw = pat[i % pat.length]; if (i % 2 === 0) x.fillRect(cx, py + 6, bw * 2, h - 22); cx += bw * 2; i++; }
    x.font = '13px Arial'; x.fillText('X00ABC1234', px + w / 2 - 38, py + h - 4);
  }
  function scene(x, o) {
    const t = o.t || 0, dx = Math.sin(t / 40) * 6, dy = Math.cos(t / 53) * 5;
    const g = x.createLinearGradient(0, 0, 0, 1280); g.addColorStop(0, '#d8d2c6'); g.addColorStop(.55, '#bfb5a3'); g.addColorStop(1, '#9e9381');
    x.fillStyle = g; x.fillRect(0, 0, 960, 1280); x.save(); x.translate(dx, dy);
    if (!o.productOnly) {
      x.fillStyle = '#a77a45'; x.fillRect(60, 520, 520, 600); x.fillStyle = '#8f6537'; x.beginPath(); x.moveTo(60, 520); x.lineTo(150, 440); x.lineTo(670, 440); x.lineTo(580, 520); x.fill();
      x.fillStyle = '#c49a63'; x.beginPath(); x.moveTo(580, 520); x.lineTo(670, 440); x.lineTo(670, 1040); x.lineTo(580, 1120); x.fill();
      x.fillStyle = '#fff'; x.fillRect(110, 600, 330, 300); drawQR(x, 'DC:' + SID.slice(0, 8) + ':' + o.carton, 270, 625, 150);
      x.fillStyle = '#111'; x.font = 'bold 170px Arial'; x.fillText(String(o.carton), 130, 790); x.font = '22px Arial'; x.fillText('Carton ' + o.carton + ' of 50  ·  Lot PO-1182', 130, 870);
    }
    if (o.productOnly) x.translate(-290, 0);
    x.fillStyle = 'rgba(0,0,0,.18)'; x.beginPath(); x.ellipse(770, 1150, 150, 26, 0, 0, 7); x.fill();
    const bg = x.createLinearGradient(640, 0, 900, 0); bg.addColorStop(0, '#2f7a48'); bg.addColorStop(.35, '#5fb27a'); bg.addColorStop(.6, '#3d8f58'); bg.addColorStop(1, '#245f38'); x.fillStyle = bg;
    x.beginPath(); x.moveTo(735, 300); x.lineTo(805, 300); x.lineTo(880, 430); x.lineTo(880, 1120); x.quadraticCurveTo(770, 1170, 660, 1120); x.lineTo(660, 430); x.closePath(); x.fill();
    x.fillStyle = '#1d5a2c'; x.fillRect(728, 230, 84, 76); x.fillStyle = 'rgba(255,255,255,.25)'; x.fillRect(690, 450, 18, 640);
    x.fillStyle = '#f4f3ee'; x.fillRect(665, 600, 210, 250); x.fillStyle = '#111'; x.font = 'bold 54px Arial'; x.fillText('LOGO', 705, 690); x.font = '15px Arial'; x.fillText('Made in China', 715, 725);
    bars(x, 690, 740, 160, 94);
    if (o.stain) { x.fillStyle = 'rgba(115,70,25,.85)'; x.beginPath(); x.ellipse(830, 650, 20, 13, .4, 0, 7); x.fill(); }
    if (o.scratch) { x.strokeStyle = 'rgba(255,255,255,.6)'; x.lineWidth = 3; x.beginPath(); x.moveTo(770, 330); x.lineTo(812, 372); x.stroke(); }
    x.restore();
  }
  function still(o) { const c = document.createElement('canvas'); c.width = 600; c.height = 800; const x = c.getContext('2d'); x.scale(600 / 960, 800 / 1280); scene(x, o); return c.toDataURL('image/jpeg', .8); }
  const live = { carton: 7, stain: true };
  let stream = null;
  navigator.mediaDevices && (navigator.mediaDevices.getUserMedia = async () => {
    if (stream) return stream;
    await qrReady;
    const c = document.createElement('canvas'); c.width = 960; c.height = 1280; const x = c.getContext('2d'); let t = 0;
    const tick = () => { t++; scene(x, { ...live, t }); requestAnimationFrame(tick); }; tick();
    stream = c.captureStream(30); return stream;
  });

  /* ---------- in-memory sample backend ---------- */
  const placeholder = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#ccc"/></svg>');
  let IMG = {};
  const spec = { views: ['Front'], barcode: 'X00ABC1234', labelText: 'Made in China', mustHave: 'Front label with logo, straight and clean\nGreen cap', goodLooks: 'Clear green glass bottle with a straight white front label and a green cap.', watch: ['Stains or marks', 'Scratches', 'Wrong label'], minDefectMm: '2' };
  const W = 'demo-ws', U = { id: 'demo-user', email: null, is_anonymous: true };
  const DB = { workspace_members: [{ workspace_id: W, user_id: U.id, created_at: ago(9e4), workspaces: { name: 'Demo workspace' } }], products: [], inspections: [], factory_links: [], factory_sessions: [], factory_picks: [] };
  if (MODE === 'buyer') {
    DB.products = [{ id: 'p1', workspace_id: W, name: 'Glass water bottle 500 ml', sku: 'GB-500', source_url: '', spec, photos: [{ path: 'img/product', view: 'Front', origin: 'unit', part: 'Approved sample, front' }], version: 1, created_at: ago(9000), updated_at: ago(9000) }];
    let k = 0;
    const mk = (c, u, verdict, ai, img) => { const id = 'i' + (++k);
      DB.inspections.push({ id, session_id: 'S1', workspace_id: W, product_id: 'p1', product_name: 'Glass water bottle 500 ml', product_version: 1, lot: 'PO-1182', unit: 'C' + c + '-U' + u, stage: 'factory', status: 'done', verdict, ai, photos: [{ path: 'img/' + img, view: 'Front', part: 'Carton label and bottle' }], decision: null, created_at: ago(200 - k), factory_link_id: 'L1', submitted_by: 'Li Wei' });
      DB.factory_picks.push({ id: 'k' + k, session_id: 'S1', workspace_id: W, seq: k, carton: c, unit_pos: u, status: 'done', issued_at: ago(210 - k), submitted_at: ago(209 - k), attempts: 1, verdict, inspection_id: id }); };
    const pass = { verdict: 'PASS', summary: 'Matches the approved sample. Label straight and clean, barcode X00ABC1234.', photoOk: true, photoIssues: [], checks: [{ item: 'Barcode', result: 'pass', note: 'Scanner read X00ABC1234.' }, { item: 'Carton label', result: 'pass', note: 'QR label confirms the carton.' }], defects: [], more: [] };
    mk(7, 3, 'FAIL', { verdict: 'FAIL', summary: 'Brown stain on the front label, about 4 mm. Rejects from 2 mm.', photoOk: true, photoIssues: [], checks: [{ item: 'Stains or marks', result: 'fail', note: 'Stain on the label, about 4 mm.' }, { item: 'Barcode', result: 'pass', note: 'Scanner read X00ABC1234.' }], defects: [{ type: 'Brown stain', where: 'front label, top right', photo: 1, box: [0.8, 0.45, 0.08, 0.06], size: 4, severity: 'major', inSpec: false, conf: 0.9 }], more: [] }, 'stain');
    mk(31, 8, 'REVIEW', { verdict: 'REVIEW', summary: 'Possible fine scratch near the cap. The photo is not sharp enough to be sure.', photoOk: true, photoIssues: [], checks: [{ item: 'Scratches', result: 'unclear', note: 'Faint line near the cap.' }], defects: [{ type: 'Possible scratch', where: 'shoulder, below the cap', photo: 1, box: [0.76, 0.24, 0.07, 0.06], size: 3, severity: 'minor', inSpec: false, conf: 0.5 }], more: [] }, 'scratch');
    for (let i = 0; i < 78; i++) mk(1 + (i * 7) % 50, 1 + (i * 13) % 20, 'PASS', pass, 'clean');
    DB.inspections.reverse();
    DB.factory_links = [{ id: 'L1', workspace_id: W, product_id: 'p1', lot: 'PO-1182', factory_name: 'Ningbo Homeware Co.', token: 'd'.repeat(64), active: true, max_units: 500, expires_at: new Date(now + 30 * 864e5).toISOString(), created_at: ago(400) }];
    DB.factory_sessions = [{ id: 'S1', link_id: 'L1', workspace_id: W, product_id: 'p1', lot: 'PO-1182', total_units: 1000, cartons: 50, units_per_carton: 20, sample_size: 80, accept_major: 5, window_seconds: 480, status: 'done', result: 'REVIEW', created_at: ago(220), buyer_decision: null }];
  }
  function Q(table) {
    let f = [], op = 'select', payload = null, single = false;
    const run = () => {
      const rows = DB[table] || (DB[table] = []);
      if (op === 'insert') { const r = { id: 'n' + Math.random().toString(36).slice(2, 8), created_at: new Date().toISOString(), ...payload }; rows.unshift(r); return { data: r, error: null }; }
      const m = rows.filter(r => f.every(([k, v]) => r[k] === v));
      if (op === 'update') m.forEach(r => Object.assign(r, payload));
      if (op === 'delete') DB[table] = rows.filter(r => !m.includes(r));
      return { data: single ? (m[0] || null) : m, error: null };
    };
    const api = {
      select() { return api; }, eq(k, v) { f.push([k, v]); return api; }, order() { return api; }, limit() { return api; },
      insert(p) { op = 'insert'; payload = p; return api; }, update(p) { op = 'update'; payload = p; return api; }, delete() { op = 'delete'; return api; },
      single() { single = true; return api; }, maybeSingle() { single = true; return api; },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  }
  let SES = null, pi = 0, n = 0; const units = {};
  const picks = [{ seq: 1, carton: 7, unit_pos: 3 }, { seq: 2, carton: 2, unit_pos: 11 }, { seq: 3, carton: 41, unit_pos: 6 }];
  const st = () => SES && { ...SES, done: pi, checking: 0, failed: pi > 1 ? 1 : 0 };
  async function invoke(name, { body }) {
    const T = body.task; await sleep(200);
    if (T === 'factory_open') return { data: { link: { lot: 'PO-1182', factory_name: 'Ningbo Homeware Co.', expires_at: new Date(now + 864e6).toISOString() }, product: { name: 'Glass water bottle 500 ml', sku: 'GB-500', version: 1, spec, photos: [] }, units: [], urls: {}, session: st() } };
    if (T === 'factory_session_start') { SES = { id: SID, total_units: body.total_units, cartons: body.cartons, units_per_carton: body.units_per_carton, sample_size: 80, window_seconds: 480, status: 'sampling', result: null, done: 0, checking: 0, missed: 0, failed: 0 }; return { data: { session: st() } }; }
    if (T === 'factory_pick_next') { const p = picks[pi]; return { data: { session: st(), pick: p ? { ...p, token: 'tok' + p.seq, expires_at: new Date(Date.now() + 466000).toISOString(), attempts: 0, of: 80 } : null } }; }
    if (T === 'factory_upload') return { data: { uploads: [{ path: 'demo/' + (++n) + '.jpg', token: 't' }] } };
    if (T === 'factory_identify') return { data: { photos: body.paths.map((_, i) => ({ index: i + 1, view: 'Front', part: 'Carton label and bottle', quality: 'ok' })) } };
    if (T === 'factory_submit') { pi++; const id = 'u' + pi; units[id] = { id, unit: 'C' + picks[pi - 1].carton + '-U' + picks[pi - 1].unit_pos, status: 'pending', verdict: null, created_at: new Date().toISOString(), submitted_by: 'Li Wei', photos: body.photos.map(p => ({ path: p.path, view: p.view })), ai: null }; return { data: { accepted: true, unit: units[id], urls: {} } }; }
    if (T === 'factory_units') return { data: { session: st(), units: body.ids.map(id => { const bad = id === 'u1'; return { ...units[id], status: 'done', verdict: bad ? 'FAIL' : 'PASS', ai: { verdict: bad ? 'FAIL' : 'PASS', summary: bad ? 'Brown stain on the front label, about 4 mm. Rejects from 2 mm.' : 'Matches the approved sample.', photoOk: true, photoIssues: [], checks: [], defects: [], more: [], zh: bad ? { summary: '正面标签有约4毫米的棕色污渍，超过2毫米的拒收标准。', defects: [], more: [] } : null } }; }) } };
    return { data: {} };
  }
  const imgsReady = MODE === 'buyer' ? qrReady.then(() => { IMG = { 'img/clean': still({ carton: 7 }), 'img/stain': still({ carton: 7, stain: true }), 'img/scratch': still({ carton: 31, scratch: true }), 'img/product': still({ productOnly: true }) }; }) : Promise.resolve();
  const client = {
    auth: { getSession: async () => { await imgsReady; return { data: { session: MODE === 'buyer' ? { user: U } : null } }; }, onAuthStateChange() { }, signInAnonymously: async () => ({ data: { session: { user: U } }, error: null }), signOut: async () => ({}), signInWithOtp: async () => ({ error: { message: 'Not available in the demo.' } }) },
    from: Q,
    storage: { from: () => ({ upload: async () => ({ error: null }), uploadToSignedUrl: async () => ({ error: null }), createSignedUrls: async ps => ({ data: ps.map(p => ({ path: p, signedUrl: IMG[p] || placeholder })) }) }) },
    channel: () => { const c = { on: () => c, subscribe: () => c }; return c; },
    functions: { invoke },
  };
  window.supabase = { createClient: () => client };
  if (MODE === 'factory' && !P.get('f')) { history.replaceState(null, '', location.pathname + '?demo=factory&f=' + 'd'.repeat(64) + (LANG === 'zh' ? '&lang=zh' : '')); }

  /* ---------- autoplay ---------- */
  let stopped = false;
  addEventListener('pointerdown', e => { if (e.isTrusted) stopped = true; }, true);
  addEventListener('keydown', e => { if (e.isTrusted) stopped = true; }, true);
  let cur = null;
  function cursor() {
    if (cur) return cur; cur = document.createElement('div');
    cur.style.cssText = 'position:fixed;z-index:99999;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:rgba(255,255,255,.4);border:2px solid rgba(0,0,0,.4);pointer-events:none;left:50%;top:110%;transition:left .7s ease,top .7s ease,transform .15s';
    document.body.appendChild(cur); return cur;
  }
  const check = () => { if (stopped) { if (cur) cur.remove(); throw new Error('stopped'); } };
  async function find(test, ms = 15000) { const t0 = Date.now(); for (;;) { check(); const el = typeof test === 'string' ? document.querySelector(test) : test(); if (el && !el.disabled) return el; if (Date.now() - t0 > ms) throw new Error('not found'); await sleep(150); } }
  async function tap(test, pause = 900) {
    const el = await find(test); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); await sleep(600); check();
    const r = el.getBoundingClientRect(), c = cursor(); c.style.left = (r.left + r.width / 2) + 'px'; c.style.top = (r.top + r.height / 2) + 'px'; await sleep(800); check();
    c.style.transform = 'scale(.7)'; await sleep(140); c.style.transform = ''; el.click(); await sleep(pause);
  }
  async function type(sel, text) { const el = await find(sel); await tap(sel, 300); for (const ch of text) { check(); el.value += ch; el.dispatchEvent(new Event('input', { bubbles: true })); await sleep(120); } await sleep(400); }
  const byText = (sel, txt) => () => [...document.querySelectorAll(sel)].find(e => e.innerText.includes(txt));
  async function factoryScript() {
    await sleep(1500);
    await type('[data-d=total]', '1000'); await type('[data-d=per]', '20');
    await tap('[data-a=fStart]', 1500); await tap('[data-a=fStartCam]', 2200);
    live.carton = 7; live.stain = true; await tap('[data-a=camShot]', 400); await find('#camNext'); await sleep(1200); await tap('#camNext', 1600);
    live.carton = 2; live.stain = false; await sleep(800); await tap('[data-a=camShot]', 400); await find('#camNext'); await sleep(1200); await tap('#camNext', 2400);
    await sleep(3500); await tap('[data-a=camClose]', 2500);
    window.scrollTo({ top: 400, behavior: 'smooth' }); await sleep(3500);
  }
  async function buyerScript() {
    await sleep(1800);
    await tap(byText('.row', 'reference photo'), 1500);
    await tap('[data-a=openLot]', 2000);
    await tap(() => { const c = byText('.xcard', 'C7-U3')(); return c && c.querySelector('[data-v=FAIL]'); }, 1800);
    await tap(() => { const c = byText('.xcard', 'C31-U8')(); return c && c.querySelector('[data-v=PASS]'); }, 1800);
    await tap('[data-a=lotDecide][data-v=release]', 4000);
  }
  async function boot() {
    try { await (MODE === 'factory' ? factoryScript() : buyerScript()); if (!stopped) location.reload(); } catch (e) { if (cur) cur.remove(); }
  }
  if (P.get('autoplay') !== '0') addEventListener('load', boot);
})();
