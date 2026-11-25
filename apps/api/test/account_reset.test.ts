// "Start setup over": only what the person ticks is cleared; the login and other people's data stay.
import { beforeAll, describe, expect, it } from "vitest";
import { harness, TOKEN_A, TOKEN_B } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
const counts = async (t: string) => (await h.json(await h.call("GET", "/account/reset", t))).counts;

beforeAll(async () => {
  h = await harness();
  await h.addCompany("Acme");
  for (const t of [TOKEN_A, TOKEN_B]) {
    await h.setupProfile(t);
    await h.call("POST", "/resume/import", t, { format: "text", experience: [{ title: "Engineer", org: "Hooli", bullets: ["Built things"] }], skills: ["Go"], contact: { name: "X Y", email: "x@example.com" }, languages: [{ language: "English", level: "C2" }] });
    await h.call("POST", "/queue/build", t);
  }
  const [item] = (await h.json(await h.call("GET", "/queue", TOKEN_A))).items as Array<{ id: string }>;
  await h.call("POST", `/applications/${item!.id}/status`, TOKEN_A, { state: "approved" });
  await h.call("POST", `/applications/${item!.id}/status`, TOKEN_A, { state: "submitted" });
});

describe("start setup over", () => {
  it("reports what each part holds", async () => {
    const n = await counts(TOKEN_A);
    expect(n.facts_resume).toBeGreaterThan(0);
    expect(n.facts_manual).toBeGreaterThan(0);
    expect(n).toMatchObject({ work_auth: 1, applications: 1 });
  });

  it("clears only the parts picked, and returns setup to its first step", async () => {
    const before = await counts(TOKEN_A);
    const r = await h.call("POST", "/account/reset", TOKEN_A, { clear: ["facts_resume", "facts_manual", "answers", "languages", "work_auth", "targets", "companies", "contacts"] });
    expect(r.status).toBe(200);
    const after = await counts(TOKEN_A);
    expect(after).toMatchObject({ facts_resume: 0, facts_manual: 0, answers: 0, languages: 0, work_auth: 0, targets: 0, companies: 0, contacts: 0 });
    expect(after.applications).toBe(before.applications);
    const me = await h.json(await h.call("GET", "/auth/me", TOKEN_A));
    expect(me.onboarding.complete).toBe(false);
    expect(me.onboarding.steps.every((s: { done: boolean; optional?: boolean }) => !s.done)).toBe(true);
    expect((await h.json(await h.call("GET", "/profile", TOKEN_A))).settings.home_country).toBeNull();
  });

  it("clears applications and their history only when asked", async () => {
    expect((await h.call("POST", "/account/reset", TOKEN_A, { clear: ["applications"] })).status).toBe(200);
    expect((await counts(TOKEN_A)).applications).toBe(0);
    expect((await h.json(await h.call("GET", "/applications", TOKEN_A))).items).toEqual([]);
  });

  it("never touches another person's data and refuses nonsense", async () => {
    const b = await counts(TOKEN_B);
    expect(b.facts_resume).toBeGreaterThan(0);
    expect(b.work_auth).toBe(1);
    expect((await h.call("POST", "/account/reset", TOKEN_A, { clear: [] })).status).toBe(400);
    expect((await h.call("POST", "/account/reset", TOKEN_A, { clear: ["everything"] })).status).toBe(400);
  });
});
