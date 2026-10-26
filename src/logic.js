// Pure logic for chores/habits scheduling, the star ledger and reward progress. No I/O.
import { parseDayKey, dayNum, weekday } from './tz.js';

export const RECURS = ['daily', 'weekdays', 'weekly', 'once'];
export const KINDS = ['chore', 'habit', 'activity'];

/** Is a task due on a given civil day ('YYYY-MM-DD')? */
export function isDue(task, day) {
  if (!task || task.active === false || task.active === 0) return false;
  const c = parseDayKey(day);
  if (!c) return false;
  const n = dayNum(c.y, c.m, c.d), wd = weekday(n);
  if (task.start_day && day < task.start_day) return false;
  switch (task.recur) {
    case 'daily': return true;
    case 'weekdays': return wd >= 1 && wd <= 5;
    case 'weekly': return Array.isArray(task.days) && task.days.length ? task.days.includes(wd) : wd === 6;
    case 'once': return task.date === day;
    default: return false;
  }
}

/** Tasks due for a person on a day, with their completion status. */
export function todayBoard(tasks, completions, people, day) {
  const done = new Map();
  for (const c of completions) if (c.day === day) done.set(`${c.task_id}|${c.person_id}`, c);
  return people.map((p) => {
    const items = tasks
      .filter((t) => isDue(t, day) && (t.assignees || []).includes(p.id))
      .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.title.localeCompare(b.title))
      .map((t) => { const c = done.get(`${t.id}|${p.id}`); return { task: t, status: c ? c.status : 'todo', completion_id: c ? c.id : null }; });
    return { person: p, items, doneCount: items.filter((i) => i.status === 'done').length };
  });
}

/** Star balance per person = sum of ledger deltas. */
export function balances(ledger) {
  const b = {};
  for (const e of ledger) b[e.person_id] = (b[e.person_id] || 0) + e.delta;
  return b;
}

/** Stars earned (earn entries only) by a person, optionally restricted to task ids, after a timestamp. */
export function earnedSince(ledger, personId, taskIds, sinceTs) {
  let s = 0;
  for (const e of ledger) {
    if (e.kind !== 'earn') continue;
    if (personId != null && e.person_id !== personId) continue;
    if (sinceTs != null && e.created_at <= sinceTs) continue;
    if (taskIds && taskIds.length && !taskIds.includes(e.task_id)) continue;
    s += e.delta;
  }
  return s;
}

function lastRedeemed(redemptions, rewardId, personId) {
  let t = null;
  for (const r of redemptions) if (r.reward_id === rewardId && (r.person_id ?? null) === (personId ?? null) && (t == null || r.created_at > t)) t = r.created_at;
  return t;
}

/**
 * Progress toward a reward.
 * - per-kid: stars come from the kid's balance. If the reward links tasks, only stars from those tasks
 *   earned since the kid last redeemed this reward count (and never more than the balance).
 *   Redeeming deducts `cost` from the balance.
 * - family: a team goal. All eligible kids' stars (from linked tasks, or all tasks) since the last family
 *   redemption add up. Redeeming resets the goal and does not touch personal balances.
 */
export function rewardProgress(reward, ledger, redemptions, kids) {
  const linked = reward.task_ids || [];
  const eligible = kids.filter((k) => !reward.person_ids || !reward.person_ids.length || reward.person_ids.includes(k.id));
  if (reward.scope === 'family') {
    const since = lastRedeemed(redemptions, reward.id, null);
    let have = 0;
    for (const k of eligible) have += earnedSince(ledger, k.id, linked, since);
    have = Math.max(0, have);
    return { scope: 'family', cost: reward.cost, have, ready: have >= reward.cost };
  }
  const bal = balances(ledger);
  return {
    scope: 'kid', cost: reward.cost,
    kids: eligible.map((k) => {
      const balance = Math.max(0, bal[k.id] || 0);
      const have = linked.length ? Math.max(0, Math.min(balance, earnedSince(ledger, k.id, linked, lastRedeemed(redemptions, reward.id, k.id)))) : balance;
      return { person_id: k.id, have, ready: have >= reward.cost };
    }),
  };
}

/** Validate a redeem request; returns { ok, error, ledgerDelta }. */
export function checkRedeem(reward, ledger, redemptions, kids, personId) {
  const p = rewardProgress(reward, ledger, redemptions, kids);
  if (reward.scope === 'family') return p.ready ? { ok: true, ledgerDelta: 0 } : { ok: false, error: `Needs ${reward.cost - p.have} more stars` };
  const k = p.kids.find((x) => x.person_id === personId);
  if (!k) return { ok: false, error: 'This reward is not for that person' };
  if (!k.ready) return { ok: false, error: `Needs ${reward.cost - k.have} more stars` };
  return { ok: true, ledgerDelta: -reward.cost };
}

/** Consecutive days (ending today, or yesterday if today isn't done yet) a person completed a task. */
export function streak(completions, taskId, personId, today) {
  const days = new Set(completions.filter((c) => c.task_id === taskId && c.person_id === personId && c.status === 'done').map((c) => c.day));
  const c = parseDayKey(today); if (!c) return 0;
  let n = dayNum(c.y, c.m, c.d);
  const key = (x) => { const d = new Date(x * 86400000); return d.toISOString().slice(0, 10); };
  if (!days.has(key(n))) n--;
  let s = 0;
  while (days.has(key(n))) { s++; n--; }
  return s;
}

// ---- validation helpers shared by the API ----
export const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
export function cleanText(s, max) { return String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
export function cleanEmoji(s) { const t = String(s ?? '').trim(); return [...t].slice(0, 4).join('') || '⭐'; }
export function cleanTask(b, personIds) {
  const t = {
    title: cleanText(b.title, 60), emoji: cleanEmoji(b.emoji || '✅'),
    kind: KINDS.includes(b.kind) ? b.kind : 'chore',
    stars: Math.max(0, Math.min(20, Math.round(+b.stars || 0))),
    recur: RECURS.includes(b.recur) ? b.recur : 'daily',
    days: Array.isArray(b.days) ? [...new Set(b.days.map(Number).filter((d) => d >= 0 && d <= 6))].sort() : [],
    date: /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') ? b.date : null,
    assignees: Array.isArray(b.assignees) ? b.assignees.map(Number).filter((id) => personIds.includes(id)) : [],
    part: ['morning', 'afternoon', 'evening', 'any'].includes(b.part) ? b.part : 'any',
  };
  if (!t.title) return { error: 'Give it a name' };
  if (t.recur === 'weekly' && !t.days.length) return { error: 'Pick at least one day of the week' };
  if (t.recur === 'once' && !t.date) return { error: 'Pick a date' };
  if (!t.assignees.length) return { error: 'Assign it to at least one person' };
  return { task: t };
}
export function cleanReward(b, personIds, taskIds) {
  const r = {
    name: cleanText(b.name, 60), description: cleanText(b.description, 200), emoji: cleanEmoji(b.emoji || '🎁'),
    cost: Math.max(1, Math.min(500, Math.round(+b.cost || 0))),
    scope: b.scope === 'family' ? 'family' : 'kid',
    person_ids: Array.isArray(b.person_ids) ? b.person_ids.map(Number).filter((id) => personIds.includes(id)) : [],
    task_ids: Array.isArray(b.task_ids) ? b.task_ids.map(Number).filter((id) => taskIds.includes(id)) : [],
  };
  if (!r.name) return { error: 'Give the reward a name' };
  if (!(+b.cost >= 1)) return { error: 'Star cost must be at least 1' };
  return { reward: r };
}
