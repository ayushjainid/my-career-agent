-- Recruitee joins the job-board systems the catalog reads (Workday, SmartRecruiters and Workable
-- were already allowed). The constraint was unnamed in 0001, so find it by its definition.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'mca.company'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%ats_vendor%';
  IF c IS NOT NULL THEN EXECUTE format('ALTER TABLE mca.company DROP CONSTRAINT %I', c); END IF;
END $$;
ALTER TABLE mca.company ADD CONSTRAINT company_ats_vendor_check
  CHECK (ats_vendor IN ('greenhouse','lever','ashby','smartrecruiters','workable','workday','recruitee','other'));
