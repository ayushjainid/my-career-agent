// Field-by-field comparison of a parsed resume with the expected one. Used by the tests and by
// `npx tsx test/score.ts` to print a precision report.
import type { ParsedResume } from "../src/types.js";

export interface Score { correct: number; total: number; misses: string[] }

const norm = (s: unknown) => String(s ?? "").toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

export function score(got: ParsedResume, want: any): Score {
  const s: Score = { correct: 0, total: 0, misses: [] };
  const check = (label: string, a: unknown, b: unknown) => {
    s.total++;
    if (norm(a) === norm(b)) s.correct++;
    else s.misses.push(`${label}: got ${JSON.stringify(a ?? null)}, want ${JSON.stringify(b ?? null)}`);
  };
  for (const [k, v] of Object.entries(want.contact)) check(`contact.${k}`, (got.contact as any)[k], v);
  check("experience.count", got.experience.length, want.experience.length);
  want.experience.forEach((w: any, i: number) => {
    const g: any = got.experience[i] ?? {};
    for (const k of ["title", "org", "location", "start", "end", "current"]) check(`experience[${i}].${k}`, g[k], w[k]);
    w.bullets.forEach((b: string, j: number) => check(`experience[${i}].bullets[${j}]`, g.bullets?.[j], b));
    check(`experience[${i}].bullets.count`, g.bullets?.length ?? 0, w.bullets.length);
  });
  check("education.count", got.education.length, want.education.length);
  want.education.forEach((w: any, i: number) => {
    const g: any = got.education[i] ?? {};
    for (const k of ["degree", "org", "location", "start", "end"]) check(`education[${i}].${k}`, g[k], w[k]);
  });
  check("projects.count", got.projects.length, want.projects.length);
  want.projects.forEach((w: any, i: number) => {
    const g: any = got.projects[i] ?? {};
    check(`projects[${i}].name`, g.name, w.name);
    check(`projects[${i}].tech`, (g.tech ?? []).join(","), w.tech.join(","));
    check(`projects[${i}].date`, g.date, w.date);
    w.bullets.forEach((b: string, j: number) => check(`projects[${i}].bullets[${j}]`, g.bullets?.[j], b));
  });
  for (const sk of want.skills) check(`skills has ${sk}`, got.skills.map(norm).includes(norm(sk)) ? sk : null, sk);
  check("skills.extra", got.skills.filter((x) => !want.skills.map(norm).includes(norm(x))).join(", "), "");
  check("certifications.count", got.certifications.length, want.certifications.length);
  want.certifications.forEach((w: any, i: number) => { check(`certifications[${i}].name`, got.certifications[i]?.name, w.name); check(`certifications[${i}].date`, got.certifications[i]?.date, w.date); });
  check("languages", got.languages.map((l) => `${l.language}:${l.level}`).join(","), want.languages.map((l: any) => `${l.language}:${l.level}`).join(","));
  return s;
}
