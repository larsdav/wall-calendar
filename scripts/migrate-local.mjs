// Apply schema.sql + migrations/*.sql to the local wrangler D1 (fresh dev database). Usage: node scripts/migrate-local.mjs
import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const root = new URL('..', import.meta.url).pathname;
const w = (file) => execFileSync(root + 'node_modules/.bin/wrangler', ['d1', 'execute', 'wall-calendar', '--local', '--file=' + file], { cwd: root, stdio: 'inherit' });
w('schema.sql');
for (const f of readdirSync(root + 'migrations').filter((f) => f.endsWith('.sql')).sort()) w('migrations/' + f);
