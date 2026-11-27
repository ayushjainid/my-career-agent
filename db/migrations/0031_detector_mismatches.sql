-- Two matches from the UK detector run made before the stricter homepage check: "Bauer Radio" was
-- linked to Bauer Hockey's board and "APS Polymer" to a different APS. Unlink and stop reading them.
UPDATE mca.sponsor_record SET company_id = NULL WHERE employer_norm IN ('BAUER RADIO', 'APS POLYMER');
UPDATE mca.job SET status = 'closed' WHERE status = 'open' AND company_id IN (
  SELECT id FROM mca.company WHERE source = 'discovered' AND ((ats_vendor = 'greenhouse' AND ats_board = 'bauerhockeycascademaveriklacrosse')
     OR (ats_vendor = 'sitemap' AND ats_board = 'https://careers.aps.com/sitemap.xml|/job')));
UPDATE mca.company SET ats_vendor = NULL, ats_board = NULL
 WHERE source = 'discovered' AND ((ats_vendor = 'greenhouse' AND ats_board = 'bauerhockeycascademaveriklacrosse')
     OR (ats_vendor = 'sitemap' AND ats_board = 'https://careers.aps.com/sitemap.xml|/job'));
