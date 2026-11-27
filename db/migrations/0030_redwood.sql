-- The career-site detector matched "Redwood Extended Care Facility" (a care home) to Redwood
-- Software's job board. Keep the board under Redwood Software's own name and unlink the care home.
UPDATE mca.sponsor_record SET company_id = NULL WHERE employer_norm LIKE 'REDWOOD EXTENDED CARE%';
UPDATE mca.company SET name = 'Redwood Software', name_norm = 'REDWOOD SOFTWARE',
       aliases = ARRAY(SELECT a FROM unnest(aliases) a WHERE a NOT LIKE 'REDWOOD EXTENDED CARE%')
 WHERE ats_vendor = 'greenhouse' AND ats_board = 'redwoodsoftware' AND source = 'discovered';
