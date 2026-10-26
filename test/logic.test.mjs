import test from 'node:test';
import assert from 'node:assert/strict';
import { isDue, todayBoard, balances, rewardProgress, checkRedeem, streak, cleanTask, cleanReward } from '../src/logic.js';

const kids = [{ id: 1, name: 'A' }, { id: 2, name: 'B' }];
const bedtime = { id: 10, title: 'Bedtime', recur: 'daily', stars: 1, assignees: [1, 2], active: 1 };
const dishes = { id: 11, title: 'Dishes', recur: 'weekdays', stars: 2, assignees: [1], active: 1 };
const trash = { id: 12, title: 'Trash', recur: 'weekly', days: [2], stars: 3, assignees: [2], active: 1 };
const once = { id: 13, title: 'Science fair', recur: 'once', date: '2026-10-31', stars: 5, assignees: [1], active: 1 };

test('isDue for each recurrence', () => {
  assert.ok(isDue(bedtime, '2026-10-25'));
  assert.ok(isDue(dishes, '2026-10-26')); assert.ok(!isDue(dishes, '2026-10-25'));
  assert.ok(isDue(trash, '2026-10-27')); assert.ok(!isDue(trash, '2026-10-28'));
  assert.ok(isDue(once, '2026-10-31')); assert.ok(!isDue(once, '2026-11-01'));
  assert.ok(!isDue({ ...bedtime, active: 0 }, '2026-10-25'));
});

test('todayBoard groups per person with status', () => {
  const b = todayBoard([bedtime, dishes, trash], [{ id: 1, task_id: 10, person_id: 1, day: '2026-10-26', status: 'done' }, { id: 2, task_id: 10, person_id: 2, day: '2026-10-26', status: 'pending' }], kids, '2026-10-26');
  assert.deepEqual(b[0].items.map((i) => [i.task.title, i.status]), [['Bedtime', 'done'], ['Dishes', 'todo']]);
  assert.deepEqual(b[1].items.map((i) => [i.task.title, i.status]), [['Bedtime', 'pending']]);
  assert.equal(b[0].doneCount, 1);
});

const L = (person_id, delta, kind, task_id, created_at) => ({ person_id, delta, kind, task_id, created_at });

test('balances sum earn and redeem entries', () => {
  assert.deepEqual(balances([L(1, 1, 'earn', 10, 1), L(1, 2, 'earn', 11, 2), L(1, -3, 'redeem', null, 3), L(2, 1, 'earn', 10, 4)]), { 1: 0, 2: 1 });
});

test('per-kid reward from general balance', () => {
  const reward = { id: 100, cost: 5, scope: 'kid', person_ids: [], task_ids: [] };
  const ledger = [1, 2, 3, 4].map((t) => L(1, 1, 'earn', 10, t));
  let p = rewardProgress(reward, ledger, [], kids);
  assert.deepEqual(p.kids.map((k) => [k.have, k.ready]), [[4, false], [0, false]]);
  ledger.push(L(1, 1, 'earn', 10, 5));
  assert.equal(checkRedeem(reward, ledger, [], kids, 1).ok, true);
  assert.equal(checkRedeem(reward, ledger, [], kids, 1).ledgerDelta, -5);
  assert.match(checkRedeem(reward, ledger, [], kids, 2).error, /5 more/);
});

test('linked reward counts only linked task stars since its last redemption', () => {
  const reward = { id: 101, cost: 5, scope: 'kid', person_ids: [1], task_ids: [10] };
  const ledger = [L(1, 2, 'earn', 11, 1), L(1, 2, 'earn', 11, 2), ...[3, 4, 5].map((t) => L(1, 1, 'earn', 10, t))];
  let p = rewardProgress(reward, ledger, [], kids);
  assert.equal(p.kids.length, 1);
  assert.equal(p.kids[0].have, 3); // only bedtime stars
  ledger.push(L(1, 1, 'earn', 10, 6), L(1, 1, 'earn', 10, 7));
  assert.ok(checkRedeem(reward, ledger, [], kids, 1).ok);
  ledger.push(L(1, -5, 'redeem', null, 8));
  const red = [{ reward_id: 101, person_id: 1, created_at: 8 }];
  p = rewardProgress(reward, ledger, red, kids);
  assert.equal(p.kids[0].have, 0); // resets after redemption, balance left = 4 general stars
  assert.equal(balances(ledger)[1], 4);
  assert.match(checkRedeem(reward, ledger, red, kids, 2).error, /not for/);
});

test('linked progress never exceeds the spendable balance', () => {
  const reward = { id: 102, cost: 3, scope: 'kid', person_ids: [], task_ids: [10] };
  const ledger = [L(1, 1, 'earn', 10, 1), L(1, 1, 'earn', 10, 2), L(1, 1, 'earn', 10, 3), L(1, -2, 'redeem', null, 4)];
  assert.equal(rewardProgress(reward, ledger, [], kids).kids[0].have, 1);
});

test('family reward pools stars and does not deduct balances', () => {
  const reward = { id: 103, cost: 4, scope: 'family', person_ids: [], task_ids: [] };
  const ledger = [L(1, 2, 'earn', 11, 1), L(2, 1, 'earn', 10, 2)];
  assert.deepEqual(rewardProgress(reward, ledger, [], kids), { scope: 'family', cost: 4, have: 3, ready: false });
  ledger.push(L(2, 1, 'earn', 10, 3));
  const r = checkRedeem(reward, ledger, [], kids, null);
  assert.deepEqual(r, { ok: true, ledgerDelta: 0 });
  assert.equal(rewardProgress(reward, ledger, [{ reward_id: 103, person_id: null, created_at: 3 }], kids).have, 0);
});

test('streak counts back from today or yesterday', () => {
  const c = ['2026-10-23', '2026-10-24', '2026-10-25'].map((day) => ({ task_id: 10, person_id: 1, day, status: 'done' }));
  assert.equal(streak(c, 10, 1, '2026-10-26'), 3);
  assert.equal(streak([...c, { task_id: 10, person_id: 1, day: '2026-10-26', status: 'done' }], 10, 1, '2026-10-26'), 4);
  assert.equal(streak(c, 10, 2, '2026-10-26'), 0);
});

test('task and reward validation', () => {
  assert.match(cleanTask({ title: '', assignees: [1] }, [1]).error, /name/);
  assert.match(cleanTask({ title: 'x', recur: 'weekly', assignees: [1] }, [1]).error, /day/);
  assert.match(cleanTask({ title: 'x', assignees: [9] }, [1]).error, /Assign/);
  const ok = cleanTask({ title: ' Bed ', stars: '1', recur: 'daily', assignees: [1, 9] }, [1]);
  assert.deepEqual([ok.task.title, ok.task.stars, ok.task.assignees], ['Bed', 1, [1]]);
  assert.match(cleanReward({ name: 'Ice cream', cost: 0 }, [], []).error, /at least 1/);
  assert.equal(cleanReward({ name: 'Movie', cost: 10, scope: 'family', task_ids: [5, 6] }, [], [5]).reward.task_ids.length, 1);
});
