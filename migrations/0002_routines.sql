-- Routines are tasks with kind 'routine' and an ordered list of steps; per-day step ticks live in routine_progress.
ALTER TABLE tasks ADD COLUMN steps TEXT NOT NULL DEFAULT '[]';
CREATE TABLE IF NOT EXISTS routine_progress (
  task_id INTEGER NOT NULL, person_id INTEGER NOT NULL, day TEXT NOT NULL,
  done TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, person_id, day));
