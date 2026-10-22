ALTER TABLE campaigns ADD COLUMN safety_reset_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN pause_reason TEXT;
CREATE TABLE delivery_incidents(tenant_id TEXT NOT NULL,campaign_id TEXT NOT NULL,mail_id TEXT NOT NULL,kind TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(tenant_id,campaign_id,mail_id));
CREATE INDEX delivery_incidents_campaign ON delivery_incidents(tenant_id,campaign_id,recorded_at);
