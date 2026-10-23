'use strict';
// خادم دليل الأرقام: مصادقة + تخزين + مزامنة فورية + جهاز واحد لكل مستخدم (بلا مكتبات خارجية)
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const DIR = __dirname, DATA = process.env.DATA_DIR || DIR;
const DBF = path.join(DATA, 'db.json'), SEED = path.join(DIR, 'seed.json'), HTMLF = path.join(DIR, 'index.html');
const MAXU = 300, PS = ' › ', DAY = 864e5;
let DB, LOG = [], LOGMIN = 0;
const hashPw = (p, k, salt) => crypto.scryptSync(String(p) + '\u0000' + String(k), salt, 32).toString('hex');
function mkUser(u, name, p, k, role, hc) { const salt = crypto.randomBytes(16).toString('hex'); return { u: u.toLowerCase(), name, role, salt, h: hashPw(p, k, salt), hc: hc || [] }; }
let saveT = null;
function save(now) {
  const w = () => { try { fs.mkdirSync(DATA, { recursive: true }); const tmp = DBF + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(DB)); fs.renameSync(tmp, DBF); } catch (e) { console.error('save failed', e.message); } };
  clearTimeout(saveT); if (now) w(); else saveT = setTimeout(w, 250);
}
function init() {
  try { DB = JSON.parse(fs.readFileSync(DBF, 'utf8')); }
  catch (e) {
    const s = JSON.parse(fs.readFileSync(SEED, 'utf8'));
    DB = { v: 1, next: 1, contacts: [], users: [], hc: [], ord: s.ord, fav: {}, sessions: {} };
    s.contacts.forEach(c => DB.contacts.push({ i: DB.next++, n: c.n, t: c.t || '', p: c.p || '', w: c.w || '', c: c.c, h: c.h ? 1 : 0 }));
    DB.users.push(process.env.ADMIN_PASS && process.env.ADMIN_CODE ? mkUser((process.env.ADMIN_USER || 'admin').trim(), 'المدير', process.env.ADMIN_PASS.trim(), process.env.ADMIN_CODE.trim(), 'admin') : s.admin);
    save(true);
  }
  const EU = (process.env.ADMIN_USER || 'admin').trim(), EP = (process.env.ADMIN_PASS || '').trim(), EK = (process.env.ADMIN_CODE || '').trim();
  if (process.env.RESET_ADMIN && EP && EK) {
    DB.users = DB.users.filter(x => x.role !== 'admin' && x.u !== EU.toLowerCase());
    DB.users.unshift(mkUser(EU, 'المدير', EP, EK, 'admin')); DB.sessions = {}; save(true); console.log('admin reset');
  }
  if (process.env.CLEAR_SESSIONS) { DB.sessions = {}; save(true); }
  LOGMIN = DB.v;
}
init();
const parentOf = k => k.includes(PS) ? k.split(PS)[0] : k;
const hid = (k, l) => l.includes(k) || l.includes(parentOf(k));
const visible = (c, u) => !c.h && !hid(c.c, DB.hc) && !hid(c.c, u.hc || []);
const pub = (c, adm) => adm && c.h ? { i: c.i, n: c.n, t: c.t, p: c.p, w: c.w, c: c.c, h: 1 } : { i: c.i, n: c.n, t: c.t, p: c.p, w: c.w, c: c.c };
const fmt = raw => {
  let t = String(raw || '').replace(/[\u200b-\u200f\u202a-\u202e]/g, '').trim(); if (!t) return { p: '', w: '' };
  if (t.startsWith('+') && !t.startsWith('+964')) { const d = t.replace(/\D/g, ''); return d.length < 7 ? null : { p: t, w: '+' + d }; }
  let d = t.replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('964')) d = d.slice(3); d = d.replace(/^0+/, '');
  if (d.length == 10 && d[0] == '7') return { p: `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`, w: '+964' + d };
  return d.length < 7 ? null : { p: t, w: '' };
};
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
function clean(q) {
  const n = str(q.n, 200), t = str(q.t, 200), c = str(q.c, 120); if (!n && !t) return 'name'; if (!c) return 'cat';
  const f = fmt(q.p); if (!f) return 'phone';
  return { n: n || t, t: n ? t : '', p: f.p, w: f.w, c, h: q.h ? 1 : 0 };
}
// ---- sessions & live clients
const streams = new Map();
const sessOf = u => Object.entries(DB.sessions).find(([, s]) => s.u === u && s.exp > Date.now());
function kill(sid, kick) { delete DB.sessions[sid]; const r = streams.get(sid); if (r) { try { if (kick) r.write('event: kick\ndata: 1\n\n'); r.end(); } catch (e) {} streams.delete(sid); } }
const killUser = u => { for (const [sid, s] of Object.entries(DB.sessions)) if (s.u === u) kill(sid, true); save(); };
function bump(entry) {
  DB.v++; if (entry) { entry.v = DB.v; LOG.push(entry); if (LOG.length > 300) { LOG.shift(); LOGMIN = LOG[0].v - 1; } } else { LOG.push({ v: DB.v, t: 'r' }); }
  save(); for (const r of streams.values()) { try { r.write(`data: {"v":${DB.v}}\n\n`); } catch (e) {} }
}
setInterval(() => { for (const r of streams.values()) { try { r.write(': ping\n\n'); } catch (e) {} } const n = Date.now(); let ch = 0; for (const [sid, s] of Object.entries(DB.sessions)) if (s.exp < n) { kill(sid, true); ch++; } if (ch) save(); }, 25000);
const cookies = req => Object.fromEntries((req.headers.cookie || '').split(';').map(x => x.trim().split('=')).filter(x => x[0] && x[1]));
function auth(req) {
  const sid = cookies(req).sid, s = sid && DB.sessions[sid]; if (!s) return null;
  if (s.exp < Date.now()) { kill(sid, true); save(); return null; }
  const u = DB.users.find(x => x.u === s.u); if (!u) { kill(sid, true); return null; }
  return { sid, s, u };
}
// ---- http helpers
function send(req, res, code, obj, extra) {
  const s = JSON.stringify(obj), h = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...(extra || {}) };
  if (s.length > 1024 && /gzip/.test(req.headers['accept-encoding'] || '')) { h['Content-Encoding'] = 'gzip'; res.writeHead(code, h); res.end(zlib.gzipSync(s)); } else { res.writeHead(code, h); res.end(s); }
}
const readBody = (req, lim) => new Promise(r => { let b = '', big = false; req.on('data', d => { b += d; if (b.length > lim) { big = true; req.destroy(); } }); req.on('end', () => { if (big) return r(null); try { r(b ? JSON.parse(b) : {}); } catch (e) { r(null); } }); req.on('error', () => r(null)); });
const hits = new Map(), fails = new Map();
const limited = ip => { const n = Date.now(), h = (hits.get(ip) || []).filter(x => n - x < 60000); h.push(n); hits.set(ip, h); return h.length > 400; };
function lockWait(k) { const f = fails.get(k); if (!f || f.n < 5) return 0; const w = Math.min(900, 30 * 2 ** (f.n - 5)) * 1000 - (Date.now() - f.t); return w > 0 ? Math.ceil(w / 1000) : 0; }
const addFail = k => { const f = fails.get(k) || { n: 0 }; fails.set(k, { n: f.n + 1, t: Date.now() }); };
function fullData(a) {
  const u = a.u, adm = u.role === 'admin', cs = [];
  for (const c of DB.contacts) if (adm || visible(c, u)) cs.push(pub(c, adm));
  const d = { role: u.role, name: u.name, u: u.u, v: DB.v, ord: DB.ord, contacts: cs, fav: DB.fav[u.u] || [], max: MAXU, rem: (a.s.exp - a.s.t) > 2 * DAY };
  if (adm) d.hc = DB.hc;
  return d;
}
const usersList = () => DB.users.filter(x => x.role !== 'admin').map(x => { const s = sessOf(x.u); return { u: x.u, name: x.name, hc: x.hc || [], bound: !!s, since: s ? s[1].t : 0 }; });
const validPw = (p, k) => typeof p === 'string' && typeof k === 'string' && p.length >= 8 && k.length >= 4;
const validU = u => /^[a-z0-9._-]{3,32}$/.test(u);
// ---- واتساب: إرسال عبر API + قوالب + حملات تعمل في الخلفية (تُحفظ في wa.json) ----
const WAF = path.join(DATA, 'wa.json');
const WTT = ['الفريق','اللواء','العميد','العقيد','المقدم','الرائد','الركن','دكتور','الدكتور','الاستاذ','استاذ','الشيخ','السيد','المهندس','النائب','الحاج','د'];
let W, wT = null, pumping = false; const MID = new Map();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function wsave(now) {
  const w = () => { try { fs.mkdirSync(DATA, { recursive: true }); const tmp = WAF + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(W)); fs.renameSync(tmp, WAF); } catch (e) { console.error('wa save failed', e.message); } };
  clearTimeout(wT); if (now) w(); else wT = setTimeout(w, 1500);
}
function wload() {
  try { W = JSON.parse(fs.readFileSync(WAF, 'utf8')); } catch (e) { W = {}; }
  W.cfg = Object.assign({ provider: 'ultramsg', url: '', instance: '', phone_id: '', token: '', hdr: '', body: '', delay: 20, jit: 30 }, W.cfg || {});
  W.sms = Object.assign({ provider: 'smsgate', url: '', account: '', sender: '', token: '', hdr: '', body: '', delay: 10, jit: 30 }, W.sms || {});
  W.secret = W.secret || crypto.randomBytes(12).toString('hex'); W.tpls = W.tpls || []; W.camps = W.camps || []; W.next = W.next || 1;
  for (const cp of W.camps) for (const r of cp.r) if (r.m) MID.set(r.m, r);
  wsave(true);
}
const pubCfg = () => { const { token, ...c } = W.cfg; return { ...c, hasToken: !!token }; };
const pubSms = () => { const { token, ...c } = W.sms; return { ...c, hasToken: !!token }; };
// ---- SMS: مزوّدات الرسائل النصية (Twilio / Vonage / API مخصّص)
const smsReady = c => c.provider === 'smsgate' ? !!(c.account && c.token) : c.provider === 'twilio' ? !!(c.account && c.token && c.sender) : c.provider === 'vonage' ? !!(c.account && c.token && c.sender) : !!c.url;
const chReady = ch => ch === 'sms' ? smsReady(W.sms) : waReady(W.cfg);
const chOf = cp => cp.ch === 'sms' ? 'sms' : 'wa';
// WP Sender: المسار وأسماء حقول الجسم هنا (عدّلها إن اختلفت عن نموذج cURL في لوحتهم)
const WPS = { path: '/messages/send', to: 'number', msg: 'message' };
const waReady = c => c.provider === 'ultramsg' ? !!(c.instance && c.token) : c.provider === 'meta' ? !!(c.phone_id && c.token) : c.provider === 'wpsender' ? !!(c.url && c.token) : !!c.url;
const TL = new Set(['فريق','لواء','عميد','عقيد','مقدم','رائد','نقيب','ملازم','قائد','ركن','مفوض','دكتور','د','م','استاذ','شيخ','سيد','نائب','وزير','محافظ','سفير','حاج','مهندس','معالي','سعادة','قاضي','سماحه','فق','ف','ل']);
const nw = w => w.replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/^ال(?=.{2})/, '');
const firstName = n => { const ws = String(n || '').replace(/[()]/g, ' ').split(/\s+/).filter(Boolean); return ws.find(w => !TL.has(nw(w)) && !/^[0-9٠-٩]+$/.test(w)) || ws[0] || ''; };
const wvars = r => {
  const f = firstName(r.n), p = parentOf(r.c || '');
  return { 'الاسم': r.n, name: r.n, 'الاسم_الأول': f, 'الاسم_الاول': f, first: f, 'المنصب': r.t || '', title: r.t || '', 'القسم': p, category: p, 'الرقم': r.p || '', phone: r.p || '' };
};
const wrender = (m, r) => { const v = wvars(r); return String(m).replace(/\{([^{}\s]+)\}/g, (x, k) => k in v ? v[k] : x); };
const et = v => typeof v === 'string' ? v : (v && v.message) || JSON.stringify(v || '');
async function waSend(to, text) {
  const c = W.cfg;
  try {
    const sig = AbortSignal.timeout(25000);
    if (c.provider === 'ultramsg') {
      if (!c.instance || !c.token) return { ok: false, e: 'إعدادات الربط غير مكتملة', fatal: true };
      const base = (c.url || 'https://api.ultramsg.com').replace(/\/+$/, '');
      const r = await fetch(`${base}/${encodeURIComponent(c.instance)}/messages/chat`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: c.token, to: '+' + to, body: text }), signal: sig });
      const j = await r.json().catch(() => ({}));
      if (r.ok && (j.sent === true || j.sent === 'true')) return { ok: true, id: String(j.id || '') };
      return { ok: false, e: str(et(j.error || j.message) || 'HTTP ' + r.status, 200), fatal: r.status === 401 || r.status === 403 };
    }
    if (c.provider === 'meta') {
      if (!c.phone_id || !c.token) return { ok: false, e: 'إعدادات الربط غير مكتملة', fatal: true };
      const r = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(c.phone_id)}/messages`, { method: 'POST', headers: { Authorization: 'Bearer ' + c.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text, preview_url: false } }), signal: sig });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.messages && j.messages[0]) return { ok: true, id: String(j.messages[0].id) };
      return { ok: false, e: str(et(j.error && j.error.message) || 'HTTP ' + r.status, 200), fatal: r.status === 401 || !!(j.error && j.error.code === 190) };
    }
    if (c.provider === 'wpsender') {
      if (!c.url || !c.token) return { ok: false, e: 'إعدادات الربط غير مكتملة', fatal: true };
      const r = await fetch(c.url.replace(/\/+$/, '') + WPS.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-Key': c.token }, body: JSON.stringify({ [WPS.to]: to, [WPS.msg]: text }), signal: sig });
      const j = await r.json().catch(() => ({}));
      if (r.ok && !(j && (j.success === false || j.status === 'error' || j.error))) return { ok: true, id: String(j.id || j.message_id || (j.data && j.data.id) || '') };
      return { ok: false, e: str(et(j.error || j.message) || 'HTTP ' + r.status, 200), fatal: r.status === 401 || r.status === 403 };
    }
    if (!c.url) return { ok: false, e: 'رابط الـ API غير محدد', fatal: true };
    const sub = (s, mode) => String(s).replace(/\{\{(phone|message|token)\}\}/g, (m, k) => { const v = k === 'phone' ? to : k === 'token' ? c.token : text; return mode === 'json' ? JSON.stringify(v).slice(1, -1) : mode === 'url' ? encodeURIComponent(v) : v; });
    const h = {}; let hasCT = false;
    for (const ln of String(c.hdr || '').split('\n')) { const i = ln.indexOf(':'); if (i > 0) { const k = ln.slice(0, i).trim(); h[k] = sub(ln.slice(i + 1).trim(), 'raw'); if (/^content-type$/i.test(k)) hasCT = true; } }
    if (!hasCT) h['Content-Type'] = 'application/json';
    const r = await fetch(sub(c.url, 'url'), { method: 'POST', headers: h, body: sub(c.body || '{"to":"{{phone}}","message":"{{message}}"}', 'json'), signal: sig });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (r.ok && !(j && (j.success === false || j.status === 'error' || j.error))) return { ok: true, id: String(j.id || j.message_id || (j.messages && j.messages[0] && j.messages[0].id) || '') };
    return { ok: false, e: str(et(j.error || j.message) || t || 'HTTP ' + r.status, 200), fatal: r.status === 401 || r.status === 403 };
  } catch (e) { return { ok: false, e: e.name === 'TimeoutError' ? 'انتهت مهلة الاتصال' : 'تعذّر الاتصال: ' + str(e.message, 120) }; }
}
async function smsSend(to, text) {
  const c = W.sms, bad = { ok: false, e: 'إعدادات الربط غير مكتملة', fatal: true };
  try {
    const sig = AbortSignal.timeout(25000);
    if (c.provider === 'twilio') {
      if (!smsReady(c)) return bad;
      const base = (c.url || 'https://api.twilio.com').replace(/\/+$/, '');
      const r = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(c.account)}/Messages.json`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(c.account + ':' + c.token).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ To: '+' + to, From: c.sender, Body: text }), signal: sig });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.sid) return { ok: true, id: String(j.sid) };
      return { ok: false, e: str(et(j.message || j.error) || 'HTTP ' + r.status, 200), fatal: r.status === 401 || r.status === 403 };
    }
    if (c.provider === 'smsgate') {
      if (!smsReady(c)) return bad;
      const base = (c.url || 'https://api.sms-gate.app').replace(/\/+$/, '');
      const r = await fetch(`${base}/3rdparty/v1/messages`, { method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(c.account + ':' + c.token).toString('base64'), 'Content-Type': 'application/json' }, body: JSON.stringify({ phoneNumbers: ['+' + to], textMessage: { text } }), signal: sig });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.id) return { ok: true, id: String(j.id) };
      return { ok: false, e: str(et(j.message || j.error) || 'HTTP ' + r.status, 200), fatal: r.status === 401 || r.status === 403 };
    }
    if (c.provider === 'vonage') {
      if (!smsReady(c)) return bad;
      const base = (c.url || 'https://rest.nexmo.com').replace(/\/+$/, '');
      const r = await fetch(`${base}/sms/json`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ api_key: c.account, api_secret: c.token, to, from: c.sender, text, type: 'unicode' }), signal: sig });
      const j = await r.json().catch(() => ({})), m = j.messages && j.messages[0];
      if (r.ok && m && String(m.status) === '0') return { ok: true, id: String(m['message-id'] || '') };
      return { ok: false, e: str((m && m['error-text']) || et(j.error) || 'HTTP ' + r.status, 200), fatal: !!m && ['2', '4', '9'].includes(String(m.status)) };
    }
    if (!c.url) return { ok: false, e: 'رابط الـ API غير محدد', fatal: true };
    const sub = (s, mode) => String(s).replace(/\{\{(phone|message|token|sender)\}\}/g, (m, k) => { const v = k === 'phone' ? to : k === 'token' ? c.token : k === 'sender' ? c.sender : text; return mode === 'json' ? JSON.stringify(v).slice(1, -1) : mode === 'url' ? encodeURIComponent(v) : v; });
    const h = {}; let hasCT = false;
    for (const ln of String(c.hdr || '').split('\n')) { const i = ln.indexOf(':'); if (i > 0) { const k = ln.slice(0, i).trim(); h[k] = sub(ln.slice(i + 1).trim(), 'raw'); if (/^content-type$/i.test(k)) hasCT = true; } }
    if (!hasCT) h['Content-Type'] = 'application/json';
    const r = await fetch(sub(c.url, 'url'), { method: 'POST', headers: h, body: sub(c.body || '{"to":"{{phone}}","message":"{{message}}"}', 'json'), signal: sig });
    const t = await r.text(); let j = {}; try { j = JSON.parse(t); } catch (e) {}
    if (r.ok && !(j && (j.success === false || j.status === 'error' || j.error))) return { ok: true, id: String(j.id || j.message_id || j.sid || '') };
    return { ok: false, e: str(et(j.error || j.message) || t || 'HTTP ' + r.status, 200), fatal: r.status === 401 || r.status === 403 };
  } catch (e) { return { ok: false, e: e.name === 'TimeoutError' ? 'انتهت مهلة الاتصال' : 'تعذّر الاتصال: ' + str(e.message, 120) }; }
}
const chSend = (ch, to, text) => ch === 'sms' ? smsSend(to, text) : waSend(to, text);
// ---- العامل الخلفي: يعالج الحملة الجارية رسالة تلو رسالة حتى تنتهي (يستمر حتى بعد إغلاق المتصفح، ويُستأنف بعد إعادة تشغيل الخادم)
async function pump() {
  if (pumping) return; pumping = true; let fails = 0;
  try {
    for (;;) {
      const cp = W.camps.find(x => x.st === 'running'); if (!cp) break;
      const r = cp.r.find(x => x.s === 'q');
      if (!r) { cp.st = 'done'; cp.end = Date.now(); wsave(true); continue; }
      const res = await chSend(chOf(cp), r.w, wrender(cp.msg, r));
      if (res.ok) { r.s = 's'; r.m = res.id; r.a = Date.now(); r.e = ''; fails = 0; if (res.id) MID.set(res.id, r); }
      else if (res.fatal) { if (cp.st === 'running') { cp.st = 'paused'; cp.why = 'توقفت الحملة: ' + res.e + ' — صحّح إعدادات الربط ثم اضغط استئناف.'; } }
      else { r.s = 'f'; r.e = res.e; r.a = Date.now(); if (++fails >= 5 && cp.st === 'running') { cp.st = 'paused'; cp.why = 'توقفت تلقائيًا بعد 5 إخفاقات متتالية (آخر خطأ: ' + res.e + ')'; fails = 0; } }
      wsave();
      if (cp.st === 'running' && cp.r.some(x => x.s === 'q')) { const ms = cp.d * 1000 * (1 + (Math.random() * 2 - 1) * cp.j / 100); for (let t = 0; t < ms && cp.st === 'running'; t += 500) await sleep(Math.min(500, ms - t)); }
    }
  } catch (e) { console.error('pump', e); } finally { pumping = false; }
}
// ---- إشعارات التسليم (Webhook) لتمييز «وصلت» و«قُرئت»
const RANK = { q: 0, f: 0, s: 1, d: 2, r: 3 };
function ack(id, to, st) {
  let r = id && MID.get(String(id));
  if (!r && to) { const p = String(to).replace(/\D/g, ''); for (let k = W.camps.length - 1; k >= 0 && !r; k--) { const rs = W.camps[k].r; for (let i = rs.length - 1; i >= 0; i--) if (rs[i].w === p && RANK[rs[i].s] >= 1) { r = rs[i]; break; } } }
  if (!r) return; st = String(st).toLowerCase();
  const n = st === 'read' || st === 'played' ? 'r' : st === 'delivered' || st === 'device' ? 'd' : st === 'failed' ? 'f' : st === 'sent' || st === 'server' ? 's' : null; if (!n) return;
  if (n === 'f') { if (RANK[r.s] < 2) { r.s = 'f'; r.e = r.e || 'فشل التسليم'; } } else if (RANK[n] > RANK[r.s]) r.s = n;
  wsave();
}
function whook(b) {
  try {
    for (const en of b.entry || []) for (const ch of en.changes || []) for (const s of (ch.value && ch.value.statuses) || []) ack(s.id, s.recipient_id, s.status);
    if (b.data && b.data.ack) ack(b.data.id, b.data.to, b.data.ack);
  } catch (e) {}
}
const wsum = cp => { const o = { id: cp.id, ch: chOf(cp), name: cp.name, st: cp.st, why: cp.why || '', cr: cp.cr, end: cp.end || 0, total: cp.r.length, q: 0, s: 0, d: 0, r: 0, f: 0 }; for (const x of cp.r) o[x.s]++; return o; };
const clampN = (v, a, b, def) => Math.min(b, Math.max(a, +v || def));
wload(); pump();
// ---- server
http.createServer(async (req, res) => {
  const P = new URL(req.url, 'http://x').pathname, M = req.method;
  const sec = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
  if (M === 'GET' && (P === '/' || P === '/index.html')) { try { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...sec }); return res.end(fs.readFileSync(HTMLF)); } catch (e) { res.writeHead(500); return res.end('index.html missing'); } }
  if (P === '/healthz') { res.writeHead(200); return res.end('ok'); }
  if (!P.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
  if (P.startsWith('/api/wa-hook/')) {
    if (P.split('/')[3] !== W.secret) { res.writeHead(404); return res.end(); }
    if (M === 'GET') { const sp = new URL(req.url, 'http://x').searchParams, ch = sp.get('hub.challenge'); if (ch && sp.get('hub.verify_token') !== W.secret) { res.writeHead(403); return res.end(); } res.writeHead(200); return res.end(ch || 'ok'); }
    const hb = await readBody(req, 500000); if (hb) whook(hb); res.writeHead(200); return res.end('ok');
  }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  if (limited(ip)) return send(req, res, 429, { err: 'rate' });
  const url = new URL(req.url, 'http://x'), parts = P.split('/').filter(Boolean).slice(1), A = parts[0];
  try {
    if (A === 'login' && M === 'POST') {
      const q = await readBody(req, 2000); if (!q) return send(req, res, 400, {});
      const u = str(q.u, 64).toLowerCase(), w = Math.max(lockWait('ip:' + ip), lockWait('u:' + u));
      if (w) return send(req, res, 429, { err: 'locked', wait: w });
      const usr = DB.users.find(x => x.u === u), salt = usr ? usr.salt : '00'.repeat(16);
      const chk = (p, k) => { const h = hashPw(p, k, salt); return !!usr && h.length === usr.h.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(usr.h)); };
      const rp = String(q.p || ''), rk = String(q.k || ''); let ok = chk(rp, rk); if (!ok && (rp !== rp.trim() || rk !== rk.trim())) ok = chk(rp.trim(), rk.trim());
      if (!ok) { addFail('ip:' + ip); addFail('u:' + u); return send(req, res, 401, { err: 'bad' }); }
      fails.delete('ip:' + ip); fails.delete('u:' + u);
      const dev = str(q.dev, 64), ex = sessOf(u);
      if (ex && ex[1].dev !== dev) return send(req, res, 409, { err: 'bound' });
      if (ex) kill(ex[0], false);
      const sid = crypto.randomBytes(32).toString('hex'), now = Date.now(), rem = true; // الدخول يُحفظ دائمًا (365 يومًا)
      DB.sessions[sid] = { u, dev, t: now, exp: now + (rem ? 365 * DAY : 12 * 3600e3) }; save();
      const secure = /https/i.test(req.headers['x-forwarded-proto'] || '') ? '; Secure' : '';
      return send(req, res, 200, { ok: true }, { 'Set-Cookie': `sid=${sid}; HttpOnly; SameSite=Lax; Path=/${rem ? '; Max-Age=31536000' : ''}${secure}` });
    }
    const a = auth(req); if (!a) return send(req, res, 401, { err: 'auth' });
    const adm = a.u.role === 'admin';
    if (A === 'logout' && M === 'POST') { kill(a.sid, false); save(); return send(req, res, 200, { ok: true }, { 'Set-Cookie': 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' }); }
    if (A === 'events' && M === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 4000\n\n'); const old = streams.get(a.sid); if (old) { try { old.end(); } catch (e) {} }
      streams.set(a.sid, res); req.on('close', () => { if (streams.get(a.sid) === res) streams.delete(a.sid); }); return;
    }
    if (A === 'data' && M === 'GET') {
      const since = parseInt(url.searchParams.get('since') || '0', 10);
      if (since && since === DB.v) return send(req, res, 200, { same: true, v: DB.v });
      if (since && since > DB.v) return send(req, res, 200, fullData(a));
      if (since && since >= LOGMIN) {
        const es = LOG.filter(e => e.v > since);
        if (!es.some(e => e.t === 'r')) return send(req, res, 200, { delta: true, v: DB.v, ops: es.map(e => ({ id: e.id, c: e.c && (adm || visible(e.c, a.u)) ? pub(e.c, adm) : null })) });
      }
      return send(req, res, 200, fullData(a));
    }
    if (A === 'fav' && M === 'POST') {
      const q = await readBody(req, 1000); if (!q) return send(req, res, 400, {});
      const l = new Set(DB.fav[a.u.u] || []); if (q.on) l.add(+q.id); else l.delete(+q.id); DB.fav[a.u.u] = [...l]; save(); return send(req, res, 200, { ok: true });
    }
    if (!adm) return send(req, res, 403, { err: 'admin' });
    if (A === 'contact') {
      if (M === 'POST') { const q = await readBody(req, 5000), c = q && clean(q); if (!q || typeof c === 'string') return send(req, res, 400, { err: c || 'bad' }); const o = { i: DB.next++, ...c }; DB.contacts.push(o); bump({ t: 'c', id: o.i, c: o }); return send(req, res, 200, { ok: true, v: DB.v, id: o.i }); }
      const id = +parts[1], k = DB.contacts.findIndex(x => x.i === id); if (k < 0) return send(req, res, 404, {});
      if (M === 'PUT') { const q = await readBody(req, 5000), c = q && clean(q); if (!q || typeof c === 'string') return send(req, res, 400, { err: c || 'bad' }); DB.contacts[k] = { i: id, ...c }; bump({ t: 'c', id, c: DB.contacts[k] }); return send(req, res, 200, { ok: true, v: DB.v }); }
      if (M === 'DELETE') { DB.contacts.splice(k, 1); bump({ t: 'c', id, c: null }); return send(req, res, 200, { ok: true, v: DB.v }); }
    }
    if (A === 'import' && M === 'POST') {
      const q = await readBody(req, 8e6); if (!q || !Array.isArray(q.contacts)) return send(req, res, 400, {});
      const pk = c => { let d = String(c.w || c.p || '').replace(/\D/g, ''); if (d.startsWith('00')) d = d.slice(2); if (d.startsWith('964')) d = d.slice(3); return d.replace(/^0+/, ''); };
      const have = new Map(), fresh = new Set();
      for (const c of DB.contacts) { const k = pk(c); if (k && !have.has(k)) have.set(k, c); }
      let add = 0, dup = 0, bad = 0, nop = 0; const dups = [];
      for (const x of q.contacts.slice(0, 30000)) {
        const c = clean(x); if (typeof c === 'string') { bad++; continue; }
        const k = pk(c); if (!k) { nop++; continue; }
        const ex = have.get(k);
        if (ex) { dup++; if (dups.length < 300) dups.push({ n: c.n, p: c.p, ex: ex.n, exc: ex.c, inf: fresh.has(ex) ? 1 : 0 }); continue; }
        const o = { i: DB.next++, ...c }; DB.contacts.push(o); have.set(k, o); fresh.add(o); add++;
      }
      if (add) bump(); return send(req, res, 200, { ok: true, added: add, dup, bad, nophone: nop, dups, v: DB.v });
    }
    if (A === 'users' && M === 'GET') return send(req, res, 200, { users: usersList(), max: MAXU });
    if (A === 'user') {
      if (M === 'POST') {
        const q = await readBody(req, 3000); if (!q) return send(req, res, 400, {}); const u = str(q.u, 32).toLowerCase(), name = str(q.name, 80);
        if (!name || !validU(u)) return send(req, res, 400, { err: 'fields' }); if (!validPw(q.p, q.k)) return send(req, res, 400, { err: 'weak' });
        if (DB.users.some(x => x.u === u)) return send(req, res, 409, { err: 'exists' }); if (DB.users.filter(x => x.role !== 'admin').length >= MAXU) return send(req, res, 409, { err: 'max' });
        DB.users.push(mkUser(u, name, q.p, q.k, 'user', Array.isArray(q.hc) ? q.hc.map(x => str(x, 120)) : [])); bump(); return send(req, res, 200, { ok: true });
      }
      const x = DB.users.find(z => z.u === String(parts[1] || '').toLowerCase() && z.role !== 'admin'); if (!x) return send(req, res, 404, {});
      if (M === 'PUT') {
        const q = await readBody(req, 3000); if (!q) return send(req, res, 400, {}); if (q.name !== undefined) x.name = str(q.name, 80) || x.name; if (Array.isArray(q.hc)) x.hc = q.hc.map(z => str(z, 120));
        if (q.p || q.k) { if (!validPw(q.p, q.k)) return send(req, res, 400, { err: 'weak' }); x.salt = crypto.randomBytes(16).toString('hex'); x.h = hashPw(q.p, q.k, x.salt); }
        killUser(x.u); bump(); return send(req, res, 200, { ok: true });
      }
      if (M === 'DELETE') { killUser(x.u); DB.users = DB.users.filter(z => z !== x); delete DB.fav[x.u]; bump(); return send(req, res, 200, { ok: true }); }
    }
    if (A === 'unbind' && M === 'POST') { const q = await readBody(req, 500); if (!q) return send(req, res, 400, {}); const u = str(q.u, 32).toLowerCase(); if (u === a.u.u) return send(req, res, 400, {}); killUser(u); return send(req, res, 200, { ok: true }); }
    if (A === 'hc' && M === 'PUT') { const q = await readBody(req, 20000); if (!q || !Array.isArray(q.hc)) return send(req, res, 400, {}); DB.hc = q.hc.map(x => str(x, 120)); bump(); return send(req, res, 200, { ok: true }); }
    if (A === 'account' && M === 'PUT') {
      const q = await readBody(req, 1000), u = q && str(q.u, 32).toLowerCase(); if (!q || !validU(u) || !validPw(q.p, q.k)) return send(req, res, 400, { err: 'weak' });
      if (u !== a.u.u && DB.users.some(x => x.u === u)) return send(req, res, 409, { err: 'exists' });
      for (const s of Object.values(DB.sessions)) if (s.u === a.u.u) s.u = u; delete DB.fav[a.u.u]; a.u.u = u; a.u.salt = crypto.randomBytes(16).toString('hex'); a.u.h = hashPw(q.p, q.k, a.u.salt); save(); return send(req, res, 200, { ok: true });
    }
    if (A === 'wa') {
      const sub = parts[1];
      if (!sub && M === 'GET') return send(req, res, 200, { cfg: pubCfg(), sms: pubSms(), tpls: W.tpls, camps: W.camps.slice().reverse().map(wsum), secret: W.secret });
      if (sub === 'run' && M === 'GET') { const cp = W.camps.find(x => x.st === 'running'); return send(req, res, 200, { run: cp ? wsum(cp) : null }); }
      if (sub === 'cfg' && M === 'PUT') {
        const q = await readBody(req, 10000); if (!q) return send(req, res, 400, {}); const c = W.cfg;
        if (['ultramsg', 'meta', 'custom', 'wpsender'].includes(q.provider)) c.provider = q.provider;
        for (const k of ['url', 'instance', 'phone_id', 'hdr', 'body']) if (q[k] !== undefined) c[k] = str(q[k], k === 'hdr' || k === 'body' ? 2000 : 300);
        if (c.url && !/^https?:\/\//i.test(c.url)) return send(req, res, 400, { err: 'url' });
        if (q.token) c.token = str(q.token, 800); if (q.clearToken) c.token = '';
        if (q.delay !== undefined) c.delay = clampN(q.delay, 5, 3600, 20); if (q.jit !== undefined) c.jit = clampN(q.jit, 0, 80, 0);
        wsave(true); return send(req, res, 200, { ok: true, cfg: pubCfg() });
      }
      if (sub === 'smscfg' && M === 'PUT') {
        const q = await readBody(req, 10000); if (!q) return send(req, res, 400, {}); const c = W.sms;
        if (['smsgate', 'twilio', 'vonage', 'custom'].includes(q.provider)) c.provider = q.provider;
        for (const k of ['url', 'account', 'sender', 'hdr', 'body']) if (q[k] !== undefined) c[k] = str(q[k], k === 'hdr' || k === 'body' ? 2000 : 300);
        if (c.url && !/^https?:\/\//i.test(c.url)) return send(req, res, 400, { err: 'url' });
        if (q.token) c.token = str(q.token, 800); if (q.clearToken) c.token = '';
        if (q.delay !== undefined) c.delay = clampN(q.delay, 2, 3600, 10); if (q.jit !== undefined) c.jit = clampN(q.jit, 0, 80, 0);
        wsave(true); return send(req, res, 200, { ok: true, sms: pubSms() });
      }
      if (sub === 'test' && M === 'POST') {
        const q = await readBody(req, 6000), f = q && fmt(q.to); if (!f || !f.w) return send(req, res, 400, { err: 'phone' });
        const ch = q.ch === 'sms' ? 'sms' : 'wa';
        if (!chReady(ch)) return send(req, res, 400, { err: 'nocfg' });
        const r = await chSend(ch, f.w.replace(/\D/g, ''), str(q.msg, 4000) || 'رسالة تجريبية من دليل الأرقام ✅'); return send(req, res, 200, { ok: r.ok, e: r.e || '' });
      }
    }
    if (A === 'tpl') {
      if (M === 'POST') { const q = await readBody(req, 10000), n = str(q && q.name, 80), b = str(q && q.body, 4096); if (!n || !b) return send(req, res, 400, { err: 'fields' }); if (W.tpls.length >= 200) return send(req, res, 409, { err: 'max' }); const o = { id: W.next++, name: n, body: b }; W.tpls.push(o); wsave(true); return send(req, res, 200, { ok: true, id: o.id }); }
      const k = W.tpls.findIndex(x => x.id === +parts[1]); if (k < 0) return send(req, res, 404, {});
      if (M === 'PUT') { const q = await readBody(req, 10000), n = str(q && q.name, 80), b = str(q && q.body, 4096); if (!n || !b) return send(req, res, 400, { err: 'fields' }); W.tpls[k] = { id: W.tpls[k].id, name: n, body: b }; wsave(true); return send(req, res, 200, { ok: true }); }
      if (M === 'DELETE') { W.tpls.splice(k, 1); wsave(true); return send(req, res, 200, { ok: true }); }
    }
    if (A === 'camp') {
      const busy = () => W.camps.some(x => x.st === 'running');
      if (M === 'POST' && !parts[1]) {
        const q = await readBody(req, 400000); if (!q) return send(req, res, 400, {}); const msg = str(q.msg, 4096);
        const ch = q.ch === 'sms' ? 'sms' : 'wa', draft = !!q.draft, dc = ch === 'sms' ? W.sms : W.cfg;
        if (!msg) return send(req, res, 400, { err: 'msg' }); if (!chReady(ch)) return send(req, res, 400, { err: 'nocfg' }); if (!draft && busy()) return send(req, res, 409, { err: 'busy' });
        const want = new Set((Array.isArray(q.ids) ? q.ids : []).slice(0, 5000).map(Number)), seen = new Set(), rs = [];
        for (const c of DB.contacts) { if (!want.has(c.i)) continue; const w = String(c.w || '').replace(/\D/g, ''); if (w.length < 8 || seen.has(w)) continue; seen.add(w); rs.push({ n: c.n, t: c.t, c: c.c, p: c.p, w, s: 'q' }); }
        if (!rs.length) return send(req, res, 400, { err: 'norcpt' });
        const cp = { id: W.next++, ch, name: str(q.name, 80) || (ch === 'sms' ? 'حملة SMS ' : 'حملة ') + new Date().toISOString().slice(0, 10), msg, d: clampN(q.d, ch === 'sms' ? 2 : 5, 3600, dc.delay), j: clampN(q.j, 0, 80, dc.jit), st: draft ? 'draft' : 'running', cr: Date.now(), end: 0, why: draft ? 'محفوظة كمسودة — اضغط «بدء الإرسال» عندما تكون جاهزًا.' : '', r: rs };
        W.camps.push(cp); wsave(true); if (!draft) pump(); return send(req, res, 200, { ok: true, id: cp.id });
      }
      const cp = W.camps.find(x => x.id === +parts[1]); if (!cp) return send(req, res, 404, {});
      if (M === 'GET') return send(req, res, 200, { ...wsum(cp), msg: cp.msg, dly: cp.d, rs: cp.r.map(x => ({ n: x.n, w: x.w, s: x.s, e: x.e || '', a: x.a || 0 })) });
      if (M === 'DELETE') { if (cp.st === 'running') return send(req, res, 409, { err: 'busy' }); W.camps = W.camps.filter(x => x !== cp); for (const x of cp.r) if (x.m) MID.delete(x.m); wsave(true); return send(req, res, 200, { ok: true }); }
      if (M === 'POST') {
        const a2 = parts[2];
        if (a2 === 'pause' && cp.st === 'running') { cp.st = 'paused'; cp.why = ''; }
        else if (a2 === 'stop' && (cp.st === 'running' || cp.st === 'paused' || cp.st === 'draft')) { cp.st = 'stopped'; cp.why = ''; cp.end = Date.now(); }
        else if (a2 === 'resume' && (cp.st === 'paused' || cp.st === 'stopped' || cp.st === 'draft')) {
          if (busy()) return send(req, res, 409, { err: 'busy' }); if (!chReady(chOf(cp))) return send(req, res, 400, { err: 'nocfg' });
          if (!cp.r.some(x => x.s === 'q')) return send(req, res, 400, { err: 'none' }); cp.st = 'running'; cp.why = ''; cp.end = 0; pump();
        } else if (a2 === 'retry') {
          if (cp.st === 'running') return send(req, res, 409, { err: 'busy' }); if (busy()) return send(req, res, 409, { err: 'busy' }); if (!chReady(chOf(cp))) return send(req, res, 400, { err: 'nocfg' });
          let n = 0; for (const x of cp.r) if (x.s === 'f') { x.s = 'q'; x.e = ''; n++; } if (!n) return send(req, res, 400, { err: 'none' });
          cp.st = 'running'; cp.why = ''; cp.end = 0; pump();
        } else return send(req, res, 400, { err: 'state' });
        wsave(true); return send(req, res, 200, { ok: true });
      }
    }
    if (A === 'backup' && M === 'GET') { const { sessions, ...rest } = DB; return send(req, res, 200, rest, { 'Content-Disposition': 'attachment; filename="phonebook-backup.json"' }); }
    if (A === 'restore' && M === 'POST') {
      const q = await readBody(req, 30e6), d = q && q.db; if (!d || !Array.isArray(d.contacts) || !Array.isArray(d.users) || !d.users.some(x => x.role === 'admin')) return send(req, res, 400, { err: 'shape' });
      DB = { ...d, sessions: DB.sessions, fav: d.fav || {}, hc: d.hc || [], ord: d.ord || [], next: Math.max(d.next || 1, ...d.contacts.map(c => c.i + 1), 1), v: Math.max(DB.v, d.v || 1) + 1 };
      for (const [sid, s] of Object.entries(DB.sessions)) if (!DB.users.some(x => x.u === s.u)) kill(sid, true);
      bump(); return send(req, res, 200, { ok: true });
    }
    return send(req, res, 404, {});
  } catch (e) { console.error(e); try { send(req, res, 500, { err: 'server' }); } catch (_) {} }
}).listen(process.env.PORT || 3000, () => console.log('listening'));
