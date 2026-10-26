// Time-zone helpers built on Intl (no tz database bundled). All "wall" values are civil
// components in a named IANA zone; "ms" values are UTC epoch milliseconds.
const fmtCache = new Map();
function fmt(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function validTz(tz) {
  if (!tz) return false;
  try { fmt(tz); return true; } catch { return false; }
}

/** Civil components of a UTC instant in tz. */
export function partsInTz(ms, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, h: +o.hour % 24, mi: +o.minute, s: +o.second, dow: WD[o.weekday] };
}

/** Offset (ms) of tz from UTC at instant ms. */
export function tzOffset(ms, tz) {
  const p = partsInTz(ms, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** UTC ms for a wall-clock time in tz. Gaps (spring forward) resolve forward; overlaps pick the first. */
export function zonedToUtc(y, m, d, h, mi, s, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi, s);
  const o1 = tzOffset(guess, tz);
  let t = guess - o1;
  const o2 = tzOffset(t, tz);
  if (o2 !== o1) {
    const t2 = guess - o2;
    t = tzOffset(t2, tz) === o2 ? t2 : Math.max(t, t2);
  }
  // overlap: prefer the earlier instant if it maps to the same wall time
  const earlier = t - 3600e3;
  const pe = partsInTz(earlier, tz);
  if (pe.y === y && pe.m === m && pe.d === d && pe.h === h && pe.mi === mi) t = earlier;
  return t;
}

// ---- civil-day arithmetic (no time zone) ----
export const dayNum = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / 86400000);
export function fromDayNum(n) {
  const dt = new Date(n * 86400000);
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}
export const weekday = (n) => (((n + 4) % 7) + 7) % 7; // 0 = Sunday
export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const ymd = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
export const dayKeyFromNum = (n) => { const c = fromDayNum(n); return ymd(c.y, c.m, c.d); };
export function parseDayKey(k) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(k || '');
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}
export const numFromKey = (k) => { const c = parseDayKey(k); return c ? dayNum(c.y, c.m, c.d) : NaN; };
export function dayKey(ms, tz) { const p = partsInTz(ms, tz); return ymd(p.y, p.m, p.d); }
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
