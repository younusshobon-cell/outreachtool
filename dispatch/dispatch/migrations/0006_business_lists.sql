ALTER TABLE businesses ADD COLUMN service_list TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_business_service_list ON businesses(tenant_id,service_list);
