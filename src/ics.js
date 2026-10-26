// Minimal, fast iCalendar (RFC 5545) reader + recurrence expander for calendar feeds
// (Apple iCloud public webcal, Google "secret address in iCal format").
// Supports: TZID/UTC/floating/all-day times, DTEND/DURATION, RRULE (DAILY/WEEKLY/MONTHLY/YEARLY,
// INTERVAL, COUNT, UNTIL, BYDAY incl. ordinals, BYMONTHDAY, BYMONTH, BYSETPOS, WKST),
// RDATE, EXDATE, RECURRENCE-ID overrides and cancellations.
import { zonedToUtc, partsInTz, validTz, dayNum, fromDayNum, weekday, ymd, daysInMonth } from './tz.js';

const WIN_TZ = {
  'Central Standard Time': 'America/Chicago', 'Eastern Standard Time': 'America/New_York',
  'Mountain Standard Time': 'America/Denver', 'Pacific Standard Time': 'America/Los_Angeles',
  'US Mountain Standard Time': 'America/Phoenix', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'GMT Standard Time': 'Europe/London',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'UTC': 'UTC', 'Coordinated Universal Time': 'UTC',
};
const tzCache = new Map();
export function resolveTz(tzid, fallback) {
  if (!tzid) return fallback;
  if (tzCache.has(tzid)) return tzCache.get(tzid) || fallback;
  let tz = tzid.replace(/^"|"$/g, '');
  if (WIN_TZ[tz]) tz = WIN_TZ[tz];
  else if (!validTz(tz)) {
    const m = /([A-Za-z]+\/[A-Za-z_]+(?:\/[A-Za-z_]+)?)$/.exec(tz); // e.g. /mozilla.org/.../America/Chicago
    tz = m && validTz(m[1]) ? m[1] : null;
  }
  tzCache.set(tzid, tz);
  return tz || fallback;
}

export function unescapeText(s) {
  return s.replace(/\\([\\;,nN])/g, (_, c) => (c === 'n' || c === 'N' ? '\n' : c));
}

/** Split into VEVENT property maps. Each prop: { v, p: {PARAM: value} }; multi-valued props are arrays. */
export function parseEvents(text) {
  const out = [];
  const lines = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '').split(/\r?\n/);
  let cur = null, depth = 0;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = { _multi: {} }; depth = 0; continue; }
    if (!cur) continue;
    if (line === 'END:VEVENT') { out.push(cur); cur = null; continue; }
    if (line.startsWith('BEGIN:')) { depth++; continue; } // VALARM etc
    if (line.startsWith('END:')) { depth--; continue; }
    if (depth > 0) continue;
    const ci = colonIndex(line);
    if (ci < 0) continue;
    const head = line.slice(0, ci), v = line.slice(ci + 1);
    const parts = head.split(';');
    const name = parts[0].toUpperCase();
    const p = {};
    for (let i = 1; i < parts.length; i++) { const eq = parts[i].indexOf('='); if (eq > 0) p[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1).replace(/^"|"$/g, ''); }
    if (name === 'EXDATE' || name === 'RDATE') (cur._multi[name] ||= []).push({ v, p });
    else cur[name] = { v, p };
  }
  return out;
}
function colonIndex(line) { // first colon not inside a quoted param
  let q = false;
  for (let i = 0; i < line.length; i++) { const c = line[i]; if (c === '"') q = !q; else if (c === ':' && !q) return i; }
  return -1;
}

/** Parse a DATE or DATE-TIME value into a time object. */
export function parseTime(v, p, defTz) {
  const s = v.trim();
  const dm = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  if (dm || (p && p.VALUE === 'DATE')) {
    const m = dm || /^(\d{4})(\d{2})(\d{2})/.exec(s);
    if (!m) return null;
    return { allDay: true, y: +m[1], m: +m[2], d: +m[3], h: 0, mi: 0, s: 0 };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(s);
  if (!m) return null;
  const t = { allDay: false, y: +m[1], m: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +(m[6] || 0) };
  if (m[7]) t.tz = 'UTC';
  else t.tz = resolveTz(p && p.TZID, defTz);
  return t;
}
const toMs = (t) => (t.tz === 'UTC' ? Date.UTC(t.y, t.m - 1, t.d, t.h, t.mi, t.s) : zonedToUtc(t.y, t.m, t.d, t.h, t.mi, t.s, t.tz));

/** ISO-8601 duration -> {days, ms} */
export function parseDuration(v) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec((v || '').trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  return { days: sign * ((+m[2] || 0) * 7 + (+m[3] || 0)), ms: sign * (((+m[4] || 0) * 60 + (+m[5] || 0)) * 60 + (+m[6] || 0)) * 1000 };
}

const DAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
export function parseRrule(v) {
  const r = {};
  for (const kv of v.split(';')) { const [k, val] = kv.split('='); if (k && val !== undefined) r[k.toUpperCase()] = val; }
  const rule = { freq: r.FREQ, interval: Math.max(1, +r.INTERVAL || 1), count: r.COUNT ? +r.COUNT : null, until: r.UNTIL || null, wkst: DAYS[r.WKST] ?? 1 };
  if (r.BYDAY) rule.byday = r.BYDAY.split(',').map((x) => { const m = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/.exec(x.trim()); return m ? { n: m[1] ? +m[1] : 0, wd: DAYS[m[2]] } : null; }).filter(Boolean);
  if (r.BYMONTHDAY) rule.bymonthday = r.BYMONTHDAY.split(',').map(Number).filter((n) => n && Math.abs(n) <= 31);
  if (r.BYMONTH) rule.bymonth = r.BYMONTH.split(',').map(Number).filter((n) => n >= 1 && n <= 12);
  if (r.BYSETPOS) rule.bysetpos = r.BYSETPOS.split(',').map(Number).filter(Boolean);
  return rule;
}

function nthWeekdayOfMonth(y, m, wd, n) { // n>0 nth, n<0 from end; returns day-of-month or null
  const dim = daysInMonth(y, m);
  if (n > 0) { const first = weekday(dayNum(y, m, 1)); const d = 1 + ((wd - first + 7) % 7) + (n - 1) * 7; return d <= dim ? d : null; }
  const last = weekday(dayNum(y, m, dim)); const d = dim - ((last - wd + 7) % 7) + (n + 1) * 7; return d >= 1 ? d : null;
}
function monthDays(y, m, rule, dtDay) { // candidate day-of-month numbers for a month
  const dim = daysInMonth(y, m);
  let days = null;
  if (rule.bymonthday) days = rule.bymonthday.map((d) => (d > 0 ? d : dim + d + 1)).filter((d) => d >= 1 && d <= dim);
  if (rule.byday) {
    const set = [];
    for (const { n, wd } of rule.byday) {
      if (n) { const d = nthWeekdayOfMonth(y, m, wd, n); if (d) set.push(d); }
      else for (let d = 1; d <= dim; d++) if (weekday(dayNum(y, m, d)) === wd) set.push(d);
    }
    days = days ? days.filter((d) => set.includes(d)) : set;
  }
  if (!days) days = dtDay <= dim ? [dtDay] : [];
  days = [...new Set(days)].sort((a, b) => a - b);
  if (rule.bysetpos) { const pick = []; for (const sp of rule.bysetpos) { const d = sp > 0 ? days[sp - 1] : days[days.length + sp]; if (d) pick.push(d); } days = [...new Set(pick)].sort((a, b) => a - b); }
  return days;
}

/**
 * Generate start day numbers (civil dates in the event's zone) for a recurring rule.
 * Yields in order; caller stops at window end. dtstart is always the first instance.
 */
function* ruleDays(rule, start, fromDay) {
  const sDay = dayNum(start.y, start.m, start.d);
  const freq = rule.freq, iv = rule.interval;
  const ok = (n) => {
    if (n < sDay) return false;
    const c = fromDayNum(n);
    if (rule.bymonth && !rule.bymonth.includes(c.m)) return false;
    return true;
  };
  const canSkip = rule.count == null; // without COUNT we may jump ahead to the window
  if (freq === 'DAILY') {
    let k = 0;
    if (canSkip && fromDay > sDay) k = Math.floor((fromDay - sDay) / iv);
    for (;; k++) {
      const n = sDay + k * iv;
      if (!ok(n)) { if (n < sDay) continue; yield { n, skip: true }; continue; }
      const c = fromDayNum(n);
      if (rule.byday && !rule.byday.some((b) => b.wd === weekday(n))) { yield { n, skip: true }; continue; }
      if (rule.bymonthday && !monthDays(c.y, c.m, { bymonthday: rule.bymonthday }, c.d).includes(c.d)) { yield { n, skip: true }; continue; }
      yield { n };
    }
  } else if (freq === 'WEEKLY') {
    const wdays = rule.byday ? [...new Set(rule.byday.map((b) => b.wd))] : [weekday(sDay)];
    const weekStart = sDay - ((weekday(sDay) - rule.wkst + 7) % 7);
    const order = wdays.map((wd) => (wd - rule.wkst + 7) % 7).sort((a, b) => a - b);
    let k = 0;
    if (canSkip && fromDay > weekStart + 7) k = Math.floor((fromDay - weekStart) / (7 * iv)) - 1;
    for (;; k++) {
      const ws = weekStart + k * 7 * iv;
      let any = false;
      for (const off of order) { const n = ws + off; if (ok(n)) { any = true; yield { n }; } }
      if (!any) yield { n: ws + 6, skip: true };
    }
  } else if (freq === 'MONTHLY') {
    let k = 0;
    if (canSkip) { const f = fromDayNum(Math.max(fromDay, sDay)); const diff = (f.y - start.y) * 12 + (f.m - start.m); k = Math.max(0, Math.floor(diff / iv) - 1); }
    for (;; k++) {
      const mi = start.m - 1 + k * iv; const y = start.y + Math.floor(mi / 12), m = (mi % 12) + 1;
      if (rule.bymonth && !rule.bymonth.includes(m)) { yield { n: dayNum(y, m, 1), skip: true }; continue; }
      let any = false;
      for (const d of monthDays(y, m, rule, start.d)) { const n = dayNum(y, m, d); if (n >= sDay) { any = true; yield { n }; } }
      if (!any) yield { n: dayNum(y, m, 1), skip: true };
    }
  } else if (freq === 'YEARLY') {
    let k = 0;
    if (canSkip) { const f = fromDayNum(Math.max(fromDay, sDay)); k = Math.max(0, Math.floor((f.y - start.y) / iv) - 1); }
    for (;; k++) {
      const y = start.y + k * iv;
      const months = rule.bymonth || [start.m];
      let any = false;
      for (const m of months) {
        const r2 = rule.byday && !rule.bymonth ? { ...rule, byday: rule.byday } : rule;
        for (const d of monthDays(y, m, r2, start.d)) { const n = dayNum(y, m, d); if (n >= sDay) { any = true; yield { n }; } }
      }
      if (!any) yield { n: dayNum(y, 1, 1), skip: true };
    }
  }
}

const instKey = (t) => (t.allDay ? `D${ymd(t.y, t.m, t.d)}` : `T${toMs(t)}`);

/**
 * Expand a feed into event instances overlapping [fromMs, toMs).
 * Returns [{ id, uid, title, loc, allDay, start, end }] where timed start/end are UTC ms and
 * all-day start/end are 'YYYY-MM-DD' (end exclusive).
 */
export function expandIcs(text, { fromMs, toMs: endMs, tz = 'America/Chicago', max = 4000 } = {}) {
  const raw = parseEvents(text);
  const fromDay = Math.floor(fromMs / 86400000) - 2, toDay = Math.ceil(endMs / 86400000) + 2;
  const masters = new Map(), overrides = new Map(), singles = [];
  for (const ev of raw) {
    if (!ev.DTSTART) continue;
    const uid = ev.UID ? ev.UID.v : `nouid-${singles.length}-${ev.DTSTART.v}`;
    if (ev['RECURRENCE-ID']) {
      const rid = parseTime(ev['RECURRENCE-ID'].v, ev['RECURRENCE-ID'].p, tz);
      if (rid) { if (!overrides.has(uid)) overrides.set(uid, new Map()); overrides.get(uid).set(instKey(rid), ev); }
      continue;
    }
    if (ev.RRULE || ev._multi.RDATE) masters.set(uid, ev); else singles.push([uid, ev]);
  }
  const out = [];
  const push = (uid, ev, st, durDays, durMs) => {
    const status = ev.STATUS && ev.STATUS.v.toUpperCase();
    if (status === 'CANCELLED') return;
    const title = ev.SUMMARY ? unescapeText(ev.SUMMARY.v) : '(busy)';
    const loc = ev.LOCATION ? unescapeText(ev.LOCATION.v) : '';
    if (st.allDay) {
      const s = dayNum(st.y, st.m, st.d), e = s + Math.max(1, durDays);
      if (e * 86400000 <= fromMs - 86400000 * 1 || s * 86400000 >= endMs + 86400000) return;
      const sk = ymd(st.y, st.m, st.d), ec = fromDayNum(e);
      out.push({ id: `${uid}|${sk}`, uid, title, loc, allDay: true, start: sk, end: ymd(ec.y, ec.m, ec.d) });
    } else {
      const s = toMs(st);
      let e;
      if (durDays) { // day-based duration keeps wall-clock time across DST
        const c = fromDayNum(dayNum(st.y, st.m, st.d) + durDays);
        e = toMs({ ...st, y: c.y, m: c.m, d: c.d }) + durMs;
      } else e = s + durMs;
      if (e <= s) e = s;
      if (e < fromMs || s >= endMs || (e === s && s < fromMs)) return;
      out.push({ id: `${uid}|${s}`, uid, title, loc, allDay: false, start: s, end: e });
    }
  };
  const durationOf = (ev, st) => {
    if (ev.DTEND) {
      const en = parseTime(ev.DTEND.v, ev.DTEND.p, tz);
      if (en) {
        if (st.allDay) return { days: dayNum(en.y, en.m, en.d) - dayNum(st.y, st.m, st.d), ms: 0 };
        if (en.allDay) return { days: 0, ms: 0 };
        return { days: 0, ms: toMs(en) - toMs(st) };
      }
    }
    if (ev.DURATION) { const d = parseDuration(ev.DURATION.v); if (d) return d; }
    return st.allDay ? { days: 1, ms: 0 } : { days: 0, ms: 0 };
  };

  for (const [uid, ev] of singles) {
    const st = parseTime(ev.DTSTART.v, ev.DTSTART.p, tz);
    if (!st) continue;
    const d = durationOf(ev, st);
    push(uid, ev, st, d.days, d.ms);
  }

  for (const [uid, ev] of masters) {
    const st = parseTime(ev.DTSTART.v, ev.DTSTART.p, tz);
    if (!st) continue;
    const dur = durationOf(ev, st);
    const ovr = overrides.get(uid) || new Map();
    const ex = new Set();
    for (const e of ev._multi.EXDATE || []) for (const v of e.v.split(',')) { const t = parseTime(v, e.p, st.tz || tz); if (t) ex.add(st.allDay ? `D${ymd(t.y, t.m, t.d)}` : instKey(t.allDay ? { ...st, y: t.y, m: t.m, d: t.d } : t)); }
    const emit = (inst) => {
      const k = instKey(inst);
      if (ex.has(k)) return;
      const o = ovr.get(k);
      if (o) {
        ovr.delete(k);
        const ost = parseTime(o.DTSTART.v, o.DTSTART.p, tz);
        if (ost) { const od = durationOf(o, ost); push(uid, o, ost, od.days, od.ms); }
        return;
      }
      push(uid, ev, inst, dur.days, dur.ms);
    };
    const seen = new Set();
    if (ev.RRULE) {
      const rule = parseRrule(ev.RRULE.v);
      let untilMs = null, untilDay = null;
      if (rule.until) {
        const u = parseTime(rule.until, {}, st.tz || tz);
        if (u) { if (u.allDay || st.allDay) untilDay = dayNum(u.y, u.m, u.d); else untilMs = u.tz === 'UTC' ? toMs(u) : toMs({ ...u, tz: st.tz }); }
      }
      let count = 0, guard = 0;
      const sDayN = dayNum(st.y, st.m, st.d);
      const first = { n: sDayN };
      const gen = ruleDays(rule, st, fromDay);
      if (rule.freq && ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(rule.freq)) {
        // RFC 5545: DTSTART is always the first instance, even if the rule wouldn't produce it.
        let pendingFirst = true;
        for (;;) {
          if (++guard > 20000) break;
          let item;
          if (pendingFirst) { item = first; pendingFirst = false; }
          else { const r = gen.next(); if (r.done) break; item = r.value; }
          if (item.n > toDay) break;
          if (item.skip) continue;
          if (seen.has(item.n)) continue;
          seen.add(item.n);
          const c = fromDayNum(item.n);
          const inst = { ...st, y: c.y, m: c.m, d: c.d };
          if (untilDay != null && item.n > untilDay) break;
          if (untilMs != null && toMs(inst) > untilMs) break;
          count++;
          if (rule.count != null && count > rule.count) break;
          if (item.n < fromDay - 400 && rule.count == null) continue;
          emit(inst);
          if (out.length > max) break;
        }
      } else emit(st);
    } else emit(st);
    for (const r of ev._multi.RDATE || []) for (const v of r.v.split(',')) {
      const t = parseTime(v, r.p, st.tz || tz);
      if (!t) continue;
      const inst = st.allDay ? { ...st, y: t.y, m: t.m, d: t.d } : t.allDay ? { ...st, y: t.y, m: t.m, d: t.d } : t;
      if (!seen.has(dayNum(inst.y, inst.m, inst.d)) || !st.allDay) emit(inst);
    }
    // overrides that moved an instance in from outside the generated set are still shown
    for (const o of ovr.values()) { const ost = parseTime(o.DTSTART.v, o.DTSTART.p, tz); if (ost) { const od = durationOf(o, ost); push(uid, o, ost, od.days, od.ms); } }
  }
  // orphan overrides (no master in feed)
  for (const [uid, m] of overrides) if (!masters.has(uid)) for (const o of m.values()) { const ost = parseTime(o.DTSTART.v, o.DTSTART.p, tz); if (ost) { const od = durationOf(o, ost); push(uid, o, ost, od.days, od.ms); } }

  const sortKey = (e) => (e.allDay ? Date.UTC(...e.start.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) : e.start);
  out.sort((a, b) => sortKey(a) - sortKey(b) || (a.allDay ? -1 : 1));
  return out.slice(0, max);
}

export function normalizeFeedUrl(u) {
  const s = String(u || '').trim();
  if (/^webcals?:\/\//i.test(s)) return 'https://' + s.replace(/^webcals?:\/\//i, '');
  return s;
}
export { partsInTz };
