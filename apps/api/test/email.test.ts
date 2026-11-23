// Beta loop B3: forwarding address, email-driven stage changes, follow-up and thank-you drafts.
import { beforeAll, describe, expect, it } from "vitest";
import { classifyEmail, companyFromSender, processInbound } from "../src/email.js";
import { harness, TOKEN_A, TOKEN_B } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let address: string;
let acmeApp: string;

const appFor = async (company: string) =>
  ((await h.json(await h.call("GET", "/applications", TOKEN_A))).items as Array<{ id: string; company: string; state: string }>).find((a) => a.company === company)!;

beforeAll(async () => {
  h = await harness();
  h.env.INBOUND_DOMAIN = "in.mycareeragent.app";
  await h.addCompany("Acme");
  await h.addCompany("Globex");
  await h.setupProfile(TOKEN_A);
  await h.call("POST", "/queue/build", TOKEN_A);
  acmeApp = (await appFor("Acme")).id;
  await h.call("PUT", "/answers/contact.full_name", TOKEN_A, { answer: "Alice Example" });
  for (const k of ["us.work_authorized", "us.needs_sponsorship_now", "us.needs_sponsorship_future"]) await h.call("PUT", `/answers/${k}`, TOKEN_A, { answer: "Yes" });
  await h.call("PUT", `/applications/${acmeApp}/answers`, TOKEN_A, [{ label: "Why Acme?", kind: "short_answer", text: "I cut pipeline cost by 40% for 3M users. I want to do that at Acme.", citedFactIds: [], maxChars: 300 }]);
  await h.call("POST", `/applications/${acmeApp}/status`, TOKEN_A, { state: "approved" });
});

describe("classification", () => {
  it("reads confirmations, rejections and invites", () => {
    expect(classifyEmail("no-reply@greenhouse.io", "Thank you for applying to Acme")).toBe("application_confirmation");
    expect(classifyEmail("talent@acme.com", "Your application to Acme", "Unfortunately we decided to move forward with other candidates for this role.")).toBe("rejection");
    expect(classifyEmail("jane@acme.com", "Next steps: phone screen with Acme")).toBe("interview_invite");
    expect(classifyEmail("jobs-noreply@linkedin.com", "15 new jobs for Data Engineer")).toBe("job_alert");
  });
  it("finds the company in the sender, skipping ATS domains", () => {
    expect(companyFromSender('"Acme Recruiting" <no-reply@acme.com>')).toBe("Acme");
    expect(companyFromSender("jobs@globex.com")).toBe("globex");
    expect(companyFromSender("no-reply@greenhouse.io")).toBeNull();
  });
});

describe("forwarding address", () => {
  it("is created once per user and only when a real domain is configured", async () => {
    const r = await h.json(await h.call("GET", "/inbound", TOKEN_A));
    expect(r.address).toMatch(/^[a-z0-9]{10}@in\.mycareeragent\.app$/);
    address = r.address;
    expect((await h.json(await h.call("GET", "/inbound", TOKEN_A))).address).toBe(address);
    h.env.INBOUND_DOMAIN = "in.mycareeragent.example";
    await h.call("PUT", "/profile", TOKEN_B, {});
    expect((await h.json(await h.call("GET", "/inbound", TOKEN_B))).address).toBeNull();
    h.env.INBOUND_DOMAIN = "in.mycareeragent.app";
  });

  it("rejects unknown recipients", async () => {
    expect((await processInbound(h.env.TEST_DB!, { to: "nobody123@in.mycareeragent.app", from: "x@acme.com", subject: "hi", body: "" })).accepted).toBe(false);
  });

  it("moves the application through submitted, screen and rejected, and logs each email", async () => {
    const db = h.env.TEST_DB!;
    let r = await processInbound(db, { to: address, from: "no-reply@greenhouse.io", subject: "Thank you for applying to Acme", body: "" });
    expect(r).toMatchObject({ accepted: true, kind: "application_confirmation", action: "submitted", applicationId: acmeApp });
    r = await processInbound(db, { to: address, from: '"Jane at Acme" <jane@acme.com>', subject: "Interview with Acme: next steps", body: "" });
    expect(r).toMatchObject({ kind: "interview_invite", action: "screen" });
    expect((await appFor("Acme")).state).toBe("screen");
    const inbox = await h.json(await h.call("GET", "/inbound", TOKEN_A));
    expect(inbox.recent.map((e: { action: string | null }) => e.action)).toEqual(["screen", "submitted"]);
    expect(inbox.recent[0].company).toBe("Acme");
  });
});

describe("follow-ups", () => {
  it("drafts a follow-up from submitted answers after 10 quiet days, then allows two sends", async () => {
    await h.pg.query("UPDATE mca.application_event SET created_at = now() - interval '12 days' WHERE application_id = $1", [acmeApp]);
    await h.pg.query("UPDATE mca.application SET submitted_at = now() - interval '12 days' WHERE id = $1", [acmeApp]);
    const r = await h.json(await h.call("GET", "/followups", TOKEN_A));
    const item = r.items.find((i: { appId: string }) => i.appId === acmeApp);
    expect(item).toMatchObject({ kind: "follow_up", company: "Acme", sent: 0 });
    expect(item.draft.subject).toBe("Following up: Senior Data Engineer application");
    expect(item.draft.body).toContain("I cut pipeline cost by 40% for 3M users.");
    expect(item.draft.body).toContain("Alice Example");
    expect(item.draft.warnings.filter((w: string) => /not in the materials/.test(w))).toEqual([]);
    expect((await h.call("POST", `/followups/${acmeApp}/sent`, TOKEN_A, { kind: "follow_up" })).status).toBe(200);
    expect((await h.call("POST", `/followups/${acmeApp}/sent`, TOKEN_A, { kind: "follow_up" })).status).toBe(200);
    expect((await h.call("POST", `/followups/${acmeApp}/sent`, TOKEN_A, { kind: "follow_up" })).status).toBe(409);
  });

  it("offers a thank-you right after an interview", async () => {
    await h.call("POST", `/applications/${acmeApp}/status`, TOKEN_A, { state: "interview" });
    const r = await h.json(await h.call("GET", "/followups", TOKEN_A));
    expect(r.items.find((i: { appId: string }) => i.appId === acmeApp)).toMatchObject({ kind: "thank_you" });
  });

  it("marks a rejection from email", async () => {
    await processInbound(h.env.TEST_DB!, { to: address, from: "talent@acme.com", subject: "Update on your application",
      body: "Unfortunately we have decided to move forward with other candidates for this role." });
    expect((await appFor("Acme")).state).toBe("rejected");
  });
});
