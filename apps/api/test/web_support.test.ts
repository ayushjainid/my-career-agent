// Endpoints added for the web app: application notes and history, skills inferred from pasted
// resume statements, and the onboarding answers step for people not applying in the US.
import { beforeAll, describe, expect, it } from "vitest";
import { harness, TOKEN_A, TOKEN_B } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;

beforeAll(async () => {
  h = await harness();
  await h.addCompany("Acme");
  await h.setupProfile(TOKEN_A);
  await h.call("POST", "/queue/build", TOKEN_A);
});

describe("application notes and history", () => {
  it("saves a note, lists it with stage dates, and returns the history oldest first", async () => {
    const [item] = (await h.json(await h.call("GET", "/queue", TOKEN_A))).items as Array<{ id: string }>;
    await h.call("POST", `/applications/${item!.id}/status`, TOKEN_A, { state: "approved" });
    await h.call("POST", `/applications/${item!.id}/status`, TOKEN_A, { state: "submitted" });
    expect((await h.call("PATCH", `/applications/${item!.id}/notes`, TOKEN_A, { notes: "  Panel Thursday  " })).status).toBe(200);
    const apps = (await h.json(await h.call("GET", "/applications", TOKEN_A))).items as Array<{ id: string; notes: string; reached: Record<string, string> }>;
    const a = apps.find((x) => x.id === item!.id)!;
    expect(a.notes).toBe("Panel Thursday");
    expect(Object.keys(a.reached)).toEqual(["submitted"]);
    const ev = (await h.json(await h.call("GET", `/applications/${item!.id}/events`, TOKEN_A))).items as Array<{ payload: { to: string } }>;
    expect(ev.map((e) => e.payload.to)).toEqual(["approved", "submitted"]);
  });

  it("keeps notes and history private to their owner and rejects oversize notes", async () => {
    const [item] = (await h.json(await h.call("GET", "/applications", TOKEN_A))).items as Array<{ id: string }>;
    expect((await h.call("PATCH", `/applications/${item!.id}/notes`, TOKEN_B, { notes: "x" })).status).toBe(404);
    expect((await h.json(await h.call("GET", `/applications/${item!.id}/events`, TOKEN_B))).items).toEqual([]);
    expect((await h.call("PATCH", `/applications/${item!.id}/notes`, TOKEN_A, { notes: "x".repeat(2001) })).status).toBe(400);
  });
});

describe("facts from a pasted resume", () => {
  it("take the skills a statement names when none are given", async () => {
    await h.call("POST", "/facts", TOKEN_A, [{ kind: "achievement", text: "Built a Kafka and Spark platform on AWS", verified: true }]);
    const facts = (await h.json(await h.call("GET", "/facts", TOKEN_A))).items as Array<{ text: string; skills: string[] }>;
    const f = facts.find((x) => x.text.startsWith("Built a Kafka"))!;
    expect(f.skills).toEqual(expect.arrayContaining(["spark", "aws"]));
  });
});

describe("onboarding answers step", () => {
  it("doesn't ask for US visa answers from someone applying only in the UK", async () => {
    const r = await h.call("PUT", "/profile", TOKEN_B, { homeCountry: "IN" });
    expect(r.status).toBe(200);
    await h.call("PUT", "/work-auth/GB", TOKEN_B, { status: "needs_sponsorship" });
    await h.call("PUT", "/answers/contact.full_name", TOKEN_B, { answer: "Bo Test" });
    await h.call("PUT", "/answers/contact.email", TOKEN_B, { answer: "bo@example.com" });
    const me = await h.json(await h.call("GET", "/auth/me", TOKEN_B));
    expect(me.onboarding.steps.find((s: { id: string }) => s.id === "answers").done).toBe(true);
  });
});
