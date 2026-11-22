// Company-name normalisation for matching job-board names against legal names in
// government files. Must stay in sync with jobs/lifevector_jobs/names.py (tested on both sides).

const SUFFIXES = new Set([
  "INC", "INCORPORATED", "LLC", "L L C", "LTD", "LIMITED", "CORP", "CORPORATION", "CO", "COMPANY",
  "LP", "LLP", "PLC", "PC", "PLLC", "GMBH", "AG", "BV", "NV", "SA", "SAS", "SARL", "SRL", "PTY",
  "ULC", "THE",
]);

export function normalizeCompanyName(name: string): string {
  const cleaned = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip accents
    .toUpperCase()
    .replace(/\./g, "") // "S.A." -> "SA", "Inc." -> "Inc"
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter(Boolean);
  // Drop legal suffixes from the end (repeatedly: "FOO HOLDINGS CO LTD") and a leading "THE".
  while (tokens.length > 1 && SUFFIXES.has(tokens[tokens.length - 1]!)) tokens.pop();
  if (tokens.length > 1 && tokens[0] === "THE") tokens.shift();
  return tokens.join(" ");
}
