// Local family calendar: validation, expansion into calendar events, and an .ics feed for phones.
import { zonedToUtc, numFromKey, dayKeyFromNum, fromDayNum, parseDayKey, daysInMonth, pad } from './tz.js';

export const REPEATS = ['none', 'weekly', 'monthly', 'yearly'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const clean = (s, max) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const cleanNotes = (s, max) => String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Validates a create/update body. Returns { ok, value } or { error }. */
export function cleanFamilyEvent(b, personIds) {
  const title = clean(b.title, 80);
  if (!title) return { error: 'Give the event a name' };
  if (!parseDayKey(b.date)) return { error: 'Pick a date' };
  const allDay = !!b.all_day;
  let endDate = b.end_date && parseDayKey(b.end_date) ? b.end_date : b.date;
  if (endDate < b.date) return { error: 'The end is before the start' };
  if (numFromKey(endDate) - numFromKey(b.date) > 31) return { error: 'Events can span at most a month' };
  let start = '', end = '';
  if (!allDay) {
    if (!TIME_RE.test(b.start_time || '')) return { error: 'Pick a start time' };
    start = b.start_time;
    end = TIME_RE.test(b.end_time || '') ? b.end_time : addMinutes(start, 60);
    endDate = b.date;
    if (end <= start) endDate = dayKeyFromNum(numFromKey(b.date) + 1); // runs past midnight
  }
  const repeat = REPEATS.includes(b.repeat) ? b.repeat : 'none';
  let until = repeat !== 'none' && b.until && parseDayKey(b.until) ? b.until : '';
  if (until && until < b.date) return { error: 'The repeat ends before the event starts' };
  const pid = b.person_id ? +b.person_id : null;
  if (pid && !personIds.includes(pid)) return { error: 'Unknown person' };
  return { ok: true, value: { title, location: clean(b.location, 120), notes: cleanNotes(b.notes, 1000), person_id: pid, all_day: allDay ? 1 : 0, date: b.date, end_date: endDate, start_time: start, end_time: end, repeat, until } };
}
function addMinutes(t, n) { const m = Math.min(+t.slice(0, 2) * 60 + +t.slice(3) + n, 23 * 60 + 59); return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`; }

/** Start days (day numbers) of each occurrence that could overlap [fromN, toN). */
export function occurrenceDays(ev, fromN, toN) {
  const first = numFromKey(ev.date), span = numFromKey(ev.end_date) - first;
  const last = ev.until ? Math.min(numFromKey(ev.until), toN) : toN;
  const out = [];
  if (ev.repeat === 'none' || !REPEATS.includes(ev.repeat)) return first + span >= fromN && first < toN ? [first] : [];
  if (ev.repeat === 'weekly') {
    let n = first + Math.max(0, Math.ceil((fromN - span - first) / 7)) * 7;
    for (; n <= last && n < toN && out.length < 400; n += 7) out.push(n);
    return out;
  }
  const c = fromDayNum(first);
  for (let i = 0; out.length < 400 && i < 2400; i++) {
    let y = c.y, m = c.m;
    if (ev.repeat === 'monthly') { const mi = c.m - 1 + i; y = c.y + Math.floor(mi / 12); m = (mi % 12) + 1; } else y = c.y + i;
    if (c.d > daysInMonth(y, m)) continue; // e.g. the 31st, or Feb 29 in a non-leap year
    const n = numFromKey(`${y}-${pad(m)}-${pad(c.d)}`);
    if (n > last || n >= toN) break;
    if (n + span >= fromN) out.push(n);
  }
  return out;
}

/** Expands rows into the same shape the client uses for feed events (c = 0 marks the family calendar). */
export function expandFamily(rows, fromMs, toMs, tz) {
  const fromN = Math.floor(fromMs / 86400e3) - 1, toN = Math.ceil(toMs / 86400e3) + 1;
  const out = [];
  for (const ev of rows) {
    const span = numFromKey(ev.end_date) - numFromKey(ev.date);
    for (const n of occurrenceDays(ev, fromN, toN)) {
      const base = { t: ev.title, l: ev.location || undefined, c: 0, p: ev.person_id || null, fid: ev.id, occ: dayKeyFromNum(n) };
      if (ev.all_day) { out.push({ ...base, a: true, s: dayKeyFromNum(n), e: dayKeyFromNum(n + span + 1) }); continue; }
      const sd = fromDayNum(n), ed = fromDayNum(n + span);
      const s = zonedToUtc(sd.y, sd.m, sd.d, +ev.start_time.slice(0, 2), +ev.start_time.slice(3), 0, tz);
      const e = zonedToUtc(ed.y, ed.m, ed.d, +ev.end_time.slice(0, 2), +ev.end_time.slice(3), 0, tz);
      if (e > fromMs && s < toMs) out.push({ ...base, a: false, s, e });
    }
  }
  return out;
}

// ---------- iCalendar feed (subscribe from Google Calendar / iPhone) ----------
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
function fold(line) {
  const chars = [...line], out = [];
  let cur = '', bytes = 0;
  for (const ch of chars) {
    const b = new TextEncoder().encode(ch).length;
    if (bytes + b > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n ');
}
const d8 = (k) => k.replace(/-/g, '');
const untilUtc = (k, tz) => { const c = parseDayKey(k); return stamp(zonedToUtc(c.y, c.m, c.d, 23, 59, 59, tz)); };
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

export function familyIcs(rows, { tz, name, people = [], host = 'wall-calendar' }) {
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//wall-calendar//family//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(name)}`, `X-WR-TIMEZONE:${tz}`, 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const ev of rows) {
    const who = ev.person_id ? people.find((p) => p.id === ev.person_id) : null;
    L.push('BEGIN:VEVENT', `UID:fe-${ev.id}@${host}`, `DTSTAMP:${stamp(ev.updated_at || ev.created_at || Date.now())}`, `SUMMARY:${esc(who ? `${ev.title} (${who.name})` : ev.title)}`);
    if (ev.all_day) L.push(`DTSTART;VALUE=DATE:${d8(ev.date)}`, `DTEND;VALUE=DATE:${d8(dayKeyFromNum(numFromKey(ev.end_date) + 1))}`);
    else L.push(`DTSTART;TZID=${tz}:${d8(ev.date)}T${ev.start_time.replace(':', '')}00`, `DTEND;TZID=${tz}:${d8(ev.end_date)}T${ev.end_time.replace(':', '')}00`);
    if (ev.repeat && ev.repeat !== 'none') L.push(`RRULE:FREQ=${ev.repeat.toUpperCase()}${ev.until ? `;UNTIL=${ev.all_day ? d8(ev.until) : untilUtc(ev.until, tz)}` : ''}`);
    if (ev.location) L.push(`LOCATION:${esc(ev.location)}`);
    if (ev.notes) L.push(`DESCRIPTION:${esc(ev.notes)}`);
    L.push('END:VEVENT');
  }
  L.push('END:VCALENDAR');
  return L.map(fold).join('\r\n') + '\r\n';
}
