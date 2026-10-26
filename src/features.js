// Family features added after v1: lists, meal plan (and later routines, countdowns, albums, family events).
import { json, err, all, first, run, J, body } from './util.js';
import { cleanText, cleanEmoji, splitItems, newIngredients, cleanMeal, isDue, tickStep, cleanCountdown, cleanIds } from './logic.js';
import { dayKey } from './tz.js';

const MAX_LISTS = 12, MAX_ITEMS = 300;
const dayAdd = (k, n) => new Date(Date.parse(k + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);

export async function featureState(db, s, today) {
  const recent = Date.now() - 2 * 86400e3;
  const [lists, items, meals, progress, countdowns, albums, photoAlbums] = await Promise.all([
    all(db, 'SELECT id, name, emoji, kind, sort FROM lists ORDER BY sort, id'),
    all(db, 'SELECT id, list_id, text, done, done_at, source, created_at FROM list_items WHERE done = 0 OR done_at >= ? ORDER BY done, sort, id', recent),
    all(db, 'SELECT day, slot, title, emoji, ingredients, note FROM meals WHERE day >= ? AND day <= ? ORDER BY day', dayAdd(today, -14), dayAdd(today, 42)),
    all(db, 'SELECT task_id, person_id, day, done FROM routine_progress WHERE day = ?', today),
    all(db, 'SELECT id, title, emoji, date, yearly, person_id FROM countdowns ORDER BY date, id'),
    all(db, 'SELECT id, name, emoji, sort FROM albums ORDER BY sort, id'),
    all(db, 'SELECT photo_id, album_id FROM photo_albums'),
  ]);
  return { countdowns: countdowns.map((c) => ({ ...c, yearly: !!c.yearly })), albums, photo_albums: photoAlbums.map((r) => [r.photo_id, r.album_id]), routine_progress: progress.map((r) => ({ ...r, done: J(r.done, []) })), lists, list_items: items.map((i) => ({ ...i, done: !!i.done })), meals: meals.map((m) => ({ ...m, ingredients: J(m.ingredients, []) })) };
}

async function addItems(db, listId, texts, source) {
  const n = await first(db, 'SELECT COUNT(*) AS n FROM list_items WHERE list_id = ? AND done = 0', listId);
  if (n.n + texts.length > MAX_ITEMS) throw Object.assign(new Error(`A list can hold ${MAX_ITEMS} items`), { status: 400 });
  const now = Date.now();
  if (!texts.length) return [];
  const r = await db.batch(texts.map((t, i) => db.prepare('INSERT INTO list_items (list_id, text, done, source, sort, created_at) VALUES (?, ?, 0, ?, ?, ?)').bind(listId, t, source, now + i, now)));
  return r.map((x) => x.meta.last_row_id);
}

/** Returns a Response for feature routes, or null when the path isn't ours. Device auth is already checked. */
export async function featureApi({ req, db, path, m, s, parent }) {
  const needParent = () => (parent ? null : err(403, 'parent'));
  let pm;

  // ----- routines: kids tick steps (today only, no PIN); finishing the routine goes through /complete like any chore
  if (path === '/routine/step' && m === 'POST') {
    const b = await body(req);
    const task = await first(db, "SELECT * FROM tasks WHERE id = ? AND kind = 'routine'", +b.task_id);
    const person = await first(db, 'SELECT id FROM people WHERE id = ?', +b.person_id);
    if (!task || !person) return err(404, 'Not found');
    const t = { ...task, days: J(task.days, []), assignees: J(task.assignees, []), steps: J(task.steps, []) };
    const today = dayKey(Date.now(), s.tz);
    if (!t.assignees.includes(person.id) || !isDue(t, today)) return err(400, 'Not due today');
    const step = Math.round(+b.step);
    if (!(step >= 0 && step < t.steps.length)) return err(400, 'No such step');
    const cur = await first(db, 'SELECT done FROM routine_progress WHERE task_id = ? AND person_id = ? AND day = ?', t.id, person.id, today);
    const done = tickStep(J(cur && cur.done, []), step, !!b.done, t.steps.length);
    await run(db, 'INSERT INTO routine_progress (task_id, person_id, day, done, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (task_id, person_id, day) DO UPDATE SET done = excluded.done, updated_at = excluded.updated_at', t.id, person.id, today, JSON.stringify(done), Date.now());
    return json({ ok: true, done, all: done.length === t.steps.length });
  }

  // ----- countdowns (parents manage; everyone sees them)
  if (path === '/countdowns' && m === 'POST' || ((pm = /^\/countdowns\/(\d+)$/.exec(path)) && (m === 'PUT' || m === 'DELETE'))) {
    const g = needParent(); if (g) return g;
    if (m === 'DELETE') { await run(db, 'DELETE FROM countdowns WHERE id = ?', +pm[1]); return json({ ok: true }); }
    const ids = (await all(db, 'SELECT id FROM people')).map((p) => p.id);
    const { countdown: c, error } = cleanCountdown(await body(req), ids);
    if (error) return err(400, error);
    if (m === 'PUT') { await run(db, 'UPDATE countdowns SET title = ?, emoji = ?, date = ?, yearly = ?, person_id = ? WHERE id = ?', c.title, c.emoji, c.date, c.yearly, c.person_id, +pm[1]); return json({ ok: true }); }
    const n = await first(db, 'SELECT COUNT(*) AS n FROM countdowns');
    if (n.n >= 40) return err(400, 'Up to 40 countdowns');
    const r = await run(db, 'INSERT INTO countdowns (title, emoji, date, yearly, person_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', c.title, c.emoji, c.date, c.yearly, c.person_id, Date.now());
    return json({ ok: true, id: r.meta.last_row_id });
  }

  // ----- photo albums (parents only)
  if (path === '/albums' && m === 'POST' || ((pm = /^\/albums\/(\d+)$/.exec(path)) && (m === 'PUT' || m === 'DELETE'))) {
    const g = needParent(); if (g) return g;
    if (m === 'DELETE') {
      await db.batch([db.prepare('DELETE FROM albums WHERE id = ?').bind(+pm[1]), db.prepare('DELETE FROM photo_albums WHERE album_id = ?').bind(+pm[1])]);
      return json({ ok: true });
    }
    const b = await body(req);
    const name = cleanText(b.name, 40); if (!name) return err(400, 'Give the album a name');
    if (m === 'PUT') { await run(db, 'UPDATE albums SET name = ?, emoji = ? WHERE id = ?', name, cleanEmoji(b.emoji || '📁'), +pm[1]); return json({ ok: true }); }
    const n = await first(db, 'SELECT COUNT(*) AS n, COALESCE(MAX(sort), 0) AS s FROM albums');
    if (n.n >= 30) return err(400, 'Up to 30 albums');
    const r = await run(db, 'INSERT INTO albums (name, emoji, sort, created_at) VALUES (?, ?, ?, ?)', name, cleanEmoji(b.emoji || '📁'), n.s + 1, Date.now());
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if ((pm = /^\/photos\/(\d+)\/albums$/.exec(path)) && m === 'PUT') {
    const g = needParent(); if (g) return g;
    const pid = +pm[1];
    if (!(await first(db, 'SELECT id FROM photos WHERE id = ?', pid))) return err(404, 'Not found');
    const valid = (await all(db, 'SELECT id FROM albums')).map((a) => a.id);
    const ids = cleanIds((await body(req)).album_ids, valid);
    await db.batch([db.prepare('DELETE FROM photo_albums WHERE photo_id = ?').bind(pid), ...ids.map((a) => db.prepare('INSERT INTO photo_albums (photo_id, album_id) VALUES (?, ?)').bind(pid, a))]);
    return json({ ok: true, album_ids: ids });
  }

  // ----- lists: anyone on a connected screen can add / tick / clear items; parents manage the lists themselves
  if (path === '/lists' && m === 'POST') {
    const g = needParent(); if (g) return g;
    const b = await body(req);
    const name = cleanText(b.name, 40); if (!name) return err(400, 'Give the list a name');
    const n = await first(db, 'SELECT COUNT(*) AS n, COALESCE(MAX(sort), 0) AS s FROM lists');
    if (n.n >= MAX_LISTS) return err(400, `Up to ${MAX_LISTS} lists`);
    const r = await run(db, 'INSERT INTO lists (name, emoji, kind, sort, created_at) VALUES (?, ?, ?, ?, ?)', name, cleanEmoji(b.emoji || '📝'), b.kind === 'grocery' ? 'grocery' : 'todo', n.s + 1, Date.now());
    return json({ ok: true, id: r.meta.last_row_id });
  }
  if ((pm = /^\/lists\/(\d+)$/.exec(path))) {
    const g = needParent(); if (g) return g;
    const id = +pm[1];
    if (m === 'PUT') {
      const b = await body(req);
      const name = cleanText(b.name, 40); if (!name) return err(400, 'Give the list a name');
      await run(db, 'UPDATE lists SET name = ?, emoji = ?, kind = ?, sort = COALESCE(?, sort) WHERE id = ?', name, cleanEmoji(b.emoji || '📝'), b.kind === 'grocery' ? 'grocery' : 'todo', Number.isFinite(+b.sort) && b.sort !== undefined ? Math.round(+b.sort) : null, id);
      return json({ ok: true });
    }
    if (m === 'DELETE') {
      await db.batch([db.prepare('DELETE FROM list_items WHERE list_id = ?').bind(id), db.prepare('DELETE FROM lists WHERE id = ?').bind(id)]);
      return json({ ok: true });
    }
  }
  if ((pm = /^\/lists\/(\d+)\/(items|clear)$/.exec(path)) && m === 'POST') {
    const list = await first(db, 'SELECT id FROM lists WHERE id = ?', +pm[1]);
    if (!list) return err(404, 'That list was removed');
    if (pm[2] === 'clear') { const r = await run(db, 'DELETE FROM list_items WHERE list_id = ? AND done = 1', list.id); return json({ ok: true, removed: r.meta.changes }); }
    const b = await body(req);
    const texts = splitItems(b.text);
    if (!texts.length) return err(400, 'Type something to add');
    return json({ ok: true, ids: await addItems(db, list.id, texts, null) });
  }
  if ((pm = /^\/items\/(\d+)$/.exec(path))) {
    const id = +pm[1];
    if (m === 'PUT') {
      const b = await body(req);
      const it = await first(db, 'SELECT * FROM list_items WHERE id = ?', id);
      if (!it) return err(404, 'That item is gone');
      const text = 'text' in b ? cleanText(b.text, 80) || it.text : it.text;
      const done = 'done' in b ? (b.done ? 1 : 0) : it.done;
      await run(db, 'UPDATE list_items SET text = ?, done = ?, done_at = ? WHERE id = ?', text, done, done ? (it.done ? it.done_at : Date.now()) : null, id);
      return json({ ok: true });
    }
    if (m === 'DELETE') { await run(db, 'DELETE FROM list_items WHERE id = ?', id); return json({ ok: true }); }
  }

  // ----- meal plan: parents edit; anyone can send a meal's ingredients to a list
  if (path === '/meals' && m === 'PUT') {
    const g = needParent(); if (g) return g;
    const { meal, error } = cleanMeal(await body(req));
    if (error) return err(400, error);
    if (!meal.title) { await run(db, 'DELETE FROM meals WHERE day = ? AND slot = ?', meal.day, meal.slot); return json({ ok: true, removed: true }); }
    await run(db, 'INSERT INTO meals (day, slot, title, emoji, ingredients, note, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(day, slot) DO UPDATE SET title = excluded.title, emoji = excluded.emoji, ingredients = excluded.ingredients, note = excluded.note, updated_at = excluded.updated_at',
      meal.day, meal.slot, meal.title, meal.emoji, JSON.stringify(meal.ingredients), meal.note, Date.now());
    return json({ ok: true });
  }
  if (path === '/meals/to-list' && m === 'POST') {
    const b = await body(req);
    const list = await first(db, 'SELECT id, name FROM lists WHERE id = ?', +b.list_id);
    if (!list) return err(404, 'Pick a list');
    const days = (Array.isArray(b.days) ? b.days : [b.day]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '')).slice(0, 14);
    if (!days.length) return err(400, 'Pick a day');
    const meals = await all(db, `SELECT day, slot, title, ingredients FROM meals WHERE day IN (${days.map(() => '?').join(',')})`, ...days);
    const pick = meals.filter((x) => !b.slot || x.slot === b.slot);
    const wanted = pick.flatMap((x) => J(x.ingredients, []));
    const open = await all(db, 'SELECT text FROM list_items WHERE list_id = ? AND done = 0', list.id);
    const add = newIngredients(wanted, open);
    await addItems(db, list.id, add, pick.length === 1 ? pick[0].title.slice(0, 60) : 'Meal plan');
    return json({ ok: true, added: add.length, skipped: wanted.length - add.length, list: list.name });
  }
  return null;
}
