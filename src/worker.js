// Family wall calendar: one Cloudflare Worker (static files inlined at build) + D1.
import { ASSETS, ASSET_VERSION } from './assets.gen.js';
import { expandIcs, normalizeFeedUrl } from './ics.js';
import { dayKey, validTz } from './tz.js';
import { json, err, all, first, run, J, body } from './util.js';
import { featureApi, featureState } from './features.js';
import { balances, rewardProgress, checkRedeem, isDue, cleanTask, cleanReward, cleanText, cleanEmoji, cleanMealSlots, cleanIds, COLOR_RE } from './logic.js';

const DEV_COOKIE = '__Host-wc-dev';
const PAR_COOKIE = '__Host-wc-par';
const DEVICE_TTL = 400 * 86400e3;
const PARENT_IDLE = 15 * 60e3, PARENT_REMEMBER = 30 * 86400e3;
const PIN_ITER = 20000;
const SYNC_EVERY = 10 * 60e3, REEXPAND_EVERY = 3 * 3600e3;
const WIN_BACK = 45 * 86400e3, WIN_AHEAD = 400 * 86400e3;
const MAX_PHOTO = 1_500_000, MAX_THUMB = 200_000, MAX_PHOTOS = 400;
const MAX_FEED = 5_000_000;
const enc = new TextEncoder();

const DEFAULTS = {
  family_name: 'Our Family', tz: 'America/Chicago', theme: 'auto', night_start: '21:00', night_end: '06:30',
  night_dim: 55, idle_minutes: 5, slide_seconds: 12, week_start: 0, clock24: false, default_view: 'week',
  units: 'F', weather: null, approval: false, drift: true, meal_slots: ['dinner'], slideshow_albums: [],
};
const SETTING_KEYS = Object.keys(DEFAULTS);

// ---------- responses ----------
const CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.open-meteo.com https://geocoding-api.open-meteo.com; manifest-src 'self'; worker-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const SEC = {
  'content-security-policy': CSP, 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY', 'x-robots-tag': 'noindex, nofollow', 'strict-transport-security': 'max-age=31536000',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};
function withSec(res) { const r = new Response(res.body, res); for (const [k, v] of Object.entries(SEC)) r.headers.set(k, v); return r; }

const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function serveAsset(name, request) {
  const a = ASSETS[name];
  if (!a) return null;
  const etag = `"${ASSET_VERSION}-${a.h}"`;
  const h = { 'content-type': a.type, 'cache-control': name.startsWith('icons/') ? 'public, max-age=86400' : 'no-cache', etag };
  if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: h });
  return new Response(a.b64 ? b64bytes(a.b64) : a.body, { headers: h });
}

// ---------- crypto ----------
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', typeof s === 'string' ? enc.encode(s) : s));
const randHex = (n) => hex(crypto.getRandomValues(new Uint8Array(n)));
async function pbkdf2(pin, saltHex, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: Uint8Array.from(saltHex.match(/../g), (h) => parseInt(h, 16)), iterations: iter }, key, 256);
  return hex(bits);
}
async function hashPin(pin) { const salt = randHex(16); return `pbkdf2:${PIN_ITER}:${salt}:${await pbkdf2(pin, salt, PIN_ITER)}`; }
async function pinMatches(pin, stored) {
  const m = /^pbkdf2:(\d+):([0-9a-f]{32}):([0-9a-f]{64})$/.exec(stored || '');
  if (!m) return false;
  const got = await pbkdf2(pin, m[2], +m[1]);
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= got.charCodeAt(i) ^ m[3].charCodeAt(i);
  return diff === 0;
}
const validPin = (p) => typeof p === 'string' && /^\d{4,8}$/.test(p);

// ---------- db helpers ----------

async function getSettings(db) {
  const rows = await all(db, 'SELECT key, value FROM settings');
  const s = { ...DEFAULTS };
  let pin = null;
  for (const r of rows) { if (r.key === 'pin_hash') pin = r.value; else if (SETTING_KEYS.includes(r.key)) s[r.key] = J(r.value, DEFAULTS[r.key]); }
  return { s, pin };
}
const putSetting = (db, key, value) => run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

const taskRow = (t) => ({ ...t, days: J(t.days, []), assignees: J(t.assignees, []), steps: J(t.steps, []), active: !!t.active });
const rewardRow = (r) => ({ ...r, person_ids: J(r.person_ids, []), task_ids: J(r.task_ids, []), active: !!r.active });

// ---------- sessions ----------
function cookies(req) {
  const out = {};
  for (const part of (req.headers.get('cookie') || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
const setCookie = (name, value, maxAgeS) => `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}`;
async function newSession(db, kind, ttl, idle) {
  const token = randHex(32), now = Date.now();
  await run(db, 'INSERT INTO sessions (token_hash, kind, created_at, expires_at, idle_ms, last_seen) VALUES (?, ?, ?, ?, ?, ?)', await sha256hex(token), kind, now, now + ttl, idle, now);
  return token;
}
async function checkSession(db, token, kind) {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const h = await sha256hex(token);
  const row = await first(db, 'SELECT * FROM sessions WHERE token_hash = ? AND kind = ?', h, kind);
  const now = Date.now();
  if (!row || row.expires_at < now || (row.idle_ms && now - row.last_seen > row.idle_ms)) return null;
  if (now - row.last_seen > 30e3) await run(db, 'UPDATE sessions SET last_seen = ? WHERE token_hash = ?', now, h);
  return { ...row, until: row.idle_ms ? Math.min(row.expires_at, now + row.idle_ms) : row.expires_at };
}

// rate limit PIN attempts: 5 per 15 min per IP, 20 per 15 min overall
async function limited(db, ip) {
  const since = Date.now() - 15 * 60e3;
  await run(db, 'DELETE FROM attempts WHERE ts < ?', since);
  const a = await first(db, 'SELECT COUNT(*) AS n FROM attempts WHERE key = ? AND ts >= ?', ip, since);
  const b = await first(db, 'SELECT COUNT(*) AS n FROM attempts WHERE ts >= ?', since);
  return a.n >= 5 || b.n >= 20;
}
const ipKey = (req) => { const ip = req.headers.get('cf-connecting-ip') || 'local'; return ip.includes(':') ? ip.split(':').slice(0, 4).join(':') : ip; };

// ---------- calendar sync ----------
function feedUrlOk(u) {
  try {
    const url = new URL(normalizeFeedUrl(u));
    if (url.protocol !== 'https:') return null;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname) || !url.hostname.includes('.')) return null;
    return url.toString();
  } catch { return null; }
}
async function syncCalendar(env, cal, tz, force = false) {
  const now = Date.now();
  try {
    const res = await fetch(normalizeFeedUrl(cal.url), { headers: { 'user-agent': 'wall-calendar/1.0 (+family kiosk)', accept: 'text/calendar, */*' }, redirect: 'follow', cf: { cacheTtl: 120 } });
    if (!res.ok) throw new Error(`The calendar server answered ${res.status}${res.status === 404 ? ' (check the link)' : ''}`);
    const text = await res.text();
    if (text.length > MAX_FEED) throw new Error('Calendar feed is too large (over 5 MB)');
    if (!text.includes('BEGIN:VCALENDAR')) throw new Error("That link didn't return a calendar (no BEGIN:VCALENDAR)");
    const hash = await sha256hex(text);
    if (!force && hash === cal.hash && cal.expanded_at && now - cal.expanded_at < REEXPAND_EVERY) {
      await run(env.DB, 'UPDATE calendars SET synced_at = ?, ok_at = ?, error = NULL WHERE id = ?', now, now, cal.id);
      return { id: cal.id, unchanged: true };
    }
    const events = expandIcs(text, { fromMs: now - WIN_BACK, toMs: now + WIN_AHEAD, tz, max: 4000 })
      .map((e) => ({ i: e.id, t: e.title.slice(0, 120), l: e.loc.slice(0, 120), a: e.allDay ? 1 : 0, s: e.start, e: e.end }));
    await run(env.DB, 'UPDATE calendars SET synced_at = ?, ok_at = ?, expanded_at = ?, error = NULL, hash = ?, events = ?, event_count = ? WHERE id = ?', now, now, now, hash, JSON.stringify(events), events.length, cal.id);
    return { id: cal.id, count: events.length };
  } catch (e) {
    await run(env.DB, 'UPDATE calendars SET synced_at = ?, error = ? WHERE id = ?', now, String(e.message || e).slice(0, 200), cal.id);
    return { id: cal.id, error: String(e.message || e) };
  }
}
async function syncAll(env, { onlyStale = false, force = false } = {}) {
  const { s } = await getSettings(env.DB);
  const cals = await all(env.DB, 'SELECT id, url, hash, expanded_at, synced_at FROM calendars WHERE enabled = 1');
  const out = [];
  for (const c of cals) {
    if (onlyStale && c.synced_at && Date.now() - c.synced_at < SYNC_EVERY) continue;
    out.push(await syncCalendar(env, c, s.tz, force));
  }
  return out;
}

// ---------- state ----------
async function loadCore(db) {
  const [people, tasks, rewards, ledger, redemptions] = await Promise.all([
    all(db, 'SELECT id, name, color, emoji, role, sort FROM people ORDER BY sort, id'),
    all(db, 'SELECT * FROM tasks ORDER BY sort, id'),
    all(db, 'SELECT * FROM rewards ORDER BY sort, id'),
    all(db, 'SELECT id, person_id, delta, kind, task_id, reward_id, completion_id, note, created_at FROM ledger ORDER BY created_at, id'),
    all(db, 'SELECT * FROM redemptions ORDER BY created_at, id'),
  ]);
  return { people, tasks: tasks.map(taskRow), rewards: rewards.map(rewardRow), ledger, redemptions };
}

async function buildState(env, parent) {
  const db = env.DB;
  const { s } = await getSettings(db);
  const core = await loadCore(db);
  const today = dayKey(Date.now(), s.tz);
  const since = new Date(Date.parse(today + 'T00:00:00Z') - 40 * 86400e3).toISOString().slice(0, 10);
  const [completions, calendars, photos] = await Promise.all([
    all(db, 'SELECT id, task_id, person_id, day, status, stars, created_at FROM completions WHERE day >= ? ORDER BY day, id', since),
    all(db, `SELECT id, name, color, person_id, enabled, synced_at, ok_at, error, event_count${parent ? ', url' : ''} FROM calendars ORDER BY id`),
    all(db, 'SELECT id, w, h, caption, created_at FROM photos ORDER BY created_at DESC, id DESC'),
  ]);
  const kids = core.people.filter((p) => p.role === 'kid');
  const rewards = core.rewards.map((r) => ({ ...r, progress: rewardProgress(r, core.ledger, core.redemptions, kids) }));
  return {
    v: ASSET_VERSION, now: Date.now(), today, settings: s, people: core.people, tasks: core.tasks, rewards,
    completions, balances: balances(core.ledger), ledger: core.ledger.slice(-150).reverse(),
    redemptions: core.redemptions.slice(-60).reverse(), calendars, photos,
    ...(await featureState(db, s, today)),
  };
}

// ---------- request handling ----------

async function api(req, env, ctx, url) {
  const db = env.DB;
  const path = url.pathname.slice(4); // after /api
  const m = req.method;
  if (m !== 'GET' && m !== 'HEAD') {
    const origin = req.headers.get('origin');
    if (req.headers.get('x-wc') !== '1' || (origin && origin !== url.origin)) return err(403, 'Blocked request');
  }
  const ck = cookies(req);
  const { s, pin } = await getSettings(db);
  const device = await checkSession(db, ck[DEV_COOKIE], 'device');
  const parent = device ? await checkSession(db, ck[PAR_COOKIE], 'parent') : null;

  if (path === '/ping') return json({ ok: true, v: ASSET_VERSION });
  if (path === '/status' && m === 'GET') return json({ setup: !!pin, device: !!device, parent: !!parent, parentUntil: parent ? parent.until : null, v: ASSET_VERSION });

  if (path === '/setup' && m === 'POST') {
    if (pin) return err(409, 'A PIN is already set');
    const b = await body(req);
    if (!validPin(b.pin)) return err(400, 'PIN must be 4 to 8 digits');
    await putSettingRaw(db, 'pin_hash', await hashPin(b.pin));
    const dev = await newSession(db, 'device', DEVICE_TTL, 0);
    const par = await newSession(db, 'parent', PARENT_REMEMBER, PARENT_IDLE);
    const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    h.append('set-cookie', setCookie(DEV_COOKIE, dev, DEVICE_TTL / 1000));
    h.append('set-cookie', setCookie(PAR_COOKIE, par, PARENT_REMEMBER / 1000));
    return new Response(JSON.stringify({ ok: true }), { headers: h });
  }
  if (path === '/unlock' && m === 'POST') {
    if (!pin) return err(409, 'Set a PIN first');
    const ip = ipKey(req);
    if (await limited(db, ip)) return err(429, 'Too many tries. Wait 15 minutes and try again.');
    const b = await body(req);
    if (!validPin(b.pin) || !(await pinMatches(b.pin, pin))) {
      await run(db, 'INSERT INTO attempts (key, ts) VALUES (?, ?)', ip, Date.now());
      return err(401, 'Wrong PIN');
    }
    await run(db, 'DELETE FROM attempts WHERE key = ?', ip);
    await run(db, 'DELETE FROM sessions WHERE expires_at < ?', Date.now());
    const h = new Headers({ 'content-type': 'application/json', 'cache-control': 'no-store' });
    if (!device) h.append('set-cookie', setCookie(DEV_COOKIE, await newSession(db, 'device', DEVICE_TTL, 0), DEVICE_TTL / 1000));
    const remember = !!b.remember;
    const ttl = remember ? PARENT_REMEMBER : 12 * 3600e3;
    h.append('set-cookie', setCookie(PAR_COOKIE, await newSession(db, 'parent', ttl, remember ? 0 : PARENT_IDLE), ttl / 1000));
    return new Response(JSON.stringify({ ok: true }), { headers: h });
  }
  if (path === '/lock' && m === 'POST') {
    if (ck[PAR_COOKIE]) await run(db, 'DELETE FROM sessions WHERE token_hash = ?', await sha256hex(ck[PAR_COOKIE]));
    return json({ ok: true }, 200, { 'set-cookie': setCookie(PAR_COOKIE, '', 0) });
  }

  // everything below needs a connected screen/phone
  if (!device) return err(401, pin ? 'device' : 'setup');

  if (path === '/state' && m === 'GET') {
    ctx.waitUntil(syncAll(env, { onlyStale: true }).catch(() => {}));
    return json(await buildState(env, !!parent));
  }
  if (path === '/events' && m === 'GET') {
    const from = +url.searchParams.get('from') || Date.now() - 7 * 86400e3, to = +url.searchParams.get('to') || Date.now() + 35 * 86400e3;
    const fromDay = new Date(from - 86400e3).toISOString().slice(0, 10), toDay = new Date(to + 86400e3).toISOString().slice(0, 10);
    const cals = await all(db, 'SELECT id, events FROM calendars WHERE enabled = 1');
    const events = [];
    for (const c of cals) for (const e of J(c.events, [])) {
      if (e.a ? e.e <= fromDay || e.s >= toDay : e.e < from || e.s >= to) continue;
      events.push({ ...e, c: c.id });
    }
    return json({ events, from, to });
  }
  let pm = /^\/photos\/(\d+)(\/thumb)?$/.exec(path);
  if (pm && m === 'GET') {
    const row = await first(db, `SELECT mime, ${pm[2] ? 'thumb' : 'bytes'} AS b FROM photos WHERE id = ?`, +pm[1]);
    if (!row) return err(404, 'Not found');
    return new Response(new Uint8Array(row.b), { headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=31536000, immutable' } });
  }
  if (path === '/complete' && m === 'POST') {
    const b = await body(req);
    const task = await first(db, 'SELECT * FROM tasks WHERE id = ?', +b.task_id);
    const person = await first(db, 'SELECT id, role FROM people WHERE id = ?', +b.person_id);
    if (!task || !person) return err(404, 'Not found');
    const t = taskRow(task);
    const today = dayKey(Date.now(), s.tz);
    const day = b.day && /^\d{4}-\d{2}-\d{2}$/.test(b.day) ? b.day : today;
    if (day > today) return err(400, "Can't complete future days");
    if (day < today && !parent) return err(403, 'parent');
    if (!t.assignees.includes(person.id) || !isDue(t, day)) return err(400, 'Not due that day');
    const existing = await first(db, 'SELECT * FROM completions WHERE task_id = ? AND person_id = ? AND day = ?', t.id, person.id, day);
    const now = Date.now();
    if (b.undo) {
      if (!existing) return json({ ok: true, status: 'todo' });
      if (existing.status === 'done' && s.approval && !parent) return err(403, 'parent');
      await db.batch([
        db.prepare('DELETE FROM ledger WHERE completion_id = ?').bind(existing.id),
        db.prepare('DELETE FROM completions WHERE id = ?').bind(existing.id),
      ]);
      return json({ ok: true, status: 'todo' });
    }
    if (existing) return json({ ok: true, status: existing.status });
    if (t.kind === 'routine' && !parent) {
      const pr = await first(db, 'SELECT done FROM routine_progress WHERE task_id = ? AND person_id = ? AND day = ?', t.id, person.id, day);
      if (J(pr && pr.done, []).length < t.steps.length) return err(400, 'Finish all the steps first');
    }
    const status = s.approval && !parent ? 'pending' : 'done';
    const r = await run(db, 'INSERT INTO completions (task_id, person_id, day, status, stars, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)', t.id, person.id, day, status, t.stars, now, status === 'done' ? now : null);
    const cid = r.meta.last_row_id;
    if (status === 'done' && t.stars) await run(db, "INSERT INTO ledger (person_id, delta, kind, task_id, completion_id, note, created_at) VALUES (?, ?, 'earn', ?, ?, ?, ?)", person.id, t.stars, t.id, cid, t.title, now);
    return json({ ok: true, status, stars: t.stars, completion_id: cid });
  }

  const feat = await featureApi({ req, db, env, path, m, s, parent: !!parent, url });
  if (feat) return feat;

  // ---------- parent only ----------
  if (!parent) return err(403, 'parent');

  if (path === '/settings' && m === 'PUT') {
    const b = await body(req);
    const next = {};
    if ('family_name' in b) next.family_name = cleanText(b.family_name, 40) || DEFAULTS.family_name;
    if ('tz' in b && validTz(b.tz)) next.tz = b.tz;
    if ('theme' in b && ['auto', 'light', 'dark'].includes(b.theme)) next.theme = b.theme;
    for (const k of ['night_start', 'night_end']) if (k in b && /^([01]\d|2[0-3]):[0-5]\d$/.test(b[k])) next[k] = b[k];
    if ('night_dim' in b) next.night_dim = Math.max(0, Math.min(85, Math.round(+b.night_dim || 0)));
    if ('idle_minutes' in b) next.idle_minutes = Math.max(0, Math.min(120, Math.round(+b.idle_minutes || 0)));
    if ('slide_seconds' in b) next.slide_seconds = Math.max(4, Math.min(300, Math.round(+b.slide_seconds || 12)));
    if ('week_start' in b) next.week_start = +b.week_start === 1 ? 1 : 0;
    if ('clock24' in b) next.clock24 = !!b.clock24;
    if ('drift' in b) next.drift = !!b.drift;
    if ('approval' in b) next.approval = !!b.approval;
    if ('default_view' in b && ['month', 'week', 'day', 'agenda'].includes(b.default_view)) next.default_view = b.default_view;
    if ('units' in b && ['F', 'C'].includes(b.units)) next.units = b.units;
    if ('meal_slots' in b) next.meal_slots = cleanMealSlots(b.meal_slots);
    if ('slideshow_albums' in b) next.slideshow_albums = cleanIds(b.slideshow_albums, (await all(db, 'SELECT id FROM albums')).map((a) => a.id));
    if ('weather' in b) {
      const w = b.weather;
      next.weather = w && Number.isFinite(+w.lat) && Number.isFinite(+w.lon) && Math.abs(+w.lat) <= 90 && Math.abs(+w.lon) <= 180
        ? { name: cleanText(w.name, 80), region: cleanText(w.region, 80), country: cleanText(w.country, 60), lat: +(+w.lat).toFixed(4), lon: +(+w.lon).toFixed(4), tz: validTz(w.tz) ? w.tz : null }
        : null;
    }
    for (const [k, v] of Object.entries(next)) await putSetting(db, k, v);
    return json({ ok: true, settings: { ...s, ...next } });
  }
  if (path === '/pin' && m === 'PUT') {
    const b = await body(req);
    if (!(await pinMatches(String(b.current || ''), pin))) return err(401, 'Current PIN is wrong');
    if (!validPin(b.pin)) return err(400, 'New PIN must be 4 to 8 digits');
    await putSettingRaw(db, 'pin_hash', await hashPin(b.pin));
    return json({ ok: true });
  }
  if (path === '/devices/revoke' && m === 'POST') { // sign out every other screen/phone
    const keep = [await sha256hex(ck[DEV_COOKIE]), await sha256hex(ck[PAR_COOKIE] || '')];
    await run(db, 'DELETE FROM sessions WHERE token_hash NOT IN (?, ?)', ...keep);
    return json({ ok: true });
  }

  // people
  if (path === '/people' && m === 'POST') return savePerson(db, null, await body(req));
  pm = /^\/people\/(\d+)$/.exec(path);
  if (pm && m === 'PUT') return savePerson(db, +pm[1], await body(req));
  if (pm && m === 'DELETE') {
    const id = +pm[1];
    await db.batch([
      db.prepare('DELETE FROM people WHERE id = ?').bind(id),
      db.prepare('DELETE FROM completions WHERE person_id = ?').bind(id),
      db.prepare('DELETE FROM ledger WHERE person_id = ?').bind(id),
      db.prepare('DELETE FROM routine_progress WHERE person_id = ?').bind(id),
      db.prepare('UPDATE countdowns SET person_id = NULL WHERE person_id = ?').bind(id),
      db.prepare('UPDATE calendars SET person_id = NULL WHERE person_id = ?').bind(id),
    ]);
    // drop from task/reward assignee lists
    for (const t of await all(db, 'SELECT id, assignees FROM tasks')) { const a = J(t.assignees, []); if (a.includes(id)) await run(db, 'UPDATE tasks SET assignees = ? WHERE id = ?', JSON.stringify(a.filter((x) => x !== id)), t.id); }
    for (const r of await all(db, 'SELECT id, person_ids FROM rewards')) { const a = J(r.person_ids, []); if (a.includes(id)) await run(db, 'UPDATE rewards SET person_ids = ? WHERE id = ?', JSON.stringify(a.filter((x) => x !== id)), r.id); }
    return json({ ok: true });
  }

  // calendars
  if (path === '/calendars' && m === 'POST') {
    const b = await body(req);
    const u = feedUrlOk(b.url);
    if (!u) return err(400, 'Paste an https:// or webcal:// calendar link');
    const name = cleanText(b.name, 40) || 'Calendar';
    const color = COLOR_RE.test(b.color || '') ? b.color : '#5B8DEF';
    const r = await run(db, 'INSERT INTO calendars (name, url, color, person_id, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)', name, u, color, b.person_id ? +b.person_id : null, Date.now());
    const cal = await first(db, 'SELECT * FROM calendars WHERE id = ?', r.meta.last_row_id);
    const result = await syncCalendar(env, cal, s.tz, true);
    return json({ ok: true, id: cal.id, sync: result });
  }
  pm = /^\/calendars\/(\d+)(\/sync)?$/.exec(path);
  if (pm && pm[2] && m === 'POST') {
    const cal = await first(db, 'SELECT * FROM calendars WHERE id = ?', +pm[1]);
    if (!cal) return err(404, 'Not found');
    return json({ ok: true, sync: await syncCalendar(env, cal, s.tz, true) });
  }
  if (pm && !pm[2] && m === 'PUT') {
    const b = await body(req);
    const cal = await first(db, 'SELECT * FROM calendars WHERE id = ?', +pm[1]);
    if (!cal) return err(404, 'Not found');
    const u = b.url ? feedUrlOk(b.url) : cal.url;
    if (!u) return err(400, 'Paste an https:// or webcal:// calendar link');
    await run(db, 'UPDATE calendars SET name = ?, url = ?, color = ?, person_id = ?, enabled = ?, hash = CASE WHEN ? THEN NULL ELSE hash END WHERE id = ?',
      cleanText(b.name, 40) || cal.name, u, COLOR_RE.test(b.color || '') ? b.color : cal.color, b.person_id ? +b.person_id : null, b.enabled === false ? 0 : 1, u !== cal.url ? 1 : 0, cal.id);
    let sync = null;
    if (u !== cal.url) sync = await syncCalendar(env, { ...cal, url: u, hash: null }, s.tz, true);
    return json({ ok: true, sync });
  }
  if (pm && !pm[2] && m === 'DELETE') { await run(db, 'DELETE FROM calendars WHERE id = ?', +pm[1]); return json({ ok: true }); }

  // tasks
  if ((path === '/tasks' && m === 'POST') || ((pm = /^\/tasks\/(\d+)$/.exec(path)) && m === 'PUT')) {
    const b = await body(req);
    const ids = (await all(db, 'SELECT id FROM people')).map((p) => p.id);
    const { task: t, error } = cleanTask(b, ids);
    if (error) return err(400, error);
    const args = [t.title, t.emoji, t.kind, t.stars, t.recur, JSON.stringify(t.days), t.date, JSON.stringify(t.assignees), t.part, b.active === false ? 0 : 1, JSON.stringify(t.steps)];
    if (path === '/tasks') {
      // ids are never reused, so kept history (done completions, ledger) can't attach to a new task
      const r = await run(db, 'INSERT INTO tasks (id, title, emoji, kind, stars, recur, days, date, assignees, part, active, steps, sort, start_day, created_at) VALUES ((SELECT MAX(x) + 1 FROM (SELECT COALESCE(MAX(id), 0) AS x FROM tasks UNION ALL SELECT COALESCE(MAX(task_id), 0) FROM completions UNION ALL SELECT COALESCE(MAX(task_id), 0) FROM ledger)), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', ...args, Math.round(+b.sort || 0), null, Date.now());
      return json({ ok: true, id: r.meta.last_row_id });
    }
    await run(db, 'UPDATE tasks SET title = ?, emoji = ?, kind = ?, stars = ?, recur = ?, days = ?, date = ?, assignees = ?, part = ?, active = ?, steps = ?, sort = ? WHERE id = ?', ...args, Math.round(+b.sort || 0), +pm[1]);
    return json({ ok: true });
  }
  pm = /^\/tasks\/(\d+)$/.exec(path);
  if (pm && m === 'DELETE') { // history (ledger) is kept; open completions go
    await db.batch([db.prepare('DELETE FROM tasks WHERE id = ?').bind(+pm[1]), db.prepare('DELETE FROM routine_progress WHERE task_id = ?').bind(+pm[1]), db.prepare("DELETE FROM completions WHERE task_id = ? AND status = 'pending'").bind(+pm[1])]);
    return json({ ok: true });
  }
  pm = /^\/completions\/(\d+)\/(approve|reject)$/.exec(path);
  if (pm && m === 'POST') {
    const c = await first(db, 'SELECT * FROM completions WHERE id = ?', +pm[1]);
    if (!c) return err(404, 'Not found');
    if (pm[2] === 'reject') { await run(db, 'DELETE FROM completions WHERE id = ?', c.id); return json({ ok: true }); }
    if (c.status === 'done') return json({ ok: true });
    const t = await first(db, 'SELECT title FROM tasks WHERE id = ?', c.task_id);
    const now = Date.now();
    const stmts = [db.prepare("UPDATE completions SET status = 'done', decided_at = ? WHERE id = ?").bind(now, c.id)];
    if (c.stars) stmts.push(db.prepare("INSERT INTO ledger (person_id, delta, kind, task_id, completion_id, note, created_at) VALUES (?, ?, 'earn', ?, ?, ?, ?)").bind(c.person_id, c.stars, c.task_id, c.id, t ? t.title : 'Task', now));
    await db.batch(stmts);
    return json({ ok: true });
  }
  if (path === '/stars/adjust' && m === 'POST') {
    const b = await body(req);
    const delta = Math.round(+b.delta || 0);
    if (!delta || Math.abs(delta) > 100) return err(400, 'Pick a change between -100 and 100');
    const p = await first(db, 'SELECT id FROM people WHERE id = ?', +b.person_id);
    if (!p) return err(404, 'Not found');
    await run(db, "INSERT INTO ledger (person_id, delta, kind, note, created_at) VALUES (?, ?, 'adjust', ?, ?)", p.id, delta, cleanText(b.note, 80) || (delta > 0 ? 'Bonus stars' : 'Stars removed'), Date.now());
    return json({ ok: true });
  }

  // rewards
  if ((path === '/rewards' && m === 'POST') || ((pm = /^\/rewards\/(\d+)$/.exec(path)) && m === 'PUT')) {
    const b = await body(req);
    const pids = (await all(db, 'SELECT id FROM people')).map((p) => p.id), tids = (await all(db, 'SELECT id FROM tasks')).map((t) => t.id);
    const { reward: r, error } = cleanReward(b, pids, tids);
    if (error) return err(400, error);
    const args = [r.name, r.description, r.emoji, r.cost, r.scope, JSON.stringify(r.person_ids), JSON.stringify(r.task_ids), b.active === false ? 0 : 1];
    if (path === '/rewards') { const x = await run(db, 'INSERT INTO rewards (id, name, description, emoji, cost, scope, person_ids, task_ids, active, sort, created_at) VALUES ((SELECT MAX(x) + 1 FROM (SELECT COALESCE(MAX(id), 0) AS x FROM rewards UNION ALL SELECT COALESCE(MAX(reward_id), 0) FROM redemptions UNION ALL SELECT COALESCE(MAX(reward_id), 0) FROM ledger)), ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)', ...args, Date.now()); return json({ ok: true, id: x.meta.last_row_id }); }
    await run(db, 'UPDATE rewards SET name = ?, description = ?, emoji = ?, cost = ?, scope = ?, person_ids = ?, task_ids = ?, active = ? WHERE id = ?', ...args, +pm[1]);
    return json({ ok: true });
  }
  pm = /^\/rewards\/(\d+)$/.exec(path);
  if (pm && m === 'DELETE') { await run(db, 'DELETE FROM rewards WHERE id = ?', +pm[1]); return json({ ok: true }); }
  pm = /^\/rewards\/(\d+)\/redeem$/.exec(path);
  if (pm && m === 'POST') {
    const b = await body(req);
    const core = await loadCore(db);
    const reward = core.rewards.find((r) => r.id === +pm[1]);
    if (!reward || !reward.active) return err(404, 'Not found');
    const kids = core.people.filter((p) => p.role === 'kid');
    const personId = reward.scope === 'family' ? null : +b.person_id;
    const chk = checkRedeem(reward, core.ledger, core.redemptions, kids, personId);
    if (!chk.ok) return err(400, chk.error);
    const now = Date.now();
    const stmts = [db.prepare('INSERT INTO redemptions (reward_id, reward_name, person_id, cost, created_at) VALUES (?, ?, ?, ?, ?)').bind(reward.id, reward.name, personId, reward.cost, now)];
    if (chk.ledgerDelta) stmts.push(db.prepare("INSERT INTO ledger (person_id, delta, kind, reward_id, note, created_at) VALUES (?, ?, 'redeem', ?, ?, ?)").bind(personId, chk.ledgerDelta, reward.id, reward.name, now));
    await db.batch(stmts);
    return json({ ok: true });
  }

  // photos
  if (path === '/photos' && m === 'POST') {
    const n = await first(db, 'SELECT COUNT(*) AS n FROM photos');
    if (n.n >= MAX_PHOTOS) return err(400, `Photo limit reached (${MAX_PHOTOS}). Delete some first.`);
    const form = await req.formData();
    const photo = form.get('photo'), thumb = form.get('thumb');
    if (!photo || !thumb || typeof photo === 'string' || typeof thumb === 'string') return err(400, 'Missing photo');
    if (!/^image\/(jpeg|webp|png)$/.test(photo.type)) return err(400, 'Use a JPEG, PNG or WebP image');
    if (photo.size > MAX_PHOTO || thumb.size > MAX_THUMB) return err(413, 'Photo is too large after resizing');
    const bytes = await photo.arrayBuffer(), tb = await thumb.arrayBuffer();
    const r = await run(db, 'INSERT INTO photos (mime, w, h, size, bytes, thumb, caption, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', photo.type, +form.get('w') || null, +form.get('h') || null, bytes.byteLength, bytes, tb, cleanText(form.get('caption'), 80), Date.now());
    const aid = +form.get('album_id');
    if (aid && (await first(db, 'SELECT id FROM albums WHERE id = ?', aid))) await run(db, 'INSERT OR IGNORE INTO photo_albums (photo_id, album_id) VALUES (?, ?)', r.meta.last_row_id, aid);
    return json({ ok: true, id: r.meta.last_row_id });
  }
  pm = /^\/photos\/(\d+)$/.exec(path);
  if (pm && m === 'DELETE') { await db.batch([db.prepare('DELETE FROM photos WHERE id = ?').bind(+pm[1]), db.prepare('DELETE FROM photo_albums WHERE photo_id = ?').bind(+pm[1])]); return json({ ok: true }); }

  if (path === '/sync' && m === 'POST') return json({ ok: true, results: await syncAll(env, { force: true }) });
  return err(404, 'Not found');
}
const putSettingRaw = (db, key, value) => run(db, 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);

async function savePerson(db, id, b) {
  const name = cleanText(b.name, 30);
  if (!name) return err(400, 'Name is required');
  const color = COLOR_RE.test(b.color || '') ? b.color : '#F4A261';
  const emoji = cleanEmoji(b.emoji || '🙂');
  const role = b.role === 'parent' ? 'parent' : 'kid';
  const sort = Math.round(+b.sort || 0);
  if (id == null) {
    const n = await first(db, 'SELECT COUNT(*) AS n FROM people');
    if (n.n >= 12) return err(400, 'That is a lot of people! Limit is 12.');
    const r = await run(db, 'INSERT INTO people (name, color, emoji, role, sort, created_at) VALUES (?, ?, ?, ?, ?, ?)', name, color, emoji, role, sort, Date.now());
    return json({ ok: true, id: r.meta.last_row_id });
  }
  await run(db, 'UPDATE people SET name = ?, color = ?, emoji = ?, role = ?, sort = ? WHERE id = ?', name, color, emoji, role, sort, id);
  return json({ ok: true });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    try {
      if (url.pathname.startsWith('/api/')) return withSec(await api(req, env, ctx, url));
      let name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      let res = serveAsset(name, req);
      if (!res && !name.includes('.')) res = serveAsset('index.html', req);
      return withSec(res || new Response('Not found', { status: 404 }));
    } catch (e) {
      return withSec(err(e.status || 500, e.status ? e.message : 'Something went wrong'));
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(syncAll(env));
  },
};
