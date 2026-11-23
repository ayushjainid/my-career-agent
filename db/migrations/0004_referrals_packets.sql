-- 0004: POC loops P4 (LinkedIn Connections import) and P5 (apply packet).

-- Re-importing a newer export updates people in place, so referral links and the
-- "last asked" date survive. The key is the profile URL, or the name when there is none.
ALTER TABLE mca.contact
  ADD COLUMN source_key text,
  ADD COLUMN company_norm text;
UPDATE mca.contact SET source_key = coalesce(lower(profile_url), 'name:' || lower(full_name)) WHERE source_key IS NULL;
ALTER TABLE mca.contact ALTER COLUMN source_key SET NOT NULL;
CREATE UNIQUE INDEX contact_user_key_idx ON mca.contact (user_id, source_key);
CREATE INDEX contact_company_idx ON mca.contact (user_id, company_id) WHERE company_id IS NOT NULL;

-- Matching contacts to the catalog reads company names and aliases by their normalised form.
CREATE INDEX IF NOT EXISTS company_name_norm_idx ON mca.company (name_norm);
CREATE INDEX IF NOT EXISTS company_aliases_idx ON mca.company USING gin (aliases);
