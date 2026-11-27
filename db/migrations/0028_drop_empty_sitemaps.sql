-- SAP's and Caterpillar's sitemaps list no job pages in a form the reader recognises: stop fetching.
UPDATE mca.company SET ats_vendor = NULL, ats_board = NULL
 WHERE ats_vendor = 'sitemap' AND ats_board IN ('https://jobs.sap.com/sitemap.xml|/job/', 'https://careers.caterpillar.com/sitemap.xml|/job/');
