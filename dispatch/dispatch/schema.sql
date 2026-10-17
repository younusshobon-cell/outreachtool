-- Dispatch — Cloudflare D1 schema
-- Run:  npm run db:init        (remote)
--       npm run db:init:local  (local dev)

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Google OAuth tokens. Single row, id = 1.
CREATE TABLE IF NOT EXISTS google_account (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  email         TEXT,
  access_token  TEXT,
  refresh_token TEXT,
  expires_at    INTEGER,
  scope         TEXT,
  connected_at  INTEGER
);

CREATE TABLE IF NOT EXISTS businesses (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner       TEXT,
  email       TEXT NOT NULL,
  website     TEXT,
  city        TEXT,
  notes       TEXT,
  status      TEXT DEFAULT 'new',     -- new | queued | contacted | replied | bounced | unsubscribed
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_email  ON businesses(email);
CREATE INDEX IF NOT EXISTS idx_biz_status ON businesses(status);

CREATE TABLE IF NOT EXISTS templates (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  followup_subject TEXT,
  followup_body   TEXT,
  followup_days   INTEGER DEFAULT 0,  -- 0 = no follow-up
  created_at      INTEGER
);

CREATE TABLE IF NOT EXISTS campaigns (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  template_id  TEXT,
  sequence_json TEXT,
  mailbox_id TEXT,
  status       TEXT DEFAULT 'active', -- active | paused | done
  start_at     INTEGER,
  gap_minutes  INTEGER DEFAULT 12,
  daily_cap    INTEGER DEFAULT 25,
  created_at   INTEGER
);

CREATE TABLE IF NOT EXISTS mails (
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT,
  mailbox_id     TEXT,
  business_id    TEXT,
  to_email       TEXT NOT NULL,
  to_name        TEXT,
  subject        TEXT,
  body           TEXT,
  step           INTEGER DEFAULT 1,   -- 1 = first touch, 2 = follow-up
  parent_id      TEXT,
  scheduled_at   INTEGER,
  status         TEXT DEFAULT 'queued', -- queued | sending | sent | drafted | failed | cancelled | replied
  sent_at        INTEGER,
  error          TEXT,
  gmail_id       TEXT,
  gmail_thread_id TEXT,
  created_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mail_status ON mails(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_mail_camp   ON mails(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mail_thread ON mails(gmail_thread_id);

CREATE TABLE IF NOT EXISTS replies (
  id          TEXT PRIMARY KEY,
  mail_id     TEXT,
  business_id TEXT,
  thread_id   TEXT,
  from_email  TEXT,
  subject     TEXT,
  snippet     TEXT,
  body        TEXT,
  received_at INTEGER,
  category TEXT NOT NULL DEFAULT 'uncategorized',
  seen        INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_reply_seen ON replies(seen, received_at);

CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER,
  level   TEXT,
  message TEXT
);

-- Defaults
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('running',        'false'),
  ('mode',           'draft'),       -- draft = create Gmail drafts, send = actually send
  ('daily_cap',      '25'),
  ('gap_minutes',    '12'),
  ('window_start',   '9'),           -- hour of day, local
  ('window_end',     '18'),
  ('tz_offset',      '360'),         -- minutes ahead of UTC (Dhaka = 360)
  ('weekdays_only',  'true'),
  ('sender_name',    ''),
  ('signature',      ''),
  ('poll_replies',   'true');

CREATE TABLE IF NOT EXISTS mailboxes (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '',
 host TEXT NOT NULL, port INTEGER NOT NULL CHECK(port IN (465,587)), username TEXT NOT NULL,
 password_enc TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0,
 verified_at INTEGER, created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sequences (id TEXT PRIMARY KEY, name TEXT NOT NULL, steps_json TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS scheduler_locks (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires_at INTEGER NOT NULL);
