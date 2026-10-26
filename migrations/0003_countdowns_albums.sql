-- Countdowns (one-off or yearly, optionally tied to a person) and photo albums.
CREATE TABLE IF NOT EXISTS countdowns (
  id INTEGER PRIMARY KEY, title TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '🎉', date TEXT NOT NULL,
  yearly INTEGER NOT NULL DEFAULT 0, person_id INTEGER, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS albums (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '📁', sort INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS photo_albums (
  photo_id INTEGER NOT NULL, album_id INTEGER NOT NULL, PRIMARY KEY (photo_id, album_id));
CREATE INDEX IF NOT EXISTS photo_albums_album ON photo_albums (album_id);
