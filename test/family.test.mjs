import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanFamilyEvent, occurrenceDays, expandFamily, familyIcs } from '../src/family.js';
import { numFromKey, dayKeyFromNum } from '../src/tz.js';

const TZ = 'America/Chicago';
const ms = (k) => Date.parse(k + 'T00:00:00Z');
const ev = (o) => ({ id: 1, title: 'X', location: '', person_id: null, all_day: 0, start_time: '', end_time: '', repeat: 'none', until: '', ...o });

test('cleanFamilyEvent validates and fills defaults', () => {
  assert.equal(cleanFamilyEvent({ title: '', date: '2026-10-30' }, []).error, 'Give the event a name');
  assert.equal(cleanFamilyEvent({ title: 'A', date: 'nope' }, []).error, 'Pick a date');
  assert.equal(cleanFamilyEvent({ title: 'A', date: '2026-10-30' }, []).error, 'Pick a start time');
  const t = cleanFamilyEvent({ title: ' Soccer ', date: '2026-10-30', start_time: '17:30' }, []).value;
  assert.deepEqual([t.title, t.end_time, t.end_date, t.all_day], ['Soccer', '18:30', '2026-10-30', 0]);
  const late = cleanFamilyEvent({ title: 'Late', date: '2026-10-30', start_time: '22:00', end_time: '01:00' }, []).value;
  assert.equal(late.end_date, '2026-10-31');
  const ad = cleanFamilyEvent({ title: 'Trip', date: '2026-11-02', end_date: '2026-11-05', all_day: true, start_time: '09:00' }, []).value;
  assert.deepEqual([ad.all_day, ad.end_date, ad.start_time], [1, '2026-11-05', '']);
  assert.equal(cleanFamilyEvent({ title: 'A', date: '2026-11-02', end_date: '2026-11-01', all_day: true }, []).error, 'The end is before the start');
  assert.equal(cleanFamilyEvent({ title: 'A', date: '2026-11-02', all_day: true, person_id: 9 }, [1]).error, 'Unknown person');
  assert.equal(cleanFamilyEvent({ title: 'A', date: '2026-11-02', all_day: true, repeat: 'hourly' }, []).value.repeat, 'none');
  assert.equal(cleanFamilyEvent({ title: 'A', date: '2026-11-02', all_day: true, until: '2026-12-01' }, []).value.until, '', 'until ignored without repeat');
});

test('weekly, monthly and yearly occurrences', () => {
  const n = numFromKey;
  const w = occurrenceDays(ev({ date: '2026-10-06', end_date: '2026-10-06', repeat: 'weekly' }), n('2026-10-20'), n('2026-11-10'));
  assert.deepEqual(w.map(dayKeyFromNum), ['2026-10-20', '2026-10-27', '2026-11-03']);
  const until = occurrenceDays(ev({ date: '2026-10-06', end_date: '2026-10-06', repeat: 'weekly', until: '2026-10-27' }), n('2026-10-20'), n('2026-11-10'));
  assert.deepEqual(until.map(dayKeyFromNum), ['2026-10-20', '2026-10-27']);
  const mo = occurrenceDays(ev({ date: '2026-01-31', end_date: '2026-01-31', repeat: 'monthly' }), n('2026-01-01'), n('2026-06-01'));
  assert.deepEqual(mo.map(dayKeyFromNum), ['2026-01-31', '2026-03-31', '2026-05-31'], 'months without a 31st are skipped');
  const leap = occurrenceDays(ev({ date: '2024-02-29', end_date: '2024-02-29', repeat: 'yearly' }), n('2024-01-01'), n('2029-01-01'));
  assert.deepEqual(leap.map(dayKeyFromNum), ['2024-02-29', '2028-02-29']);
  const span = occurrenceDays(ev({ date: '2026-10-17', end_date: '2026-10-19', repeat: 'weekly' }), n('2026-10-19'), n('2026-10-22'));
  assert.deepEqual(span.map(dayKeyFromNum), ['2026-10-17'], 'a multi-day occurrence that started before the window still shows');
  assert.deepEqual(occurrenceDays(ev({ date: '2026-12-01', end_date: '2026-12-01' }), n('2026-10-01'), n('2026-11-01')), []);
});

test('expandFamily keeps wall-clock time across DST', () => {
  const rows = [ev({ id: 7, title: 'Piano', person_id: 3, date: '2026-10-27', end_date: '2026-10-27', start_time: '16:00', end_time: '16:45', repeat: 'weekly' })];
  const out = expandFamily(rows, ms('2026-10-26'), ms('2026-11-12'), TZ);
  assert.equal(out.length, 3);
  const local = out.map((e) => new Date(e.s).toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }));
  assert.deepEqual(local, ['4:00 PM', '4:00 PM', '4:00 PM']);
  assert.equal(out[1].s - out[0].s, 7 * 86400e3 + 3600e3, 'DST ended in between');
  assert.deepEqual([out[0].c, out[0].p, out[0].fid, out[0].e - out[0].s], [0, 3, 7, 45 * 60e3]);
  const ad = expandFamily([ev({ all_day: 1, date: '2026-11-02', end_date: '2026-11-04' })], ms('2026-11-01'), ms('2026-11-08'), TZ);
  assert.deepEqual([ad[0].a, ad[0].s, ad[0].e], [true, '2026-11-02', '2026-11-05']);
});

test('familyIcs builds a valid feed', () => {
  const ics = familyIcs([
    ev({ id: 1, title: 'Soccer, practice', person_id: 2, date: '2026-10-27', end_date: '2026-10-27', start_time: '17:30', end_time: '18:30', repeat: 'weekly', until: '2026-12-15', location: 'Field 3; north', notes: 'Bring water\nand shin guards', created_at: 0, updated_at: Date.UTC(2026, 9, 26) }),
    ev({ id: 2, title: 'Trip', all_day: 1, date: '2026-11-02', end_date: '2026-11-04', updated_at: 1 }),
  ], { tz: TZ, name: 'Our Family', people: [{ id: 2, name: 'Emma' }] });
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/);
  assert.match(ics, /SUMMARY:Soccer\\, practice \(Emma\)\r\n/);
  assert.match(ics, /DTSTART;TZID=America\/Chicago:20261027T173000\r\n/);
  assert.match(ics, /RRULE:FREQ=WEEKLY;UNTIL=20261216T055959Z\r\n/);
  assert.match(ics, /LOCATION:Field 3\\; north/);
  assert.match(ics, /DESCRIPTION:Bring water\\nand shin guards/);
  assert.match(ics, /DTSTART;VALUE=DATE:20261102\r\nDTEND;VALUE=DATE:20261105/);
  assert.ok(ics.split('\r\n').every((l) => new TextEncoder().encode(l).length <= 75));
  assert.match(ics, /END:VCALENDAR\r\n$/);
});

test('the feed round-trips through the app\'s own ICS parser, matching expandFamily', async () => {
  const { expandIcs } = await import('../src/ics.js');
  const rows = [ev({ id: 1, title: 'Piano', date: '2026-10-27', end_date: '2026-10-27', start_time: '16:00', end_time: '16:45', repeat: 'weekly', until: '2026-11-10', updated_at: 1 }),
    ev({ id: 2, title: 'Trip', all_day: 1, date: '2026-11-02', end_date: '2026-11-04', updated_at: 1 })];
  const from = ms('2026-10-20'), to = ms('2026-12-01');
  const parsed = expandIcs(familyIcs(rows, { tz: TZ, name: 'F' }), { fromMs: from, toMs: to, tz: TZ });
  const key = (e) => `${e.t}|${e.s}|${e.e}`;
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed.map((e) => key({ t: e.title, s: e.start, e: e.end })).sort(), expandFamily(rows, from, to, TZ).map(key).sort());
});
