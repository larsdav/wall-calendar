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
if (!st.tasks.some((t) => t.kind !== 'routine')) await api(page, 'POST', '/tasks', { title: 'Feed the dog', emoji: '🐕', kind: 'chore', stars: 2, recur: 'daily', assignees: kids.map((k) => k.id) });
if (!st.rewards.length) await api(page, 'POST', '/rewards', { name: 'Ice cream trip', emoji: '🍦', cost: 10, scope: 'kid', person_ids: kids.map((k) => k.id) });
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

// ---------- step 2: routines + kid pages ----------
if (steps.includes(2)) {
  await lockState(page, false);
  st = await state();
  for (const t of st.tasks.filter((t) => t.kind === 'routine')) await api(page, 'DELETE', `/tasks/${t.id}`);
  await api(page, 'PUT', '/settings', { approval: false });
  const [emma, leo] = kids;
  await open(page, 'chores', '.chores-grid');
  await page.click('button:has-text("+ Add routine")');
  await page.waitForSelector('.sheet h2:has-text("New routine")');
  check('new routine form starts from the morning example', (await page.inputValue('.sheet textarea')).includes('Make bed'));
  await page.click('.sheet button:has-text("Bedtime example")');
  check('bedtime example fills steps and name', (await page.inputValue('.sheet textarea')).includes('Pajamas') && (await page.inputValue('.sheet input[type=text]')) === 'Bedtime routine');
  await page.click(`.sheet .field:has(label:text-is("Who")) .chips button:has-text("${leo.name}")`); // leave only Emma (+ parents unticked by default)
  await page.click('.sheet .btn.primary:has-text("Save")');
  await page.waitForSelector('.sheet', { state: 'detached', timeout: 10000 });
  st = await state();
  const bed = st.tasks.find((t) => t.kind === 'routine' && t.title === 'Bedtime routine');
  check('routine saved with 6 steps for Emma only', bed && bed.steps.length === 6 && bed.assignees.join() === String(emma.id) && bed.steps[0].e === '🧸', bed ? JSON.stringify(bed.steps[0]) + ' ' + bed.assignees : 'missing');
  const before = st.balances[emma.id] || 0;
  await lockState(page, true);
  await open(page, 'home', '.kidcard');
  check('kid card shows routine progress', await page.isVisible(`.kidcard .task.rtask[data-task="${bed.id}"]:has-text("0 of 6 steps")`));
  await page.click(`.kidcard .task.rtask[data-task="${bed.id}"]`);
  await page.waitForSelector('.routine-sheet .step');
  const stepsEls = await page.$$('.routine-sheet .step');
  for (let i = 0; i < 3; i++) { await page.click(`.routine-sheet .step >> nth=${i}`); await page.waitForTimeout(350); }
  await page.waitForTimeout(1200);
  await shot(page, 'routine-1920');
  const nErr = errors.length;
  const early = await page.evaluate(async (b) => (await fetch('/api/complete', { method: 'POST', headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: JSON.stringify(b) })).status, { task_id: bed.id, person_id: emma.id });
  await page.waitForTimeout(300); errors.splice(nErr); // the expected 400 above is logged by Chrome
  check('kid cannot finish a routine with steps left (server)', early === 400, early);
  for (let i = 3; i < stepsEls.length; i++) { await page.click(`.routine-sheet .step >> nth=${i}`); await page.waitForTimeout(350); }
  await page.waitForTimeout(2500);
  st = await state();
  check('finishing every step awards the stars once', (st.balances[emma.id] || 0) === before + bed.stars && st.completions.some((c) => c.task_id === bed.id && c.status === 'done'), `${before} -> ${st.balances[emma.id]}`);
  check('routine sheet shows All done', await page.isVisible('.routine-sheet .alldone:has-text("All done")'));
  await page.click('.routine-sheet .step >> nth=5');
  await page.click('.sheet .btn.primary:has-text("Undo")');
  await page.waitForTimeout(2500);
  st = await state();
  check('unticking a step on a finished routine takes the stars back', (st.balances[emma.id] || 0) === before && !st.completions.some((c) => c.task_id === bed.id) && st.routine_progress.find((r) => r.task_id === bed.id).done.length === 5);
  await page.click('.routine-sheet .step >> nth=5'); await page.waitForTimeout(2500);
  await page.keyboard.press('Escape');
  // kid page
  await open(page, 'home', '.kidcard');
  await page.click(`.kidcard .kidlink[aria-label="Open ${emma.name}'s page"]`);
  await page.waitForSelector('.kidview .routine');
  check('tapping a kid opens their page', (await page.evaluate(() => location.hash)) === `#kid/${emma.id}`);
  check('kid page shows their routine done, chores and rewards', await page.isVisible('.kidview .routine .alldone') && await page.isVisible('.kidview .kidcard .task') && await page.isVisible('.kidview .mini-rewards'));
  st = await state();
  check('kid page star count matches balance', (await page.textContent('.kv-head .stars > span:last-child')) === String(st.balances[emma.id] || 0));
  await shot(page, 'kid-1920');
  await page.click(`.kidswitch[aria-label="Switch to ${leo.name}"]`);
  await page.waitForSelector('.kidview .kv-head h2:has-text("' + leo.name + '")');
  check('switch between kids', !(await page.isVisible('.kidview .routine')) && await page.isVisible('.kidview .empty-note:has-text("No routines today")'));
  // approval flow on a routine
  await lockState(page, false);
  await api(page, 'PUT', '/settings', { approval: true });
  const qr = await api(page, 'POST', '/tasks', { title: 'Quick tidy', emoji: '🧹', kind: 'routine', stars: 2, recur: 'daily', assignees: [leo.id], steps: '🧸 Toys away\n👟 Shoes away' });
  await lockState(page, true);
  const leoBefore = (await state()).balances[leo.id] || 0;
  await open(page, 'kid/' + leo.id, '.kidview .routine');
  await page.click('.kidview .routine .step >> nth=0'); await page.waitForTimeout(400);
  await page.click('.kidview .routine .step >> nth=1'); await page.waitForTimeout(2500);
  st = await state();
  check('with approval on, a finished routine waits for a parent', st.completions.some((c) => c.task_id === qr.id && c.status === 'pending') && (st.balances[leo.id] || 0) === leoBefore && await page.isVisible('.kidview .routine .alldone:has-text("Waiting")'));
  await open(page, 'chores', '.chores-grid');
  await page.click('.hist .hr:has-text("Quick tidy") button:has-text("Approve")');
  await page.waitForSelector('.pin .pad'); await typePin(page); await page.waitForTimeout(2500);
  st = await state();
  check('parent approves the routine and stars are added', (st.balances[leo.id] || 0) === leoBefore + 2, `${leoBefore} -> ${st.balances[leo.id]}`);
  await api(page, 'PUT', '/settings', { approval: false });
  await lockState(page, true);
  await open(phone, 'kid/' + emma.id, '.kidview .routine'); await shot(phone, 'kid-390', true);
  await open(phone, 'chores', '.kidcard');
  await phone.click(`.kidcard .task.rtask[data-task="${bed.id}"]`); await phone.waitForSelector('.routine-sheet .step'); await phone.waitForTimeout(700); await shot(phone, 'routine-390');
  await phone.keyboard.press('Escape');
  await open(page, 'chores', '.chores-grid'); await shot(page, 'chores-1920');
}

// ---------- step 3: countdowns, calendar person filter, photo albums ----------
if (steps.includes(3)) {
  await lockState(page, false);
  st = await state();
  const [emma] = kids, mom = st.people.find((p) => p.name === 'Mom') || st.people.find((p) => p.role === 'parent');
  for (const c of st.countdowns) await api(page, 'DELETE', `/countdowns/${c.id}`);
  for (const a of st.albums) await api(page, 'DELETE', `/albums/${a.id}`);
  await api(page, 'PUT', '/settings', { slideshow_albums: [] });
  const addDays = (n) => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  // countdowns
  await open(page, 'home', '.mini-cd');
  await page.click('.mini-cd button:has-text("+ Add")');
  await page.fill('.sheet input[placeholder^="Disney"]', 'Disney trip');
  await page.fill('.sheet input[type=date]', addDays(55));
  await page.click('.sheet .emojis button:has-text("✈️")');
  await page.click('.sheet .btn.primary:has-text("Save")');
  await page.waitForSelector('.mini-cd .cd:has-text("Disney trip")', { timeout: 8000 });
  check('countdown added from the wall shows days left', (await page.textContent('.mini-cd .cd:has-text("Disney trip") .cdn')).startsWith('55'));
  const bday = addDays(1).replace(/^\d{4}/, '2018');
  await api(page, 'POST', '/countdowns', { title: `${emma.name}'s birthday`, emoji: '🎂', date: bday, yearly: true, person_id: emma.id });
  await api(page, 'POST', '/countdowns', { title: 'Pumpkin carving', emoji: '🎃', date: today });
  await api(page, 'POST', '/countdowns', { title: 'Last summer trip', emoji: '🏖️', date: addDays(-30) });
  await lockState(page, true);
  await open(page, 'home', '.mini-cd .cd');
  const rows = await page.$$eval('.mini-cd .cd', (els) => els.map((e) => e.querySelector('.cdt').firstChild.textContent + '|' + e.querySelector('.cdn').textContent));
  check('countdowns ordered soonest first, yearly birthday rolls forward, past ones hidden', rows.join(',') === `Pumpkin carving|Today!,${emma.name}'s birthday|Tomorrow,Disney trip|55days`, rows.join(','));
  await shot(page, 'home-1920');
  await page.click('.mini-cd .cd:has-text("Disney trip")'); await page.waitForTimeout(500);
  check('editing a countdown asks for the PIN when locked', await page.isVisible('.pin .pad'));
  await page.keyboard.press('Escape');
  // calendar person filter: two calendars, one assigned to Mom, one to Emma
  await lockState(page, false);
  st = await state();
  const HOL = 'https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics';
  let c1 = st.calendars.find((c) => c.name === 'US Holidays');
  if (!c1) c1 = { id: (await api(page, 'POST', '/calendars', { name: 'US Holidays', url: HOL, color: '#E76F51' })).id };
  let c2 = st.calendars.find((c) => c.name === 'School (test)');
  if (!c2) c2 = { id: (await api(page, 'POST', '/calendars', { name: 'School (test)', url: HOL + '?copy=2', color: '#2A9D8F', person_id: emma.id })).id };
  await api(page, 'PUT', `/calendars/${c1.id}`, { name: 'US Holidays', color: '#E76F51', person_id: mom.id });
  await api(page, 'PUT', `/calendars/${c2.id}`, { name: 'School (test)', color: '#2A9D8F', person_id: emma.id });
  await page.evaluate(() => localStorage.removeItem('wc.calPerson'));
  await open(page, 'calendar', '.pfilter');
  await page.click('.seg button:has-text("Month")'); await page.waitForTimeout(1500);
  const count = () => page.$$eval('.calbody .ev, .calbody .chip, .calbody [data-ev]', (els) => els.length);
  const all = await count();
  await page.click(`.pfilter button:has-text("${mom.name}")`); await page.waitForTimeout(600);
  const momN = await count();
  check('person filter narrows the calendar to that person', all > 0 && momN > 0 && momN < all, `${all} -> ${momN}`);
  await shot(page, 'calendar-filter-1920');
  await page.reload(); await page.waitForSelector('.pfilter'); await page.click('.seg button:has-text("Month")'); await page.waitForTimeout(1500);
  check('person filter is remembered on this screen', await page.isVisible(`.pfilter button.on:has-text("${mom.name}")`));
  await page.click('.pfilter button:has-text("Everyone")'); await page.waitForTimeout(600);
  check('Everyone shows all again', (await count()) === all);
  await open(phone, 'calendar', '.pfilter'); await shot(phone, 'calendar-390');
  // albums
  await open(page, 'photos', '.albumbar');
  await page.click('.albumbar button:has-text("+ New album")');
  await page.fill('.sheet input[placeholder^="Summer"]', 'Beach 2026');
  await page.click('.sheet .emojis button:has-text("🏖️")');
  await page.click('.sheet .btn.primary:has-text("Save")');
  await page.waitForSelector('.section-title:has-text("Beach 2026 (0)")', { timeout: 8000 });
  check('new album opens empty', true);
  await page.setInputFiles('#view input[type=file]', ['/tmp/e2e-photo0.jpg', '/tmp/e2e-photo1.jpg']);
  await page.waitForSelector('.section-title:has-text("Beach 2026 (2)")', { timeout: 30000 });
  check('photos uploaded inside an album land in it', true);
  await api(page, 'POST', '/albums', { name: 'Winter', emoji: '❄️' });
  await page.reload(); await page.waitForSelector('.albumbar');
  await page.click('.albumbar button:has-text("All photos")'); await page.waitForTimeout(800);
  st = await state();
  if (!st.photos.some((p) => !st.photo_albums.some((r) => r[0] === p.id))) {
    await page.setInputFiles('#view input[type=file]', ['/tmp/e2e-photo2.jpg']);
    await page.waitForFunction((n) => document.querySelectorAll('.photos-grid .ph').length > n, st.photos.length, { timeout: 30000 });
    st = await state();
  }
  const loose = st.photos.find((p) => !st.photo_albums.some((r) => r[0] === p.id));
  if (loose) {
    await page.click(`.ph:has(img[src="/api/photos/${loose.id}/thumb"]) button[aria-label="Albums for this photo"]`);
    await page.click('.sheet .chips button:has-text("Winter")');
    await page.click('.sheet .btn.primary:has-text("Save")'); await page.waitForTimeout(1500);
    st = await state();
    const win = st.albums.find((a) => a.name === 'Winter');
    check('tag an existing photo into an album', st.photo_albums.some((r) => r[0] === loose.id && r[1] === win.id));
  } else check('tag an existing photo into an album (needs an untagged photo)', false);
  await shot(page, 'photos-1920');
  const beach = st.albums.find((a) => a.name === 'Beach 2026');
  await page.click('.slidepick button:has-text("Beach 2026")'); await page.waitForTimeout(1500);
  st = await state();
  check('slideshow limited to chosen albums (setting saved)', JSON.stringify(st.settings.slideshow_albums) === JSON.stringify([beach.id]));
  // slideshow only cycles Beach photos
  const beachIds = st.photo_albums.filter((r) => r[1] === beach.id).map((r) => r[0]);
  await lockState(page, false);
  await api(page, 'PUT', '/settings', { slide_seconds: 4, idle_minutes: 1 });
  await page.reload(); await page.waitForSelector('.rail');
  await page.evaluate(() => { window.__seen = new Set(); new MutationObserver(() => document.querySelectorAll('#slideshow img').forEach((i) => i.src && window.__seen.add(i.getAttribute('src')))).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['src'] }); });
  await page.waitForSelector('#slideshow:not([hidden])', { timeout: 90000 });
  await page.waitForTimeout(9500);
  const seen = await page.evaluate(() => [...window.__seen].map((s) => +s.split('/').pop()));
  check('idle slideshow shows only the chosen album', seen.length > 0 && seen.every((id) => beachIds.includes(id)), `seen ${[...new Set(seen)]} beach ${beachIds}`);
  await shot(page, 'slideshow-1920');
  await page.mouse.click(500, 500); await page.waitForTimeout(500);
  await api(page, 'PUT', '/settings', { slide_seconds: 12, idle_minutes: 5 });
  await open(phone, 'photos', '.albumbar'); await shot(phone, 'photos-390', true);
  await open(phone, 'home', '.mini-cd'); await shot(phone, 'home-390', true);
}

// ---------- step 4: local family calendar + phone feed ----------
if (steps.includes(4)) {
  await lockState(page, false);
  for (const e of (await api(page, 'GET', '/family-events')).events) await api(page, 'DELETE', `/family-events/${e.id}`);
  st = await state();
  const [emma] = kids, mom = st.people.find((p) => p.name === 'Mom') || st.people.find((p) => p.role === 'parent');
  const addDays = (n) => new Date(Date.parse(today + 'T12:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
  const ev = (sel, txt) => page.locator(`.calbody :is(.ev, .chip):has-text("${txt}")`);
  await lockState(page, true);
  await page.evaluate(() => localStorage.removeItem('wc.calPerson'));
  await open(page, 'calendar', '.calbar .addev');
  await page.click('.calbar .addev'); await page.waitForTimeout(400);
  check('+ Event asks for the PIN when locked', await page.isVisible('.pin .pad'));
  await typePin(page);
  await page.waitForSelector('.evform', { timeout: 8000 });
  await page.fill('.evform input[placeholder^="Soccer"]', 'Soccer practice');
  await page.fill('.evform input[type=date] >> nth=0', addDays(1));
  await page.fill('.evform input[type=time] >> nth=0', '17:30');
  await page.fill('.evform input[type=time] >> nth=1', '18:30');
  await page.click(`.evform .chips button:has-text("${emma.name}")`);
  await page.click('.evform .chips button:has-text("Every week")');
  await page.click('.sheet .btn.primary:has-text("Save")');
  await page.click('.seg button:has-text("Week")');
  await page.waitForSelector('.calbody :is(.ev, .chip):has-text("Soccer practice")', { timeout: 10000 });
  check('event created on the wall appears in the week view', true);
  const col = await ev(0, 'Soccer practice').first().evaluate((el) => getComputedStyle(el).getPropertyValue('--c').trim());
  check('event takes the person’s color', col.toLowerCase() === emma.color.toLowerCase(), `${col} vs ${emma.color}`);
  // all-day multi-day family event
  await page.click('.calbar .addev'); await page.waitForSelector('.evform');
  await page.fill('.evform input[placeholder^="Soccer"]', 'Grandma visits');
  await page.fill('.evform input[type=date] >> nth=0', addDays(2));
  await page.click('.evform .toggle:has-text("All day")');
  await page.fill('.evform .field:not([hidden]) input[type=date] >> nth=1', addDays(4));
  await page.click('.sheet .btn.primary:has-text("Save")');
  await page.click('.seg button:has-text("Month")');
  await page.waitForSelector('.calbody .chip:has-text("Grandma visits")', { timeout: 10000 });
  const gCount = await page.locator('.calbody .chip:has-text("Grandma visits")').count();
  check('multi-day all-day event spans its days in month view', gCount >= 1, `${gCount} chip(s)`);
  await shot(page, 'calendar-family-1920');
  // repeats show next week
  const fam = (await api(page, 'GET', '/family-events')).events;
  const soccerId = fam.find((e) => e.title === 'Soccer practice').id;
  const evs = await page.evaluate(async ([a, b]) => (await (await fetch(`/api/events?from=${a}&to=${b}`)).json()).events.filter((e) => e.c === 0), [Date.now(), Date.now() + 22 * 86400e3]);
  const soccerDays = evs.filter((e) => e.fid === soccerId).map((e) => e.occ);
  check('weekly event repeats every week', soccerDays.length === 3 && soccerDays[0] === addDays(1) && soccerDays[1] === addDays(8), soccerDays.join(','));
  const soc = evs.find((e) => e.fid === soccerId);
  check('time is kept in the family time zone', new Date(soc.s).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' }) === '5:30 PM');
  // person filter
  await page.click(`.pfilter button:has-text("${mom.name}")`); await page.waitForTimeout(600);
  const momSees = [await ev(0, 'Soccer practice').count(), await ev(0, 'Grandma visits').count()];
  await page.click(`.pfilter button:has-text("${emma.name}")`); await page.waitForTimeout(600);
  const emmaSees = [await ev(0, 'Soccer practice').count(), await ev(0, 'Grandma visits').count()];
  check('person filter: Emma’s event hidden for Mom, family-wide event shown to everyone', momSees[0] === 0 && momSees[1] > 0 && emmaSees[0] > 0 && emmaSees[1] > 0, `mom ${momSees} emma ${emmaSees}`);
  await page.click('.pfilter button:has-text("Everyone")');
  // edit from the event popup
  await ev(0, 'Soccer practice').first().click();
  await page.click('.sheet .btn:has-text("Edit")');
  await page.waitForSelector('.evform');
  await page.fill('.evform input[placeholder^="Soccer"]', 'Soccer game');
  await page.click('.sheet .btn.primary:has-text("Save")');
  await page.waitForSelector('.calbody .chip:has-text("Soccer game")', { timeout: 10000 });
  await page.waitForTimeout(800);
  const after = await page.evaluate(async ([a, b]) => (await (await fetch(`/api/events?from=${a}&to=${b}`)).json()).events.filter((e) => e.c === 0), [Date.now(), Date.now() + 22 * 86400e3]);
  const renamed = [after.filter((e) => e.t === 'Soccer game').length, after.filter((e) => e.t === 'Soccer practice').length];
  check('edit an event from its popup (all repeats renamed)', renamed[0] === 3 && renamed[1] === 0 && (await ev(0, 'Soccer game').count()) >= 1, `${renamed}`);
  // phone: add and delete with the PIN
  await open(phone, 'calendar', '.calbar .addev');
  await lockState(phone, true);
  await open(phone, 'calendar', '.calbar .addev');
  await phone.click('.calbar .addev'); await phone.waitForTimeout(400);
  if (await phone.isVisible('.pin .pad')) await typePin(phone);
  await phone.waitForSelector('.evform', { timeout: 8000 });
  await phone.fill('.evform input[placeholder^="Soccer"]', 'Dentist');
  await phone.fill('.evform input[type=date] >> nth=0', addDays(3));
  await phone.fill('.evform input[type=time] >> nth=0', '09:00');
  await phone.fill('.evform input[type=time] >> nth=1', '10:00');
  await phone.fill('.evform input[placeholder^="Address"]', 'Smile Dental, 123 Main St');
  await phone.waitForTimeout(700); await shot(phone, 'event-form-390');
  await phone.click('.sheet .btn.primary:has-text("Save")');
  await phone.waitForSelector('.calbody :is(.ev, .chip):has-text("Dentist")', { timeout: 10000 });
  check('event created from a phone with the PIN', true);
  await shot(phone, 'calendar-390');
  await page.reload(); await page.waitForSelector('.calbody'); await page.waitForTimeout(1200);
  check('phone’s event shows on the wall', (await ev(0, 'Dentist').count()) > 0);
  await phone.locator('.calbody :is(.ev, .chip):has-text("Dentist")').first().click();
  check('event popup shows the place', await phone.isVisible('.sheet :text("Smile Dental")'));
  await phone.click('.sheet .btn:has-text("Edit")'); await phone.waitForSelector('.evform');
  await phone.click('.sheet .btn.danger:has-text("Delete")');
  await phone.locator('.btn.danger:has-text("Delete")').last().click();
  await phone.waitForTimeout(2000);
  check('delete an event', (await phone.locator('.calbody :has-text("Dentist")').count()) === 0);
  // validation
  const nErr4 = errors.length;
  const bad = await page.evaluate(async () => (await fetch('/api/family-events', { method: 'POST', headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: JSON.stringify({ title: '', date: '2026-01-01' }) })).status);
  await page.waitForTimeout(300); errors.splice(nErr4); // the expected 400 is logged by Chrome
  check('server rejects an event without a name', bad === 400);
  await lockState(page, false);
  // phone feed link (settings)
  await open(page, 'settings', '.settings');
  await api(page, 'DELETE', '/family-feed');
  await open(page, 'settings', 'button:has-text("Create phone link")');
  await page.click('button:has-text("Create phone link")');
  await page.waitForSelector('.feedurl', { timeout: 8000 });
  const link = (await page.textContent('.feedurl')).trim();
  const r1 = await fetch(link); const ics = await r1.text();
  check('phone subscribe link serves an .ics with the events', r1.ok && /text\/calendar/.test(r1.headers.get('content-type')) && ics.includes(`SUMMARY:Soccer game (${emma.name})`) && ics.includes('RRULE:FREQ=WEEKLY') && ics.includes('SUMMARY:Grandma visits'), `${r1.status}`);
  await page.locator('.sbox:has(.feedurl)').scrollIntoViewIfNeeded();
  await page.waitForTimeout(700); await shot(page, 'settings-feed-1920');
  await page.click('.feedrow button:has-text("New link")'); await page.click('.sheet .btn.danger:has-text("New link")');
  await page.waitForFunction((old) => document.querySelector('.feedurl') && document.querySelector('.feedurl').textContent.trim() !== old, link, { timeout: 8000 });
  check('old link stops working after making a new one', (await fetch(link)).status === 404);
  check('a made-up feed link is refused', (await fetch(base + '/feed/' + 'x'.repeat(32) + '.ics')).status === 404);
  await lockState(page, true);
  const locked = await page.evaluate(async () => (await fetch('/api/family-events')).status);
  check('family event list needs the PIN', locked === 403);
  await page.evaluate(() => localStorage.setItem('wc.calPerson', ''));
  await open(page, 'home', '.calbody'); await shot(page, 'home-1920');
}

const extra = process.env.E2E_EXTRA ? await import(process.env.E2E_EXTRA) : null;
if (extra) await extra.default({ page, phone, api, state, check, open, shot, lockState, typePin, steps, today, kids, base });

console.log('errors:', errors.length ? errors.join('\n') : 'none');
const fails = results.filter((r) => r[0] === 'FAIL');
console.log(`SUMMARY ${results.length - fails.length}/${results.length} passed${errors.length ? `, ${errors.length} browser errors` : ''}`);
await browser.close();
process.exit(fails.length || errors.length ? 1 : 0);
