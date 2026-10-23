// API + session login on top of Supabase Postgres (shared logic, runs inside the Vercel function).
// The Supabase service key lives ONLY in Vercel environment variables. The browser never sees it.
const enc = new TextEncoder(), dec = new TextDecoder();
const J = (o, s = 200, h) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...(h || {}) } });
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

async function same(a, b) { // timing-safe compare
  const [x, y] = await Promise.all([crypto.subtle.digest('SHA-256', enc.encode(String(a || ''))), crypto.subtle.digest('SHA-256', enc.encode(String(b || '')))]);
  const A = new Uint8Array(x), B = new Uint8Array(y); let d = 0;
  for (let i = 0; i < A.length; i++) d |= A[i] ^ B[i];
  return d === 0;
}
async function pbk(pw, saltHex) {
  const k = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(saltHex), iterations: 100000 }, k, 256));
}
async function sign(env, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}
async function mint(env, u) {
  const p = b64(enc.encode(JSON.stringify({ u: u.id, o: u.org_id, r: u.role, n: u.username, e: Date.now() + 864e5 })));
  return p + '.' + (await sign(env, p));
}
async function session(req, env) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.get('cookie') || '');
  if (!m) return null;
  const [p, s] = m[1].split('.');
  if (!p || !s || !(await same(s, await sign(env, p)))) return null;
  try { const d = JSON.parse(dec.decode(unb64(p))); return d.e > Date.now() ? d : null; } catch (e) { return null; }
}
const cookie = (v, age) => `sid=${v}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${age}`;

// ---- Supabase (PostgREST) helpers
const sb = (env, path, o = {}) => fetch(env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path, {
  method: o.method || 'GET',
  headers: { apikey: env.SUPABASE_SERVICE_KEY, authorization: 'Bearer ' + env.SUPABASE_SERVICE_KEY, 'content-type': 'application/json', ...(o.prefer ? { prefer: o.prefer } : {}) },
  body: o.body === undefined ? undefined : JSON.stringify(o.body),
});
async function q(env, path, o) {
  const r = await sb(env, path, o);
  const t = await r.text();
  if (!r.ok) throw new Error('db ' + r.status + ' ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
async function all(env, path) {
  let out = [], off = 0;
  for (;;) { const rows = await q(env, path + '&limit=1000&offset=' + off); out = out.concat(rows); if (rows.length < 1000) return out; off += 1000; }
}
const chunk = (a, n) => { const r = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
const STAFF_FIELDS = ['pn', 'col', 'set', 'ext', 'paid', 'out', 'od', 'odAmt', 'no'];
const SET_KEYS = ['CATS', 'OPD', 'MON', 'CO'];

async function makeUser(env, org, username, password, role) {
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const rows = await q(env, 'app_users', { method: 'POST', prefer: 'return=representation', body: { org_id: org, username, salt, pass_hash: await pbk(password, salt), role } });
  return rows[0];
}
const MINPW = (env) => Math.max(4, +env.MIN_PASSWORD || 6); // set MIN_PASSWORD=4 to allow short passwords like 1234
const cleanUser = (u) => String(u || '').trim().toLowerCase();
const validUser = (u) => /^[a-z0-9._-]{3,40}$/.test(u);

async function ask(body, env) {
  const question = String(body.question || '').slice(0, 1000), data = String(body.data || '').slice(0, 150000);
  if (!question) return J({ error: 'Question is empty.' }, 400);
  const system = 'You are a loan ledger assistant. Answer briefly in the language of the question (Hinglish is fine) using only this data. Amounts are in rupees. Each line: name, category, mobile, total, paid, balance, overdue, bid.\n' + data;
  try {
    if (env.ANTHROPIC_API_KEY) {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: env.AI_MODEL || 'claude-sonnet-4-6', max_tokens: 1000, system, messages: [{ role: 'user', content: question }] }) });
      const j = await r.json();
      return j.content ? J({ answer: j.content.map((x) => x.text || '').join('') }) : J({ error: (j.error && j.error.message) || 'AI error' }, 502);
    }
    if (env.GEMINI_API_KEY) {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + (env.AI_MODEL || 'gemini-flash-latest') + ':generateContent', { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: question }] }] }) });
      const j = await r.json();
      return j.candidates ? J({ answer: j.candidates[0].content.parts.map((p) => p.text || '').join('') }) : J({ error: (j.error && j.error.message) || 'AI error' }, 502);
    }
    return J({ error: 'No AI key on the server (set ANTHROPIC_API_KEY or GEMINI_API_KEY).' }, 503);
  } catch (e) { return J({ error: 'Could not reach the AI service.' }, 502); }
}

async function route(req, env, url) {
  const p = url.pathname, m = req.method;
  const body = async () => { try { return await req.json(); } catch (e) { return {}; } };
  if (p === '/api/health') return J({ ok: true, platform: 'cloudflare-workers', time: new Date().toISOString(), db: Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY), sessionSecret: Boolean(env.SESSION_SECRET) });
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY || !env.SESSION_SECRET) return J({ error: 'Server is not configured (SUPABASE_URL, SUPABASE_SERVICE_KEY, SESSION_SECRET).' }, 503);
  if (m !== 'GET' && m !== 'HEAD') { const o = req.headers.get('origin'); if (o && new URL(o).host !== url.host) return J({ error: 'Bad origin' }, 403); }

  if (p === '/api/status' && m === 'GET') { const u = await q(env, 'app_users?select=id&limit=1'); return J({ setup: !u.length }); }
  if (p === '/api/setup' && m === 'POST') {
    const b = await body();
    if (!env.SETUP_KEY || !(await same(b.key, env.SETUP_KEY))) return J({ error: 'Wrong setup key.' }, 403);
    const un = cleanUser(b.username);
    if (!validUser(un) || String(b.password || '').length < MINPW(env)) return J({ error: 'Username: 3-40 letters/numbers. Password: at least ' + MINPW(env) + ' characters.' }, 400);
    const org = (await q(env, 'orgs', { method: 'POST', prefer: 'return=representation', body: { name: String(b.org || 'My business').slice(0, 80) } }))[0];
    try { await makeUser(env, org.id, un, String(b.password), 'Admin'); } catch (e) { await q(env, 'orgs?id=eq.' + org.id, { method: 'DELETE' }); return J({ error: 'That username already exists.' }, 409); }
    return J({ ok: true });
  }
  if (p === '/api/login' && m === 'POST') {
    const b = await body(), un = cleanUser(b.username);
    let u = (await q(env, 'app_users?select=*&username=eq.' + encodeURIComponent(un) + '&limit=1'))[0];
    // First login on a brand-new server: create the first Admin (default admin / 1234, or ADMIN_USER / ADMIN_PASSWORD).
    if (!u && env.DISABLE_DEFAULT_ADMIN !== '1') {
      const bu = cleanUser(env.ADMIN_USER || 'admin'), bp = String(env.ADMIN_PASSWORD || '1234');
      if (un === bu && (await same(b.password, bp)) && !(await q(env, 'app_users?select=id&limit=1')).length) {
        try {
          const org = (await q(env, 'orgs', { method: 'POST', prefer: 'return=representation', body: { name: 'My business' } }))[0];
          u = await makeUser(env, org.id, bu, bp, 'Admin');
        } catch (e) { u = (await q(env, 'app_users?select=*&username=eq.' + encodeURIComponent(un) + '&limit=1'))[0]; }
      }
    }
    const hash = await pbk(String(b.password || ''), u ? u.salt : '00'.repeat(16));
    if (!u || !(await same(hash, u.pass_hash))) return J({ error: 'Wrong username or password.' }, 401);
    return J({ ok: true, user: u.username, role: u.role }, 200, { 'set-cookie': cookie(await mint(env, u), 86400) });
  }
  if (p === '/api/logout' && m === 'POST') return J({ ok: true }, 200, { 'set-cookie': cookie('', 0) });

  const S = await session(req, env);
  if (!S) return J({ error: 'Not signed in' }, 401);
  const org = S.o, admin = S.r === 'Admin', E = encodeURIComponent;
  const need = () => (admin ? null : J({ error: 'Admins only' }, 403));

  if (p === '/api/password' && m === 'POST') {
    const b = await body(), u = (await q(env, `app_users?org_id=eq.${org}&id=eq.${S.u}&select=*`))[0];
    if (!u || !(await same(await pbk(String(b.current || ''), u.salt), u.pass_hash))) return J({ error: 'Current password is wrong.' }, 400);
    if (String(b.password || '').length < MINPW(env)) return J({ error: 'New password must be at least ' + MINPW(env) + ' characters.' }, 400);
    const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
    await q(env, `app_users?org_id=eq.${org}&id=eq.${S.u}`, { method: 'PATCH', prefer: 'return=minimal', body: { salt, pass_hash: await pbk(String(b.password), salt) } });
    return J({ ok: true });
  }
  if (p === '/api/me') return J({ user: S.n, role: S.r });
  if (p === '/api/data' && m === 'GET') {
    const [cs, ps, ss] = await Promise.all([
      all(env, `customers?org_id=eq.${org}&select=id,data&order=id.asc`),
      all(env, `payments?org_id=eq.${org}&select=rid,data&order=rid.asc`),
      q(env, `settings?org_id=eq.${org}&select=key,value`),
    ]);
    return J({ customers: cs, payments: ps, settings: Object.fromEntries(ss.map((x) => [x.key, x.value])), me: { user: S.n, role: S.r } });
  }
  if (p === '/api/ask' && m === 'POST') return need() || ask(await body(), env);

  // ---- customers
  if (p === '/api/customers' && m === 'POST') {
    if (need()) return need();
    const b = await body(), arr = Array.isArray(b) ? b : [b];
    if (!arr.length) return J({ ids: [] });
    const want = arr.map((c) => Math.trunc(+c.id)).filter((n) => n > 0);
    const taken = new Set(want.length ? (await q(env, `customers?org_id=eq.${org}&id=in.(${want.join(',')})&select=id`)).map((x) => x.id) : []);
    const mx = await q(env, `customers?org_id=eq.${org}&select=id&order=id.desc&limit=1`);
    let next = (mx[0] ? mx[0].id : 0) + 1;
    const seen = new Set(taken), ids = [];
    for (const c of arr) { let id = Math.trunc(+c.id); if (!(id > 0) || seen.has(id)) id = next++; while (seen.has(id)) id = next++; seen.add(id); ids.push(id); }
    const rows = arr.map((c, i) => ({ org_id: org, id: ids[i], data: { ...c, id: ids[i] } }));
    for (const part of chunk(rows, 200)) await q(env, 'customers', { method: 'POST', prefer: 'return=minimal', body: part });
    return J({ ids });
  }
  if (p === '/api/customers' && m === 'DELETE') { if (need()) return need(); await q(env, `customer_docs?org_id=eq.${org}`, { method: 'DELETE' }); await q(env, `customers?org_id=eq.${org}`, { method: 'DELETE' }); return J({ ok: true }); }
  let mt = /^\/api\/customers\/(\d+)$/.exec(p);
  if (mt && m === 'PUT') {
    const id = +mt[1], b = await body();
    const cur = await q(env, `customers?org_id=eq.${org}&id=eq.${id}&select=data`);
    if (!cur.length) return J({ error: 'Not found' }, 404);
    let data;
    if (admin) data = { ...b, id };
    else { data = { ...cur[0].data }; STAFF_FIELDS.forEach((k) => { if (k in b) data[k] = b[k]; }); }
    await q(env, `customers?org_id=eq.${org}&id=eq.${id}`, { method: 'PATCH', prefer: 'return=minimal', body: { data, updated_at: new Date().toISOString() } });
    return J({ ok: true });
  }
  if (mt && m === 'DELETE') { if (need()) return need(); await q(env, `customer_docs?org_id=eq.${org}&cid=eq.${+mt[1]}`, { method: 'DELETE' }); await q(env, `customers?org_id=eq.${org}&id=eq.${+mt[1]}`, { method: 'DELETE' }); return J({ ok: true }); }

  // ---- payments (ledger)
  if (p === '/api/payments' && m === 'POST') {
    const b = await body(), arr = (Array.isArray(b) ? b : [b]).filter((x) => x && x.rid && Array.isArray(x.data));
    const rows = arr.map((x) => ({ org_id: org, rid: String(x.rid).slice(0, 80), data: x.data }));
    for (const part of chunk(rows, 200)) await q(env, 'payments?on_conflict=org_id,rid', { method: 'POST', prefer: (admin ? 'resolution=merge-duplicates' : 'resolution=ignore-duplicates') + ',return=minimal', body: part });
    return J({ ok: true, n: rows.length });
  }
  if (p === '/api/payments' && m === 'DELETE') { if (need()) return need(); await q(env, `payments?org_id=eq.${org}`, { method: 'DELETE' }); return J({ ok: true }); }
  mt = /^\/api\/payments\/(.+)$/.exec(p);
  if (mt && m === 'PUT') { if (need()) return need(); const b = await body(); await q(env, `payments?org_id=eq.${org}&rid=eq.${E(decodeURIComponent(mt[1]))}`, { method: 'PATCH', prefer: 'return=minimal', body: { data: b.data } }); return J({ ok: true }); }
  if (mt && m === 'DELETE') { if (need()) return need(); await q(env, `payments?org_id=eq.${org}&rid=eq.${E(decodeURIComponent(mt[1]))}`, { method: 'DELETE' }); return J({ ok: true }); }

  // ---- customer documents (photo, Aadhaar, PAN): Admin only
  mt = /^\/api\/docs\/(\d+)(?:\/(photo|aadhaar|pan))?$/.exec(p);
  if (mt) {
    if (need()) return need();
    const cid = +mt[1], kind = mt[2];
    if (m === 'GET' && !kind) return J({ docs: await q(env, `customer_docs?org_id=eq.${org}&cid=eq.${cid}&select=kind,data`) });
    if (m === 'PUT' && kind) {
      const d = String((await body()).data || '');
      if (!/^data:image\/(jpeg|png|webp);base64,/.test(d)) return J({ error: 'Only JPG, PNG or WEBP images.' }, 400);
      if (d.length > 900000) return J({ error: 'Image is too large.' }, 413);
      if (!(await q(env, `customers?org_id=eq.${org}&id=eq.${cid}&select=id`)).length) return J({ error: 'Customer not found' }, 404);
      await q(env, 'customer_docs?on_conflict=org_id,cid,kind', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { org_id: org, cid, kind, data: d, updated_at: new Date().toISOString() } });
      return J({ ok: true });
    }
    if (m === 'DELETE' && kind) { await q(env, `customer_docs?org_id=eq.${org}&cid=eq.${cid}&kind=eq.${kind}`, { method: 'DELETE' }); return J({ ok: true }); }
  }

  // ---- settings
  mt = /^\/api\/settings\/([A-Z]+)$/.exec(p);
  if (mt && m === 'PUT') {
    const key = mt[1];
    if (!SET_KEYS.includes(key)) return J({ error: 'Unknown setting' }, 400);
    if (!admin && key !== 'MON') return J({ error: 'Admins only' }, 403);
    const b = await body();
    await q(env, 'settings?on_conflict=org_id,key', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { org_id: org, key, value: b.value, updated_at: new Date().toISOString() } });
    return J({ ok: true });
  }

  // ---- one-time migration of existing data
  if (p === '/api/import' && m === 'POST') {
    if (need()) return need();
    const b = await body();
    const cs = (b.customers || []).map((c) => ({ org_id: org, id: Math.trunc(+c.id), data: c })).filter((r) => r.id > 0);
    const ps = (b.payments || []).filter((x) => x.rid && Array.isArray(x.data)).map((x) => ({ org_id: org, rid: String(x.rid), data: x.data }));
    for (const part of chunk(cs, 200)) await q(env, 'customers?on_conflict=org_id,id', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: part });
    for (const part of chunk(ps, 200)) await q(env, 'payments?on_conflict=org_id,rid', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: part });
    for (const k of SET_KEYS) if (b.settings && b.settings[k] !== undefined) await q(env, 'settings?on_conflict=org_id,key', { method: 'POST', prefer: 'resolution=merge-duplicates,return=minimal', body: { org_id: org, key: k, value: b.settings[k] } });
    return J({ ok: true, customers: cs.length, payments: ps.length });
  }

  // ---- users (Admin only, same business only)
  if (p === '/api/users' && m === 'GET') { if (need()) return need(); return J({ users: await q(env, `app_users?org_id=eq.${org}&select=id,username,role&order=created_at.asc`) }); }
  if (p === '/api/users' && m === 'POST') {
    if (need()) return need();
    const b = await body(), un = cleanUser(b.username), role = b.role === 'Admin' ? 'Admin' : 'Staff';
    if (!validUser(un) || String(b.password || '').length < MINPW(env)) return J({ error: 'Username: 3-40 letters/numbers. Password: at least ' + MINPW(env) + ' characters.' }, 400);
    try { await makeUser(env, org, un, String(b.password), role); } catch (e) { return J({ error: 'That username already exists.' }, 409); }
    return J({ ok: true });
  }
  mt = /^\/api\/users\/([0-9a-f-]{36})$/.exec(p);
  if (mt && m === 'DELETE') {
    if (need()) return need();
    if (mt[1] === S.u) return J({ error: 'You cannot delete yourself.' }, 400);
    const us = await q(env, `app_users?org_id=eq.${org}&select=id,role`);
    const t = us.find((x) => x.id === mt[1]);
    if (!t) return J({ error: 'Not found' }, 404);
    if (t.role === 'Admin' && us.filter((x) => x.role === 'Admin').length < 2) return J({ error: 'Keep at least one Admin.' }, 400);
    await q(env, `app_users?org_id=eq.${org}&id=eq.${mt[1]}`, { method: 'DELETE' });
    return J({ ok: true });
  }
  return J({ error: 'Not found' }, 404);
}

export { route };
