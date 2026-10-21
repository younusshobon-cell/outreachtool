
CREATE TABLE settings (tenant_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(tenant_id,key));
CREATE TABLE google_account (tenant_id TEXT NOT NULL, id INTEGER NOT NULL DEFAULT 1 CHECK(id=1), email TEXT, access_token TEXT, refresh_token TEXT, expires_at INTEGER, scope TEXT, connected_at INTEGER, PRIMARY KEY(tenant_id,id));
CREATE TABLE scheduler_locks (tenant_id TEXT NOT NULL, id TEXT NOT NULL, token TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(tenant_id,id));
CREATE TABLE mailboxes (tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', host TEXT NOT NULL, port INTEGER NOT NULL CHECK(port IN(465,587)), username TEXT NOT NULL, password_enc TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0, verified_at INTEGER, created_at INTEGER NOT NULL, UNIQUE(tenant_id,email));
CREATE TABLE microsoft_account (tenant_id TEXT PRIMARY KEY, email TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT, expires_at INTEGER, scope TEXT, connected_at INTEGER);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, password_hash TEXT NOT NULL, recovery_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE oauth_states (state_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_hash TEXT NOT NULL, provider TEXT NOT NULL, verifier_enc TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE auth_limits (key TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE app_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS businesses (tenant_id TEXT NOT NULL, 
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  owner       TEXT,
  email       TEXT NOT NULL,
  website     TEXT,
  city        TEXT,
  notes       TEXT,
  status      TEXT DEFAULT 'new',     
  created_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_biz_email  ON businesses(email);
CREATE INDEX IF NOT EXISTS idx_biz_status ON businesses(status);
CREATE TABLE IF NOT EXISTS templates (tenant_id TEXT NOT NULL, 
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  subject         TEXT NOT NULL,
  body            TEXT NOT NULL,
  followup_subject TEXT,
  followup_body   TEXT,
  followup_days   INTEGER DEFAULT 0,  
  created_at      INTEGER
);
CREATE TABLE IF NOT EXISTS campaigns (tenant_id TEXT NOT NULL, 
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  template_id  TEXT,
  sequence_json TEXT,
  mailbox_id TEXT,
  status       TEXT DEFAULT 'active', 
  start_at     INTEGER,
  gap_minutes  INTEGER DEFAULT 12,
  daily_cap    INTEGER DEFAULT 25,
  created_at   INTEGER
);
CREATE TABLE IF NOT EXISTS mails (tenant_id TEXT NOT NULL, 
  id             TEXT PRIMARY KEY,
  campaign_id    TEXT,
  mailbox_id     TEXT,
  business_id    TEXT,
  to_email       TEXT NOT NULL,
  to_name        TEXT,
  subject        TEXT,
  body           TEXT,
  step           INTEGER DEFAULT 1,   
  parent_id      TEXT,
  scheduled_at   INTEGER,
  status         TEXT DEFAULT 'queued', 
  sent_at        INTEGER,
  error          TEXT,
  gmail_id       TEXT,
  gmail_thread_id TEXT,
  created_at     INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mail_status ON mails(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_mail_camp   ON mails(campaign_id);
CREATE INDEX IF NOT EXISTS idx_mail_thread ON mails(gmail_thread_id);
CREATE TABLE IF NOT EXISTS replies (tenant_id TEXT NOT NULL, 
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
CREATE TABLE IF NOT EXISTS logs (tenant_id TEXT NOT NULL, 
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  at      INTEGER,
  level   TEXT,
  message TEXT
);
CREATE TABLE IF NOT EXISTS sequences (tenant_id TEXT NOT NULL, id TEXT PRIMARY KEY, name TEXT NOT NULL, steps_json TEXT NOT NULL, created_at INTEGER NOT NULL);
INSERT INTO app_migrations VALUES ('0004_saas',unixepoch()*1000);
