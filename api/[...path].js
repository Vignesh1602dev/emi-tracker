// Vercel Function: every request to /api/* lands here and is handled by lib/core.js
import { route } from '../lib/core.js';

export default async function handler(req, res) {
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.url}`;
  let body;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    body = Buffer.concat(chunks);
  }
  let r;
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    r = await route(new Request(url, { method: req.method, headers, body }), process.env, new URL(url));
  } catch (e) {
    r = new Response(JSON.stringify({ error: 'Server error' }), { status: 500, headers: { 'content-type': 'application/json' } });
  }
  res.statusCode = r.status;
  r.headers.forEach((v, k) => { if (k !== 'set-cookie') res.setHeader(k, v); });
  const sc = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  if (sc.length) res.setHeader('set-cookie', sc);
  res.end(Buffer.from(await r.arrayBuffer()));
}
