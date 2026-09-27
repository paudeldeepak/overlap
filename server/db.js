import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* Three tables. An event's responses go with it when it is deleted, so removing an
   event by hand is a single statement:

     DELETE FROM events WHERE id = 'abc123';

   The trigger does that cleanup even in a sqlite3 shell, where foreign keys are off
   unless you turn them on. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,   -- sha256 of the browser's session cookie
  created    INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  created    INTEGER NOT NULL,
  owner_id   TEXT NOT NULL REFERENCES people(id),
  owner_name TEXT CHECK (owner_name IS NULL OR length(owner_name) <= 40)
) STRICT;

CREATE TABLE IF NOT EXISTS responses (
  event_id  TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id),
  name      TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  dates     TEXT NOT NULL CHECK (json_valid(dates) AND json_type(dates) = 'array'),
  updated   INTEGER NOT NULL,
  PRIMARY KEY (event_id, person_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_delete_responses AFTER DELETE ON events
BEGIN
  DELETE FROM responses WHERE event_id = OLD.id;
END;
`;

export function openDb(file) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { enableForeignKeyConstraints: true, allowExtension: false });
  // Defensive mode blocks SQL that could corrupt the file (writable_schema and the like).
  if (typeof db.enableDefensive === 'function') db.enableDefensive(true);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA trusted_schema = OFF;
    PRAGMA secure_delete = ON;
  `);
  db.exec(SCHEMA);
  return db;
}

/* Every write runs through here: one IMMEDIATE transaction that takes the write lock
   up front, and is rolled back if anything inside throws. */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/* Reads that span more than one table see a single consistent snapshot. */
export function read(db, fn) {
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    db.exec('COMMIT');
  }
}

export const DEFAULT_DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'overlap.db');
