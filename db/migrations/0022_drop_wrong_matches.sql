-- Discovery matched "LinkedIn" to a Lever board that isn't LinkedIn's (Lever doesn't report a company
-- name, so the match was never confirmed). Stop reading it and close its jobs; the company row stays,
-- so discovery won't add the same board again.
UPDATE mca.job SET status = 'closed'
 WHERE status = 'open' AND company_id IN (SELECT id FROM mca.company WHERE source = 'discovered' AND name_norm = 'LINKEDIN');
UPDATE mca.company SET ats_vendor = NULL, ats_board = NULL WHERE source = 'discovered' AND name_norm = 'LINKEDIN';
