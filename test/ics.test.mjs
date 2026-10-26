import test from 'node:test';
import assert from 'node:assert/strict';
import { expandIcs, normalizeFeedUrl, parseRrule } from '../src/ics.js';
import { zonedToUtc, dayKey } from '../src/tz.js';

const TZ = 'America/Chicago';
const cal = (...events) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:test', ...events.flat(), 'END:VCALENDAR'].join('\r\n');
const ev = (lines) => ['BEGIN:VEVENT', ...lines, 'END:VEVENT'];
const win = (a, b) => ({ fromMs: Date.parse(a), toMs: Date.parse(b), tz: TZ });
const localStr = (ms) => new Date(ms).toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16);

test('webcal URLs become https', () => {
  assert.equal(normalizeFeedUrl('webcal://p55-caldav.icloud.com/published/2/abc'), 'https://p55-caldav.icloud.com/published/2/abc');
  assert.equal(normalizeFeedUrl(' https://calendar.google.com/x.ics '), 'https://calendar.google.com/x.ics');
});

test('timed event with TZID, folded lines and escaped text', () => {
  const t = cal(ev(['UID:a1', 'DTSTART;TZID=America/Chicago:20261103T170000', 'DTEND;TZID=America/Chicago:20261103T183000', 'SUMMARY:Soccer\\, practice', ' at the park', 'LOCATION:Field 3\\nNorth']));
  const [e] = expandIcs(t, win('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'));
  assert.equal(e.title, 'Soccer, practiceat the park');
  assert.equal(e.loc, 'Field 3\nNorth');
  assert.equal(localStr(e.start), '2026-11-03 17:00');
  assert.equal(e.end - e.start, 90 * 60e3);
});

test('UTC and all-day events', () => {
  const t = cal(ev(['UID:u', 'DTSTART:20261110T150000Z', 'DTEND:20261110T160000Z', 'SUMMARY:Call']), ev(['UID:d', 'DTSTART;VALUE=DATE:20261126', 'DTEND;VALUE=DATE:20261128', 'SUMMARY:Thanksgiving break']));
  const out = expandIcs(t, win('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'));
  const call = out.find((e) => e.uid === 'u'), day = out.find((e) => e.uid === 'd');
  assert.equal(localStr(call.start), '2026-11-10 09:00');
  assert.deepEqual([day.allDay, day.start, day.end], [true, '2026-11-26', '2026-11-28']);
});

test('weekly RRULE keeps local time across the DST change', () => {
  const t = cal(ev(['UID:w', 'DTSTART;TZID=America/Chicago:20261026T183000', 'DURATION:PT1H', 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE', 'SUMMARY:Swim']));
  const out = expandIcs(t, win('2026-10-25T00:00:00Z', '2026-11-12T12:00:00Z'));
  assert.deepEqual(out.map((e) => localStr(e.start)), ['2026-10-26 18:30', '2026-10-28 18:30', '2026-11-02 18:30', '2026-11-04 18:30', '2026-11-09 18:30', '2026-11-11 18:30']);
  // offset changes from -5 to -6 on Nov 1
  assert.equal(out[0].start, Date.parse('2026-10-26T23:30:00Z'));
  assert.equal(out[2].start, Date.parse('2026-11-03T00:30:00Z'));
});

test('COUNT, INTERVAL and UNTIL', () => {
  const t = cal(
    ev(['UID:c', 'DTSTART;TZID=America/Chicago:20261001T080000', 'RRULE:FREQ=DAILY;INTERVAL=2;COUNT=3', 'SUMMARY:C']),
    ev(['UID:u', 'DTSTART;TZID=America/Chicago:20261001T080000', 'RRULE:FREQ=WEEKLY;UNTIL=20261015T130000Z', 'SUMMARY:U']),
  );
  const out = expandIcs(t, win('2026-09-01T00:00:00Z', '2026-12-01T00:00:00Z'));
  assert.deepEqual(out.filter((e) => e.uid === 'c').map((e) => localStr(e.start).slice(0, 10)), ['2026-10-01', '2026-10-03', '2026-10-05']);
  assert.deepEqual(out.filter((e) => e.uid === 'u').map((e) => localStr(e.start).slice(0, 10)), ['2026-10-01', '2026-10-08', '2026-10-15']);
});

test('EXDATE, RECURRENCE-ID move and cancelled instance', () => {
  const t = cal(
    ev(['UID:r', 'DTSTART;TZID=America/Chicago:20261102T160000', 'DTEND;TZID=America/Chicago:20261102T170000', 'RRULE:FREQ=DAILY;COUNT=5', 'EXDATE;TZID=America/Chicago:20261103T160000', 'SUMMARY:Piano']),
    ev(['UID:r', 'RECURRENCE-ID;TZID=America/Chicago:20261104T160000', 'DTSTART;TZID=America/Chicago:20261104T180000', 'DTEND;TZID=America/Chicago:20261104T190000', 'SUMMARY:Piano (moved)']),
    ev(['UID:r', 'RECURRENCE-ID;TZID=America/Chicago:20261105T160000', 'DTSTART;TZID=America/Chicago:20261105T160000', 'STATUS:CANCELLED', 'SUMMARY:Piano']),
  );
  const out = expandIcs(t, win('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'));
  assert.deepEqual(out.map((e) => `${localStr(e.start)} ${e.title}`), ['2026-11-02 16:00 Piano', '2026-11-04 18:00 Piano (moved)', '2026-11-06 16:00 Piano']);
});

test('monthly by ordinal weekday, last weekday, and yearly by month', () => {
  const t = cal(
    ev(['UID:m', 'DTSTART;TZID=America/Chicago:20260914T190000', 'RRULE:FREQ=MONTHLY;BYDAY=2MO', 'SUMMARY:PTA']),
    ev(['UID:l', 'DTSTART;VALUE=DATE:20260925', 'RRULE:FREQ=MONTHLY;BYDAY=-1FR', 'SUMMARY:Last Friday']),
    ev(['UID:y', 'DTSTART;VALUE=DATE:20151126', 'RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=4TH', 'SUMMARY:Thanksgiving']),
    ev(['UID:b', 'DTSTART;VALUE=DATE:20100314', 'RRULE:FREQ=YEARLY', 'SUMMARY:Birthday']),
  );
  const out = expandIcs(t, win('2026-10-01T05:00:00Z', '2027-04-01T05:00:00Z'));
  const pick = (u) => out.filter((e) => e.uid === u).map((e) => (e.allDay ? e.start : localStr(e.start).slice(0, 10)));
  assert.deepEqual(pick('m'), ['2026-10-12', '2026-11-09', '2026-12-14', '2027-01-11', '2027-02-08', '2027-03-08']);
  assert.deepEqual(pick('l'), ['2026-10-30', '2026-11-27', '2026-12-25', '2027-01-29', '2027-02-26', '2027-03-26']);
  assert.deepEqual(pick('y'), ['2026-11-26']);
  assert.deepEqual(pick('b'), ['2027-03-14']);
});

test('monthly on the 31st skips short months; weekdays rule', () => {
  const t = cal(
    ev(['UID:x', 'DTSTART;VALUE=DATE:20261031', 'RRULE:FREQ=MONTHLY', 'SUMMARY:31st']),
    ev(['UID:wd', 'DTSTART;TZID=America/Chicago:20261030T073000', 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', 'SUMMARY:Bus']),
  );
  const out = expandIcs(t, win('2026-10-30T05:00:00Z', '2027-01-01T06:00:00Z'));
  assert.deepEqual(out.filter((e) => e.uid === 'x').map((e) => e.start), ['2026-10-31', '2026-12-31']);
  const bus = out.filter((e) => e.uid === 'wd').map((e) => localStr(e.start).slice(0, 10));
  assert.equal(bus[0], '2026-10-30');
  assert.equal(bus[1], '2026-11-02');
  assert.ok(bus.every((d) => ![0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay())));
});

test('old daily series fast-forwards and stays aligned to INTERVAL', () => {
  const t = cal(ev(['UID:o', 'DTSTART;TZID=America/Chicago:20200101T200000', 'RRULE:FREQ=DAILY;INTERVAL=3', 'SUMMARY:Old']));
  const out = expandIcs(t, win('2026-11-01T05:00:00Z', '2026-11-10T06:00:00Z'));
  for (const e of out) {
    const days = Math.round((Date.parse(localStr(e.start).slice(0, 10)) - Date.parse('2020-01-01')) / 86400000);
    assert.equal(days % 3, 0);
  }
  assert.ok(out.length >= 2 && out.length <= 4);
});

test('Windows and Mozilla TZIDs resolve', () => {
  const t = cal(
    ev(['UID:w', 'DTSTART;TZID="Central Standard Time":20261201T090000', 'SUMMARY:W']),
    ev(['UID:z', 'DTSTART;TZID=/mozilla.org/20050126_1/America/New_York:20261201T090000', 'SUMMARY:Z']),
  );
  const out = expandIcs(t, win('2026-11-30T00:00:00Z', '2026-12-03T00:00:00Z'));
  assert.equal(localStr(out.find((e) => e.uid === 'w').start), '2026-12-01 09:00');
  assert.equal(localStr(out.find((e) => e.uid === 'z').start), '2026-12-01 08:00');
});

test('tz helpers: spring-forward gap and fall-back overlap', () => {
  assert.equal(zonedToUtc(2027, 3, 14, 2, 30, 0, TZ), Date.parse('2027-03-14T08:30:00Z')); // 3:30 CDT
  assert.equal(zonedToUtc(2026, 11, 1, 1, 30, 0, TZ), Date.parse('2026-11-01T06:30:00Z')); // first 1:30 (CDT)
  assert.equal(dayKey(Date.parse('2026-10-27T04:30:00Z'), TZ), '2026-10-26');
});

test('rrule parser', () => {
  const r = parseRrule('FREQ=MONTHLY;INTERVAL=2;BYDAY=-1FR,2MO;BYSETPOS=1;WKST=SU');
  assert.equal(r.interval, 2); assert.equal(r.wkst, 0);
  assert.deepEqual(r.byday, [{ n: -1, wd: 5 }, { n: 2, wd: 1 }]);
});
