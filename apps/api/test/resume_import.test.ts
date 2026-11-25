// Saving a reviewed resume: facts, answers and languages in one go, never over what the person typed.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { importResume } from "@my-career-agent/resume-import";
import { harness, TOKEN_A, TOKEN_B } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let parsed: Awaited<ReturnType<typeof importResume>>;

beforeAll(async () => {
  h = await harness();
  const bytes = new Uint8Array(readFileSync(new URL("../../../packages/resume-import/test/fixtures/a-classic.docx", import.meta.url)));
  parsed = await importResume("a-classic.docx", bytes, {
    pdfjs: async () => (await import("pdfjs-dist/legacy/build/pdf.mjs")) as never,
    mammoth: async () => ((await import("mammoth")).default ?? (await import("mammoth"))) as never,
  });
});

describe("POST /resume/import", () => {
  it("saves the reviewed resume for someone with no profile yet", async () => {
    // Someone already typed their phone number: the resume must not overwrite it.
    const r = await h.call("POST", "/resume/import", TOKEN_A, { ...parsed, format: "docx", fileName: "a-classic.docx" });
    expect(r.status).toBe(201);
    const body = await h.json(r);
    expect(body).toMatchObject({ roles: 2, languages: 3, suggestions: { targetTitle: "Senior Data Engineer", homeCountry: "US" } });

    const facts = (await h.json(await h.call("GET", "/facts", TOKEN_A))).items as Array<Record<string, unknown>>;
    expect(facts.every((f) => f.verified === true && f.source === "resume")).toBe(true);
    expect(facts.filter((f) => f.kind === "achievement")).toHaveLength(5);
    expect(facts.find((f) => f.kind === "project")).toMatchObject({ text: "OpenLineage Dashboard: Open-source lineage viewer used by 40 teams to trace failed pipelines" });
    expect(facts.find((f) => f.kind === "role" && f.org === "Hooli")).toMatchObject({ text: "Senior Data Engineer", location: "San Francisco, CA", start_date: "2021-03-01", end_date: null });
    expect(facts.find((f) => f.kind === "role" && f.org === "Initech")).toMatchObject({ start_date: "2018-06-01", end_date: "2021-02-28" });
    expect(facts.find((f) => f.kind === "skill")!.skills).toEqual(expect.arrayContaining(["python", "airflow"]));

    const answers = (await h.json(await h.call("GET", "/answers", TOKEN_A))).items as Array<{ question_key: string; answer: string }>;
    const a = Object.fromEntries(answers.map((x) => [x.question_key, x.answer]));
    expect(a).toMatchObject({ "contact.full_name": "Dana Ivanović", "contact.email": "dana.ivanovic@example.com", "contact.linkedin": "linkedin.com/in/dana-ivanovic" });

    const me = await h.json(await h.call("GET", "/auth/me", TOKEN_A));
    expect(me.onboarding.steps[0]).toMatchObject({ id: "facts", done: true });
    expect((await h.json(await h.call("GET", "/profile", TOKEN_A))).languages).toHaveLength(3);
  });

  it("keeps answers the person already gave and replaces only imported facts", async () => {
    await h.call("PUT", "/answers/contact.phone", TOKEN_A, { answer: "+1 415 000 0000" });
    await h.call("POST", "/facts", TOKEN_A, [{ kind: "achievement", text: "Typed by hand", verified: true }]);
    const r = await h.call("POST", "/resume/import", TOKEN_A, { ...parsed, format: "docx", replace: true, experience: parsed.experience.slice(0, 1) });
    expect(r.status).toBe(201);
    const facts = (await h.json(await h.call("GET", "/facts", TOKEN_A))).items as Array<Record<string, unknown>>;
    expect(facts.filter((f) => f.kind === "role")).toHaveLength(1);
    expect(facts.find((f) => f.text === "Typed by hand")).toMatchObject({ source: "manual" });
    const answers = (await h.json(await h.call("GET", "/answers", TOKEN_A))).items as Array<{ question_key: string; answer: string }>;
    expect(answers.find((x) => x.question_key === "contact.phone")!.answer).toBe("+1 415 000 0000");
    const last = await h.json(await h.call("GET", "/resume/import", TOKEN_A));
    expect(last.last).toMatchObject({ format: "docx" });
  });

  it("is private to its owner and rejects an empty review", async () => {
    expect((await h.json(await h.call("GET", "/facts", TOKEN_B))).items).toEqual([]);
    expect((await h.call("POST", "/resume/import", TOKEN_B, { format: "pdf", contact: {} })).status).toBe(400);
    expect((await h.call("POST", "/resume/import", TOKEN_B, { format: "exe", skills: ["x"] })).status).toBe(400);
  });
});
