-- Teamtailor, Personio, BambooHR, Rippling, Breezy, and career-site sitemaps with JobPosting data.
DO $$
DECLARE c text;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
   WHERE conrelid = 'mca.company'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ats_vendor%'
  LOOP EXECUTE format('ALTER TABLE mca.company DROP CONSTRAINT %I', c); END LOOP;
END $$;
ALTER TABLE mca.company ADD CONSTRAINT company_ats_vendor_check
  CHECK (ats_vendor IN ('greenhouse','lever','ashby','smartrecruiters','workable','workday','recruitee','amazon','eightfold','oracle',
                        'teamtailor','personio','bamboohr','rippling','breezy','sitemap','other'));
