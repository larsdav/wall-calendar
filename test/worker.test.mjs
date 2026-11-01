import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Runs the built Worker in Miniflare (installed with wrangler) against a fresh in-memory D1.
const root = new URL('..', import.meta.url).pathname;
let Miniflare = null;
try { ({ Miniflare } = await import('miniflare')); } catch {}

async function start() {
  execFileSync(process.execPath, [root + 'scripts/build.mjs'], { cwd: root, stdio: 'ignore' });
  const mf = new Miniflare({ modules: true, scriptPath: root + 'dist/worker.js', d1Databases: ['DB'], compatibilityDate: '2026-05-01' });
  const db = await mf.getD1Database('DB');
  const sql = [readFileSync(root + 'schema.sql', 'utf8'), ...readdirSync(root + 'migrations').filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(root + 'migrations/' + f, 'utf8'))].join('\n');
  for (const s of sql.split(/;\s*\n/).map((x) => x.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean)) await db.prepare(s).run();
  const res = await mf.dispatchFetch('https://wall.test/api/setup', { method: 'POST', headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: JSON.stringify({ pin: '2468' }) });
  const ck = Object.fromEntries(res.headers.getSetCookie().map((c) => c.split(';')[0].split('=')));
  const call = (cookie) => async (method, path, b) => {
    const r = await mf.dispatchFetch('https://wall.test/api' + path, { method, headers: { 'x-wc': '1', 'content-type': 'application/json', cookie }, body: b ? JSON.stringify(b) : undefined });
    return r.json();
  };
  const dev = `__Host-wc-dev=${ck['__Host-wc-dev']}`;
  return { mf, parent: call(`${dev}; __Host-wc-par=${ck['__Host-wc-par']}`), kid: call(dev) };
}

test('rejecting a completion that was already approved takes its stars back', { skip: !Miniflare && 'miniflare not installed' }, async () => {
  const { mf, parent, kid } = await start();
  try {
    await parent('PUT', '/settings', { approval: true });
    const { id: pid } = await parent('POST', '/people', { name: 'Emma', role: 'kid' });
    const { id: tid } = await parent('POST', '/tasks', { title: 'Make bed', stars: 3, recur: 'daily', assignees: [pid] });
    const c1 = await kid('POST', '/complete', { task_id: tid, person_id: pid });
    assert.equal(c1.status, 'pending');
    await parent('POST', `/completions/${c1.completion_id}/approve`);
    await parent('POST', `/completions/${c1.completion_id}/reject`); // "Not yet" tapped on a screen that hadn't refreshed
    let st = await parent('GET', '/state');
    assert.equal(st.completions.length, 0);
    assert.equal(st.balances[pid] || 0, 0, 'no stars left without a completion');
    const c2 = await kid('POST', '/complete', { task_id: tid, person_id: pid });
    await parent('POST', `/completions/${c2.completion_id}/approve`);
    st = await parent('GET', '/state');
    assert.equal(st.balances[pid], 3, 'one chore today is worth its stars once');
  } finally { await mf.dispose(); }
});
