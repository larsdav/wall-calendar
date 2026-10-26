// Writes code files for the Cloudflare MCP / API `execute` tool, so production can be deployed without `wrangler login`.
//   node scripts/mk-deploy.mjs createdb | schema | deploy | cron | sql "SQL..." [more SQL]
// Files land in /tmp/wc-deploy/<cmd>.js. Each is an async function that uses `cloudflare.request` and `accountId`.
// The D1 id is read from env WC_DB_ID (or wrangler.toml). Nothing secret is written.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
const root = new URL('..', import.meta.url).pathname;
const NAME = process.env.WC_NAME || 'wall-calendar';
const prod = existsSync(root + 'wrangler.toml') ? readFileSync(root + 'wrangler.toml', 'utf8').match(/database_id = "([0-9a-f-]{36})"/) : null;
const DB = process.env.WC_DB_ID || (prod && prod[1]);
const dir = '/tmp/wc-deploy'; mkdirSync(dir, { recursive: true, mode: 0o700 });
const q = (sql) => `cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/d1/database/${DB}/query\`, body: { sql: ${JSON.stringify(sql)} } })`;
const [cmd, ...rest] = process.argv.slice(2);
if (cmd !== 'createdb' && !DB) throw new Error('Set WC_DB_ID');
if (cmd === 'createdb') {
  writeFileSync(`${dir}/createdb.js`, `async () => { const r = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/d1/database\`, body: { name: ${JSON.stringify(NAME)} } }); return { ok: r.success, uuid: r.result && r.result.uuid, errors: r.errors }; }`);
} else if (cmd === 'schema') {
  writeFileSync(`${dir}/schema.js`, `async () => { const r = await ${q(readFileSync(root + 'schema.sql', 'utf8'))};
  const t = await ${q("SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name")};
  return { ok: r.success, objects: t.result[0].results.map((x) => x.name) }; }`);
} else if (cmd === 'deploy') {
  const script = readFileSync(root + 'dist/worker.js', 'utf8');
  const metadata = { main_module: 'worker.js', compatibility_date: '2026-05-01', bindings: [{ type: 'd1', name: 'DB', id: DB }], observability: { enabled: false } };
  writeFileSync(`${dir}/deploy.js`, `async () => {
const script = ${JSON.stringify(script)};
const metadata = ${JSON.stringify(metadata)};
const b = "----WC" + Date.now();
const body = ["--"+b, 'Content-Disposition: form-data; name="metadata"', "Content-Type: application/json", "", JSON.stringify(metadata), "--"+b, 'Content-Disposition: form-data; name="worker.js"; filename="worker.js"', "Content-Type: application/javascript+module", "", script, "--"+b+"--", ""].join("\\r\\n");
const up = await cloudflare.request({ method: "PUT", path: \`/accounts/\${accountId}/workers/scripts/${NAME}\`, body, contentType: "multipart/form-data; boundary=" + b, rawBody: true });
const sub = await cloudflare.request({ method: "POST", path: \`/accounts/\${accountId}/workers/scripts/${NAME}/subdomain\`, body: { enabled: true, previews_enabled: false } });
return { uploaded: up.success, errors: up.errors, etag: up.result && up.result.etag, subdomain: sub.result };
}`);
} else if (cmd === 'cron') {
  writeFileSync(`${dir}/cron.js`, `async () => { const r = await cloudflare.request({ method: 'PUT', path: \`/accounts/\${accountId}/workers/scripts/${NAME}/schedules\`, body: [{ cron: '*/10 * * * *' }] }); return { ok: r.success, result: r.result, errors: r.errors }; }`);
} else if (cmd === 'sql') {
  writeFileSync(`${dir}/sql.js`, `async () => { const o = []; for (const sql of ${JSON.stringify(rest)}) { const r = await cloudflare.request({ method: 'POST', path: \`/accounts/\${accountId}/d1/database/${DB}/query\`, body: { sql } }); o.push({ sql: sql.slice(0, 80), rows: r.result[0].results.slice(0, 20), changes: r.result[0].meta.changes }); } return o; }`);
} else throw new Error('usage: createdb | schema | deploy | cron | sql');
console.log('wrote', `${dir}/${cmd}.js`);
