-- Local "Family" calendar: events created on the wall or a phone (PIN), merged into calendar views.
CREATE TABLE IF NOT EXISTS family_events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  person_id INTEGER,
  all_day INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,          -- first day, YYYY-MM-DD (local)
  end_date TEXT NOT NULL,      -- last day (inclusive), YYYY-MM-DD
  start_time TEXT NOT NULL DEFAULT '',  -- HH:MM local, '' for all-day
  end_time TEXT NOT NULL DEFAULT '',
  repeat TEXT NOT NULL DEFAULT 'none',  -- none | weekly | monthly | yearly
  until TEXT NOT NULL DEFAULT '',       -- last repeat day (inclusive), '' = forever
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS family_events_date ON family_events(date);
