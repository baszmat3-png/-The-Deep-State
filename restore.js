'use strict';
// يستعيد الملفات من التخزين الخارجي (Upstash Redis REST) قبل إقلاع الخادم.
// يُستدعى من server.js. الخروج 0 = نجاح (حتى لو التخزين فارغ)، 1 = تعذّر الاتصال/البيانات تالفة.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const URL_ = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/+$/, ''), TOK = process.env.UPSTASH_REDIS_REST_TOKEN || '', PFX = process.env.REMOTE_PREFIX || 'pb';
const DATA = process.env.DATA_DIR || __dirname, FILES = ['db.json', 'wa.json', 'meta.json'];
async function cmd(a) {
  for (let t = 0; ; t++) {
    try {
      const r = await fetch(URL_, { method: 'POST', headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json' }, body: JSON.stringify(a), signal: AbortSignal.timeout(20000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.error) throw new Error(j.error || 'HTTP ' + r.status);
      return j.result;
    } catch (e) { if (t >= 2) throw e; await new Promise(r => setTimeout(r, 1500 * (t + 1))); }
  }
}
(async () => {
  const restored = [], empty = []; fs.mkdirSync(DATA, { recursive: true });
  for (const f of FILES) {
    const n = await cmd(['GET', `${PFX}:${f}:n`]);
    if (n == null) { empty.push(f); continue; }
    let b64 = '';
    for (let i = 0; i < +n; i++) { const c = await cmd(['GET', `${PFX}:${f}:${i}`]); if (c == null) throw new Error('missing chunk ' + f + ':' + i); b64 += c; }
    const txt = zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8'); JSON.parse(txt);
    const p = path.join(DATA, f), tmp = p + '.tmp'; fs.writeFileSync(tmp, txt); fs.renameSync(tmp, p); restored.push(f);
  }
  console.log(JSON.stringify({ restored, empty }));
})().catch(e => { console.error('restore failed:', e.message); process.exit(1); });
