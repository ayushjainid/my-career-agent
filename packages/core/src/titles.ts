// Job-title families for pay comparison: "Sr. Software Engineer II (Payments)" and "Software
// Engineer" belong to one family. Kept identical to jobs/my_career_agent_jobs/titles.py; both
// sides run test/fixtures/title_cases.json.

const LEVEL_WORDS = new Set([
  "senior", "sr", "junior", "jr", "lead", "principal", "staff", "distinguished", "associate", "entry", "level",
  "i", "ii", "iii", "iv", "v", "1", "2", "3", "4", "5", "intern", "head", "chief", "mid",
]);
const SYNONYMS: Array<[RegExp, string]> = [
  [/\bsoftware development engineer\b/g, "software engineer"],
  [/\bsde\b/g, "software engineer"],
  [/\bswe\b/g, "software engineer"],
  [/\bsoftware developer\b/g, "software engineer"],
  [/\bml\b/g, "machine learning"],
  [/\bmle\b/g, "machine learning engineer"],
  [/\bsre\b/g, "site reliability engineer"],
  [/\bpm\b/g, "product manager"],
];

export function titleFamily(title: string): string {
  let t = title.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
  t = t.replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[,/|].*$/, " ").replace(/[^a-z0-9 ]+/g, " ");
  for (const [re, to] of SYNONYMS) t = t.replace(re, to);
  return t.split(/\s+/).filter((w) => w && !LEVEL_WORDS.has(w)).join(" ").trim();
}
