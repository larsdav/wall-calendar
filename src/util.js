// Small shared helpers for the Worker (responses, D1, request bodies).
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
export const err = (status, error) => json({ error }, status);
export const all = async (db, sql, ...args) => (await db.prepare(sql).bind(...args).all()).results;
export const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
export const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
export const J = (s, d) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
export async function body(req, max = 64 * 1024) {
  const len = +(req.headers.get('content-length') || 0);
  if (len > max) throw Object.assign(new Error('Request too large'), { status: 413 });
  const t = await req.text();
  if (t.length > max) throw Object.assign(new Error('Request too large'), { status: 413 });
  try { return t ? JSON.parse(t) : {}; } catch { throw Object.assign(new Error('Bad JSON'), { status: 400 }); }
}
/**
 * Rate-limit key for an address: IPv4 as is, IPv6 grouped by its /64 network. "::" is expanded first, so
 * 2001:db8::5:1 and 2001:db8::6:1 (same /64, different spelling) share a key and one network can't dodge the limit.
 */
export function ipGroup(raw) {
  const ip = String(raw || 'unknown').toLowerCase();
  if (!ip.includes(':') || ip.includes('.')) return ip;
  const [head, tail] = ip.split('::');
  const h = head ? head.split(':') : [], t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':') + '::/64';
}
