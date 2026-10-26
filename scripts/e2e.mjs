// Smoke test + screenshots. Usage: node scripts/e2e.mjs <baseUrl> <outPrefix> [--seed]
// Needs a fresh database (no PIN yet) when --seed is passed. PIN used: E2E_PIN (default 2468).
import { chromium } from 'playwright-core';
const [base, out = '/tmp/wc', ...flags] = process.argv.slice(2);
const PIN = process.env.E2E_PIN || '2468';
const browser = await chromium.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, timezoneId: 'America/Chicago' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
const typePin = async (pin) => { for (const d of pin) await page.click(`.pin .pad button[aria-label="${d}"]`); await page.click('.pin .pad button[aria-label="ok"]'); };
const api = (method, path, body) => page.evaluate(async ([method, path, body]) => {
  const r = await fetch('/api' + path, { method, headers: { 'x-wc': '1', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json(); if (!r.ok) throw new Error(path + ': ' + j.error); return j;
}, [method, path, body]);

await page.goto(base);
await page.waitForSelector('.boot');
await page.screenshot({ path: `${out}-firstrun.png` });
if (flags.includes('--seed')) {
  await page.click('text=Set parent PIN');
  await typePin(PIN); await page.waitForTimeout(300); await typePin(PIN);
  await page.waitForSelector('.settings', { timeout: 15000 });
  const people = [['David', '#5B8DEF', '🧔', 'parent'], ['Mom', '#D16BA5', '👩', 'parent'], ['Emma', '#F4A261', '🦄', 'kid'], ['Leo', '#2A9D8F', '🦖', 'kid']];
  const ids = [];
  for (const [i, [name, color, emoji, role]] of people.entries()) ids.push((await api('POST', '/people', { name, color, emoji, role, sort: i })).id);
  const kids = ids.slice(2);
  const cal = await api('POST', '/calendars', { name: 'US Holidays', url: 'https://calendar.google.com/calendar/ical/en.usa%23holiday%40group.v.calendar.google.com/public/basic.ics', color: '#E76F51' });
  console.log('holiday sync', JSON.stringify(cal.sync));
  if (process.env.SAMPLE_ICS) { const c2 = await api('POST', '/calendars', { name: 'Family', url: process.env.SAMPLE_ICS, color: '#5B8DEF', person_id: ids[0] }); console.log('sample sync', JSON.stringify(c2.sync)); }
  const t = [];
  for (const task of [
    { title: 'Make bed', emoji: '🛏️', kind: 'chore', stars: 1, recur: 'daily', assignees: kids, part: 'morning' },
    { title: 'Brush teeth', emoji: '🪥', kind: 'habit', stars: 1, recur: 'daily', assignees: kids },
    { title: 'Good bedtime', emoji: '🌙', kind: 'habit', stars: 1, recur: 'daily', assignees: kids, part: 'evening' },
    { title: 'Feed the dog', emoji: '🐕', kind: 'chore', stars: 2, recur: 'weekdays', assignees: [kids[0]] },
    { title: 'Piano practice', emoji: '🎹', kind: 'activity', stars: 2, recur: 'weekly', days: [1, 3, 5], assignees: [kids[1]] },
  ]) t.push((await api('POST', '/tasks', task)).id);
  await api('POST', '/rewards', { name: 'Ice cream trip', emoji: '🍦', cost: 5, scope: 'kid', task_ids: [t[2]], description: '5 good bedtimes' });
  await api('POST', '/rewards', { name: 'Family movie night', emoji: '🍿', cost: 20, scope: 'family' });
  await api('POST', '/stars/adjust', { person_id: kids[0], delta: 3, note: 'Helped with groceries' });
  await api('PUT', '/settings', { weather: { name: 'Chicago', region: 'Illinois', country: 'United States', lat: 41.85, lon: -87.65, tz: 'America/Chicago' } });
  // upload a generated photo through the real UI path (client resize)
  await page.evaluate(async () => {
    const c = document.createElement('canvas'); c.width = 2400; c.height = 1600; const g = c.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 2400, 1600); gr.addColorStop(0, '#2a9d8f'); gr.addColorStop(1, '#e9c46a'); g.fillStyle = gr; g.fillRect(0, 0, 2400, 1600);
    g.fillStyle = '#fff'; g.font = 'bold 200px sans-serif'; g.fillText('Test photo', 600, 850);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.9));
    const fd = new FormData(); fd.append('photo', blob, 'p.jpg'); fd.append('thumb', blob.size < 300000 ? blob : await new Promise((r) => { const s = document.createElement('canvas'); s.width = 480; s.height = 320; s.getContext('2d').drawImage(c, 0, 0, 480, 320); s.toBlob(r, 'image/jpeg', 0.7); }), 't.jpg'); fd.append('w', 2400); fd.append('h', 1600);
    const r = await fetch('/api/photos', { method: 'POST', headers: { 'x-wc': '1' }, body: fd }); if (!r.ok) throw new Error('photo ' + r.status + ' ' + await r.text());
  });
  await page.click('#lockbtn'); // lock parent mode for kid-view tests
}
await page.goto(base + '/#home'); await page.reload(); await page.waitForSelector('.kidcard', { timeout: 15000 }); await page.waitForTimeout(2500);
await page.screenshot({ path: `${out}-home-1920.png` });
// kid taps a chore (no PIN needed)
const before = await page.textContent('.kidcard .stars');
await page.click('.kidcard .task:not(.done)');
await page.waitForTimeout(2200);
const after = await page.textContent('.kidcard .stars');
console.log('stars before/after tap:', before.trim(), after.trim());
for (const v of ['month', 'day', 'agenda']) { await page.goto(base + '/#calendar'); await page.waitForSelector('.calbar'); await page.click(`.seg button:has-text("${v === 'agenda' ? 'List' : v[0].toUpperCase() + v.slice(1)}")`); await page.waitForTimeout(600); await page.screenshot({ path: `${out}-cal-${v}-1920.png` }); }
for (const v of ['chores', 'rewards', 'photos', 'settings']) { await page.goto(base + '/#' + v); await page.waitForTimeout(900); await page.screenshot({ path: `${out}-${v}-1920.png` }); }
// settings should be PIN-gated now
console.log('settings locked:', await page.isVisible('.lockbar'));
// slideshow + night dim sanity
await page.goto(base + '/#photos'); await page.waitForTimeout(700);
if (await page.isVisible('text=▶ Slideshow')) { await page.click('text=▶ Slideshow'); await page.waitForTimeout(2500); await page.screenshot({ path: `${out}-slideshow-1920.png` }); }
// phone
const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/Chicago', storageState: await ctx.storageState() });
const pp = await phone.newPage(); pp.on('pageerror', (e) => errors.push('phone pageerror: ' + e.message));
await pp.goto(base + '/#home'); await pp.waitForSelector('.kidcard', { timeout: 15000 }); await pp.waitForTimeout(2000);
await pp.screenshot({ path: `${out}-home-390.png`, fullPage: true });
await pp.goto(base + '/#calendar'); await pp.waitForTimeout(1200); await pp.screenshot({ path: `${out}-calendar-390.png` });
await pp.goto(base + '/#rewards'); await pp.waitForTimeout(900); await pp.screenshot({ path: `${out}-rewards-390.png`, fullPage: true });
console.log('errors:', errors.length ? errors.join('\n') : 'none');
await browser.close();
