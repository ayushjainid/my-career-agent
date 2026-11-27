-- CVS Health publishes its jobs on its own career site (read through its sitemap); stop fetching its
-- Workday board, which Workday refuses from our servers.
UPDATE mca.company SET ats_vendor = NULL, ats_board = NULL, aliases = '{}'
 WHERE ats_vendor = 'workday' AND ats_board = 'cvshealth.wd1.myworkdayjobs.com/CVS_Health_Careers';
