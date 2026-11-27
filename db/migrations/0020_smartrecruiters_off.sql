-- SmartRecruiters' API host asks every bot except LinkedIn's not to fetch it (robots.txt), so the
-- app no longer reads it. Close the jobs fetched from it earlier; the companies stay listed.
UPDATE mca.job SET status = 'closed' WHERE ats_vendor = 'smartrecruiters' AND status = 'open';
