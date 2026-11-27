-- Deloitte's US portal and Capital One's careers site give no location on some jobs; their boards
-- now carry a default country ("#US"), and jobs already stored without a place get it too.
UPDATE mca.company SET ats_board = ats_board || '#US'
 WHERE ats_vendor = 'avature' AND ats_board = 'https://apply.deloitte.com/careers';
UPDATE mca.job j SET location_text = 'United States', country = 'US'
  FROM mca.company c
 WHERE j.company_id = c.id AND c.ats_vendor = 'avature' AND c.ats_board = 'https://apply.deloitte.com/careers#US'
   AND (j.location_text IS NULL OR j.location_text = '');
