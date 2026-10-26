import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanSteps, tickStep, cleanTask } from '../src/logic.js';

test('cleanSteps parses lines with leading emoji and bullets', () => {
  assert.deepEqual(cleanSteps('🪥 Brush teeth\n- 👕 Get dressed\n\n3. Make bed\n🧑‍🍳Breakfast'), [
    { t: 'Brush teeth', e: '🪥' }, { t: 'Get dressed', e: '👕' }, { t: 'Make bed', e: '' }, { t: 'Breakfast', e: '🧑‍🍳' }]);
  assert.deepEqual(cleanSteps([{ t: 'Pajamas', e: '🩳' }, '', null]), [{ t: 'Pajamas', e: '🩳' }]);
  assert.equal(cleanSteps(Array.from({ length: 30 }, (_, i) => 'Step ' + i)).length, 15);
  assert.deepEqual(cleanSteps('nope'.repeat(0)), []);
});

test('tickStep adds, removes and drops out-of-range indexes', () => {
  assert.deepEqual(tickStep([2, 0], 1, true, 3), [0, 1, 2]);
  assert.deepEqual(tickStep([0, 1, 2], 1, false, 3), [0, 2]);
  assert.deepEqual(tickStep([0, 7, 'x'], 1, true, 3), [0, 1]); // stale index 7 dropped after steps were edited
});

test('cleanTask requires steps for routines and drops them for chores', () => {
  assert.equal(cleanTask({ title: 'Bedtime', kind: 'routine', assignees: [1] }, [1]).error, 'Add at least one step');
  const r = cleanTask({ title: 'Bedtime', kind: 'routine', assignees: [1], steps: '🛁 Bath\n🪥 Teeth' }, [1]);
  assert.equal(r.task.steps.length, 2);
  assert.deepEqual(cleanTask({ title: 'Bed', kind: 'chore', assignees: [1], steps: 'x' }, [1]).task.steps, []);
});
