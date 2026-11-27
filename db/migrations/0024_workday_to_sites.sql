-- Capital One, Adobe, Mastercard and Bank of America publish the same jobs on their own career
-- sites (read through their sitemaps); their Workday rows, which Workday refuses from our servers,
-- stop being fetched. Their aliases move to the new rows, so the old ones lose them.
UPDATE mca.company SET ats_vendor = NULL, ats_board = NULL, aliases = '{}'
 WHERE ats_vendor = 'workday' AND ats_board IN ('capitalone.wd12.myworkdayjobs.com/Capital_One', 'adobe.wd5.myworkdayjobs.com/external_experienced',
                                                'mastercard.wd1.myworkdayjobs.com/CorporateCareers', 'ghr.wd1.myworkdayjobs.com/Lateral-US');
