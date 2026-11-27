-- freehire.me (public tech-job API): each job is filed under its own employer; employers first
-- met there are created with source 'freehire' and no board of their own.
ALTER TABLE mca.company DROP CONSTRAINT IF EXISTS company_source_check;
ALTER TABLE mca.company ADD CONSTRAINT company_source_check CHECK (source IN ('list', 'discovered', 'manual', 'freehire'));
