// Unauthenticated smoke check of a deployment (safe for production: creates no session, writes nothing).
// Usage: node scripts/smoke.mjs <baseUrl> <expectedVersion> [markers...]
const [base, ver, ...markers] = process.argv.slice(2);
let bad = 0; const ok = (n, c, d = '') => { console.log(c ? 'PASS' : 'FAIL', n, d); if (!c) bad++; };
const st = await (await fetch(base + '/api/status')).json();
ok('version', st.v === ver, st.v);
ok('setup kept', st.setup === true);
const html = await (await fetch(base + '/')).text(); ok('index served', html.includes('app.js'));
const js = await (await fetch(base + '/app.js')).text();
for (const m of markers) ok('app.js has ' + m, js.includes(m));
for (const [m, p] of [['GET', '/api/state'], ['POST', '/api/lists/1/items'], ['PUT', '/api/meals'], ['POST', '/api/people']]) {
  const r = await fetch(base + p, { method: m, headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: m === 'GET' ? undefined : '{}' });
  ok(`${m} ${p} refused without device`, r.status === 401 || r.status === 403, r.status);
}
process.exit(bad ? 1 : 0);
