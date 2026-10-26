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
