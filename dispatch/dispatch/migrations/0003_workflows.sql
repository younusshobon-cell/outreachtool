CREATE TABLE IF NOT EXISTS sequences (id TEXT PRIMARY KEY, name TEXT NOT NULL, steps_json TEXT NOT NULL, created_at INTEGER NOT NULL);
ALTER TABLE campaigns ADD COLUMN sequence_json TEXT;
ALTER TABLE campaigns ADD COLUMN mailbox_id TEXT;
ALTER TABLE replies ADD COLUMN category TEXT NOT NULL DEFAULT 'uncategorized';
CREATE TABLE IF NOT EXISTS scheduler_locks (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
