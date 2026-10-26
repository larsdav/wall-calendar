import test from 'node:test';
import assert from 'node:assert/strict';
import { nextOccurrence, upcomingCountdowns, cleanCountdown, cleanIds, daysBetween } from '../src/logic.js';

test('yearly dates roll to the next occurrence', () => {
  assert.equal(nextOccurrence('2018-03-14', true, '2026-10-26'), '2027-03-14');
  assert.equal(nextOccurrence('2018-12-25', true, '2026-10-26'), '2026-12-25');
  assert.equal(nextOccurrence('2018-10-26', true, '2026-10-26'), '2026-10-26'); // today counts
  assert.equal(nextOccurrence('2016-02-29', true, '2026-10-26'), '2027-02-28'); // leap-day birthday
  assert.equal(nextOccurrence('2016-02-29', true, '2027-10-26'), '2028-02-29');
  assert.equal(nextOccurrence('2026-12-20', false, '2026-10-26'), '2026-12-20');
});

test('upcoming countdowns sort soonest first and past one-offs last', () => {
  const out = upcomingCountdowns([
    { id: 1, date: '2026-12-20', yearly: false }, { id: 2, date: '2020-11-01', yearly: true },
    { id: 3, date: '2026-10-01', yearly: false }, { id: 4, date: '2026-10-26', yearly: false }], '2026-10-26');
  assert.deepEqual(out.map((c) => [c.id, c.days]), [[4, 0], [2, 6], [1, 55], [3, -25]]);
  assert.equal(daysBetween('2026-10-31', '2026-11-02'), 2); // across the DST change
});

test('cleanCountdown validates', () => {
  assert.equal(cleanCountdown({ title: '', date: '2026-12-01' }, []).error, 'Give it a name');
  assert.equal(cleanCountdown({ title: 'Trip', date: '12/01' }, []).error, 'Pick a date');
  assert.deepEqual(cleanCountdown({ title: 'Emma turns 8', date: '2018-03-14', yearly: 1, person_id: 3, emoji: '🎂' }, [3]).countdown, { title: 'Emma turns 8', emoji: '🎂', date: '2018-03-14', yearly: 1, person_id: 3 });
  assert.deepEqual(cleanIds([1, '2', 2, 9], [1, 2]), [1, 2]);
});
