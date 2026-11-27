-- Boards that discovery guessed on systems that don't report a company name well enough (Personio,
-- BambooHR, Rippling, Teamtailor, Breezy) turned out to be unrelated firms ("Dell Usa" on Personio,
-- a Swedish "Humana" on Teamtailor). Stop reading them, close their jobs, and unlink the sponsor
-- records so they can match the right company.
UPDATE mca.job SET status = 'closed'
 WHERE status = 'open' AND company_id IN (SELECT id FROM mca.company WHERE source = 'discovered'
   AND ats_vendor IN ('personio', 'bamboohr', 'rippling', 'teamtailor', 'breezy'));
UPDATE mca.sponsor_record SET company_id = NULL
 WHERE company_id IN (SELECT id FROM mca.company WHERE source = 'discovered' AND ats_vendor IN ('personio', 'bamboohr', 'rippling', 'teamtailor', 'breezy'));
DELETE FROM mca.board_discovery WHERE found_vendor IN ('personio', 'bamboohr', 'rippling', 'teamtailor', 'breezy');
UPDATE mca.company SET ats_vendor = NULL, ats_board = NULL
 WHERE source = 'discovered' AND ats_vendor IN ('personio', 'bamboohr', 'rippling', 'teamtailor', 'breezy');
