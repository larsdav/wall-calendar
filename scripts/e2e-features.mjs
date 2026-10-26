// Feature checks + screenshots for the post-v1 features, run against a live or local deployment.
// Usage: node scripts/e2e-features.mjs <baseUrl> <outPrefix> --steps 1,2,3,4
// Needs a test deployment whose PIN is E2E_PIN (default 2468); a fresh one is set up and seeded. Never point it at the family's real screen.
import { chromium } from 'playwright-core';
const [base, out = '/tmp/wcf', ...flags] = process.argv.slice(2);
const steps = (flags[flags.indexOf('--steps') + 1] || '1').split(',').map(Number);
const PIN = process.env.E2E_PIN || '2468';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: 'America/Chicago' });
const page = await ctx.newPage();
const errors = [], results = [];
const watch = (p, tag) => { p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource.*(401|403)/.test(m.text())) errors.push(`${tag} console: ${m.text()}`); }); };
watch(page, 'wall');
const check = (name, ok, detail = '') => { results.push([ok ? 'PASS' : 'FAIL', name, detail]); console.log(ok ? 'PASS' : 'FAIL', name, detail); };
const typePin = async (p, pin = PIN) => { for (const d of pin) await p.click(`.pin .pad button[aria-label="${d}"]`); await p.click('.pin .pad button[aria-label="ok"]'); };
const api = (p, method, path, body) => p.evaluate(async ([method, path, body]) => {
  const r = await fetch('/api' + path, { method, headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(path + ': ' + r.status + ' ' + j.error); return j;
}, [method, path, body]);
const state = (p = page) => api(p, 'GET', '/state');
const lockState = async (p, locked) => {
  const st = await p.evaluate(() => fetch('/api/status').then((r) => r.json()));
  if (locked && st.parent) await p.evaluate(() => fetch('/api/lock', { method: 'POST', headers: { 'x-wc': '1' } }));
  if (!locked && !st.parent) { const r = await p.evaluate((pin) => fetch('/api/unlock', { method: 'POST', headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: JSON.stringify({ pin }) }).then((r) => r.status), PIN); if (r !== 200) throw new Error('unlock ' + r); }
};
const open = async (p, hash, sel) => { await p.goto(base + '/#' + hash); await p.reload(); await p.waitForSelector(sel, { timeout: 15000 }); await p.waitForTimeout(700); };
const shot = (p, name, full) => p.screenshot({ path: `${out}-${name}.png`, fullPage: !!full });

// ---------- connect ----------
await page.goto(base);
await page.waitForSelector('.rail, button:has-text("Enter PIN"), button:has-text("Set parent PIN")');
if (await page.isVisible('text=Set parent PIN')) {
  await page.click('text=Set parent PIN'); await typePin(page); await page.waitForTimeout(300); await typePin(page);
  await page.waitForSelector('.settings', { timeout: 15000 });
} else if (await page.isVisible('text=Enter PIN')) { await page.click('text=Enter PIN'); await typePin(page); await page.waitForSelector('.rail'); }
await lockState(page, false);
let st = await state();
if (!st.people.length) {
  for (const [i, [name, color, emoji, role]] of [['David', '#5B8DEF', '🧔', 'parent'], ['Mom', '#D16BA5', '👩', 'parent'], ['Emma', '#F4A261', '🦄', 'kid'], ['Leo', '#2A9D8F', '🦖', 'kid']].entries()) await api(page, 'POST', '/people', { name, color, emoji, role, sort: i });
  st = await state();
}
const kids = st.people.filter((p) => p.role === 'kid');
const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', storageState: await ctx.storageState() });
const phone = await phoneCtx.newPage(); watch(phone, 'phone');
const today = st.today;

// ---------- step 1: lists + meals ----------
if (steps.includes(1)) {
  st = await state();
  // clean slate for repeatable runs: remove test items and meals
  for (const it of st.list_items) await api(page, 'DELETE', `/items/${it.id}`);
  for (const ml of st.meals) await api(page, 'PUT', '/meals', { day: ml.day, slot: ml.slot, title: '' });
  await api(page, 'PUT', '/settings', { meal_slots: ['dinner'] });
  st = await state();
  check('default lists exist after migration', st.lists.some((l) => l.name === 'Groceries' && l.kind === 'grocery') && st.lists.some((l) => l.kind === 'todo'), st.lists.map((l) => l.name).join(', '));
  const groc = st.lists.find((l) => l.kind === 'grocery'), todo = st.lists.find((l) => l.kind === 'todo');
  await lockState(page, true); // kids / locked wall can still use lists
  await open(page, 'lists', '.listcard');
  await page.fill(`input[data-list="${groc.id}"]`, 'Milk, Eggs');
  await page.press(`input[data-list="${groc.id}"]`, 'Enter');
  await page.waitForSelector(`.listcard:has(input[data-list="${groc.id}"]) .li:has-text("Eggs")`, { timeout: 8000 });
  check('add two items with one entry (comma split), no PIN', true);
  check('input keeps focus after adding', await page.evaluate((id) => document.activeElement && document.activeElement.dataset.list === String(id), groc.id));
  await page.click(`.listcard:has(input[data-list="${groc.id}"]) .sugg button:has-text("Bread")`);
  await page.waitForSelector(`.listcard:has(input[data-list="${groc.id}"]) .li:has-text("Bread")`, { timeout: 8000 });
  check('tap a suggestion chip adds it', true);
  await page.fill(`input[data-list="${todo.id}"]`, 'Call the plumber');
  await page.click(`.listcard:has(input[data-list="${todo.id}"]) .addrow button`);
  await page.waitForSelector('.li:has-text("Call the plumber")', { timeout: 8000 });
  await page.click(`.listcard:has(input[data-list="${groc.id}"]) .li:has-text("Milk") .lck`);
  await page.waitForTimeout(1500);
  check('tick an item marks it done', await page.isVisible(`.listcard:has(input[data-list="${groc.id}"]) .li.done:has-text("Milk")`));
  // phone sees the same list and can add
  await open(phone, 'lists', '.listcard');
  check('phone shows the wall’s items', await phone.isVisible('.li:has-text("Eggs")'));
  await phone.fill(`input[data-list="${groc.id}"]`, 'Apples');
  await phone.click('.addrow button');
  await phone.waitForSelector('.li:has-text("Apples")', { timeout: 8000 });
  await shot(phone, 'lists-390', true);
  await open(page, 'lists', '.listcard');
  check('wall sees the phone’s item', await page.isVisible('.li:has-text("Apples")'));
  await shot(page, 'lists-1920');
  await page.click(`.listcard:has(input[data-list="${groc.id}"]) button:has-text("Clear 1 checked")`);
  check('clear checked removes done items', await page.waitForSelector('.li:has-text("Milk")', { state: 'detached', timeout: 8000 }).then(() => true, () => false));
  await page.waitForTimeout(1500);
  check('cleared items stay gone after refresh', !(await state()).list_items.some((i) => i.text === 'Milk'));
  await page.click('.li:has-text("Call the plumber") .lx'); await page.waitForTimeout(1200);
  check('delete a single item', !(await page.isVisible('.li:has-text("Call the plumber")')));
  // locked wall: new list needs PIN
  await page.click('button:has-text("+ New list")'); await page.waitForTimeout(500);
  check('creating a list asks for the parent PIN when locked', await page.isVisible('.pin .pad'));
  await page.keyboard.press('Escape');
  // meals: locked tap on an empty meal asks for PIN; then edit as parent
  await open(page, 'meals', '.meals-grid');
  await page.click('.mday.today .meal.empty'); await page.waitForTimeout(500);
  check('editing a meal asks for the parent PIN when locked', await page.isVisible('.pin .pad'));
  await typePin(page); await page.waitForSelector('.sheet h2:has-text("Dinner")');
  await page.fill('.sheet input[placeholder^="Tacos"]', 'Taco night');
  await page.click('.sheet .emojis button:has-text("🌮")');
  await page.fill('.sheet textarea', 'Ground beef\nTortillas, Cheese\nEggs');
  await page.click('.sheet .btn.primary:has-text("Save")');
  await page.waitForSelector('.mday.today .meal:has-text("Taco night")', { timeout: 8000 });
  check('meal saved and shown on today', true);
  const tomorrow = new Date(Date.parse(today + 'T12:00:00Z') + 86400e3).toISOString().slice(0, 10);
  await api(page, 'PUT', '/meals', { day: tomorrow, slot: 'dinner', title: 'Spaghetti', emoji: '🍝', ingredients: ['Pasta', 'Sauce', 'Ground beef'] });
  await page.click('.meal-tools .chips button:has-text("Breakfast")'); await page.waitForTimeout(1500);
  check('breakfast row can be turned on', (await page.$$('.mday.today .meal')).length === 2);
  await api(page, 'PUT', '/meals', { day: today, slot: 'breakfast', title: 'Pancakes', emoji: '🥞', ingredients: ['Pancake mix', 'Syrup'] });
  await open(page, 'meals', '.meals-grid');
  await shot(page, 'meals-1920');
  // send one meal's ingredients to Groceries (Eggs is already there)
  await page.click('.mday.today .meal:has-text("Taco night")');
  await page.click('.sheet button:has-text("Add ingredients to list")');
  await page.click('.sheet .setup-list button:has-text("Groceries")');
  await page.waitForTimeout(1800);
  st = await state();
  const open1 = st.list_items.filter((i) => i.list_id === groc.id && !i.done).map((i) => i.text);
  check('meal ingredients added to the list without duplicates', ['Ground beef', 'Tortillas', 'Cheese'].every((x) => open1.includes(x)) && open1.filter((x) => x === 'Eggs').length === 1, open1.join(', '));
  const wk = await api(page, 'POST', '/meals/to-list', { list_id: groc.id, days: [today, tomorrow] });
  check('whole-week send (breakfast+dinner, 2 days) adds only missing items', wk.added === 4 && wk.skipped === 5, JSON.stringify(wk));
  await lockState(page, true);
  await open(page, 'home', '.mini-meals');
  check('home shows tonight’s meal', await page.isVisible('.mini-meals:has-text("Taco night")'));
  check('home shows the grocery widget with items', await page.isVisible('.mini-list .li:has-text("Tortillas")'));
  await shot(page, 'home-1920');
  await page.click('.mini-list .li:has-text("Tortillas") .lck'); await page.waitForTimeout(1500);
  st = await state();
  check('tick from the home widget', st.list_items.some((i) => i.text === 'Tortillas' && i.done));
  await open(phone, 'meals', '.meals-grid'); await shot(phone, 'meals-390', true);
  await open(phone, 'home', '.mini-meals'); await shot(phone, 'home-390', true);
  await phone.click('.tabbar button:has-text("More")'); await phone.waitForTimeout(400);
  check('phone More menu lists the other pages', await phone.isVisible('.more-grid button:has-text("Meals")') && await phone.isVisible('.more-grid button:has-text("Settings")'));
  await shot(phone, 'more-390');
  await phone.keyboard.press('Escape');
  const overflow = await page.evaluate(() => { const r = document.querySelector('.rail'); return r.scrollHeight <= r.clientHeight + 1; });
  check('wall nav rail fits at 1080p', overflow);
}

const extra = process.env.E2E_EXTRA ? await import(process.env.E2E_EXTRA) : null;
if (extra) await extra.default({ page, phone, api, state, check, open, shot, lockState, typePin, steps, today, kids, base });

console.log('errors:', errors.length ? errors.join('\n') : 'none');
const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`SUMMARY ${results.length - fails.length}/${results.length} passed${errors.length ? `, ${errors.length} browser errors` : ''}`);
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
