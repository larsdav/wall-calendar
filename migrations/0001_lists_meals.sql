-- Step 1: shared grocery / to-do lists and the weekly meal plan. Additive only.
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🛒', kind TEXT NOT NULL DEFAULT 'grocery',
  sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS list_items (
  id INTEGER PRIMARY KEY, list_id INTEGER NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  done_at INTEGER, source TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS list_items_list ON list_items (list_id, done);
CREATE TABLE IF NOT EXISTS meals (
  day TEXT NOT NULL, slot TEXT NOT NULL, title TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '',
  ingredients TEXT NOT NULL DEFAULT '[]', note TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, slot));
INSERT INTO lists (name, emoji, kind, sort, created_at) SELECT 'Groceries', '🛒', 'grocery', 0, CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE NOT EXISTS (SELECT 1 FROM lists);
INSERT INTO lists (name, emoji, kind, sort, created_at) SELECT 'To-do', '📝', 'todo', 1, CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE (SELECT COUNT(*) FROM lists) = 1;
