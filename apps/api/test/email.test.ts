// Beta loop B3: forwarding address, email-driven stage changes, follow-up and thank-you drafts.
import { beforeAll, describe, expect, it } from "vitest";
import { classifyEmail, companyFromSender, processInbound, titleFromSubject, titleOverlap } from "../src/email.js";
import { harness, TOKEN_A, TOKEN_B } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let address: string;
let acmeApp: string;

/** Accepts the newest open suggestion (an email proposes; the person decides). */
const acceptLatest = async () => {
  const { items } = await h.json(await h.call("GET", "/inbound/suggestions", TOKEN_A));
  return h.json(await h.call("POST", `/inbound/${items[0].id}/accept`, TOKEN_A));
};
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

  it("proposes each stage change; nothing moves until accepted", async () => {
    const db = h.env.TEST_DB!;
    let r = await processInbound(db, { to: address, from: "no-reply@greenhouse.io", subject: "Thank you for applying to Acme", body: "" });
    expect(r).toMatchObject({ accepted: true, kind: "application_confirmation", status: "pending", applicationId: acmeApp });
    expect((await appFor("Acme")).state).toBe("approved");
    const s = await h.json(await h.call("GET", "/inbound/suggestions", TOKEN_A));
    expect(s.items[0]).toMatchObject({ company: "Acme", suggestion: { to: "submitted", from: "approved" } });
    expect(await acceptLatest()).toMatchObject({ ok: true, applicationId: acmeApp });
    expect((await appFor("Acme")).state).toBe("submitted");

    r = await processInbound(db, { to: address, from: '"Jane at Acme" <jane@acme.com>', subject: "Interview with Acme: next steps", body: "" });
    expect(r).toMatchObject({ kind: "interview_invite", status: "pending" });
    await acceptLatest();
    expect((await appFor("Acme")).state).toBe("screen");
    const inbox = await h.json(await h.call("GET", "/inbound", TOKEN_A));
    expect(inbox.recent.map((e: { action: string | null }) => e.action)).toEqual(["screen", "submitted"]);
    expect(inbox.recent[0].company).toBe("Acme");
    expect(inbox.pending).toEqual([]);
  });

  it("ignoring a suggestion changes nothing, and a stale one says so", async () => {
    const db = h.env.TEST_DB!;
    await processInbound(db, { to: address, from: "talent@acme.com", subject: "Update on your application", body: "Unfortunately we decided to move forward with other candidates for this role." });
    const { items } = await h.json(await h.call("GET", "/inbound/suggestions", TOKEN_A));
    expect((await h.call("POST", `/inbound/${items[0].id}/ignore`, TOKEN_A)).status).toBe(200);
    expect((await appFor("Acme")).state).toBe("screen");
    expect((await h.call("POST", `/inbound/${items[0].id}/accept`, TOKEN_A)).status).toBe(409);
  });

  it("matches by the company's own email domain, not just the name", async () => {
    await h.pg.query("UPDATE mca.company SET domain = 'globex.com' WHERE name = 'Globex'");
    const globex = await appFor("Globex");
    await h.pg.query("UPDATE mca.application SET state = 'submitted' WHERE id = $1", [globex.id]);
    const r = await processInbound(h.env.TEST_DB!, { to: address, from: '"Sam Lee" <sam.lee@careers.globex.com>', subject: "Quick chat about next steps?", body: "" });
    expect(r).toMatchObject({ status: "pending", applicationId: globex.id });
    await h.call("POST", `/inbound/${(await h.json(await h.call("GET", "/inbound/suggestions", TOKEN_A))).items[0].id}/ignore`, TOKEN_A);
  });

  it("drops email that isn't about anything you're tracking, without storing it", async () => {
    const before = (await h.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mca.inbound_email")).rows[0]!.n;
    const r = await processInbound(h.env.TEST_DB!, { to: address, from: "news@techcrunch.com", subject: "5 interview tips for 2027", body: "" });
    expect(r).toMatchObject({ accepted: true, status: null });
    expect((await h.pg.query<{ n: number }>("SELECT count(*)::int AS n FROM mca.inbound_email")).rows[0]!.n).toBe(before);
  });

  it("suggests adding an application made outside the app, and tracks it when accepted", async () => {
    const nwMail = { to: address, from: '"Northwind Careers" <careers@northwind.io>', subject: "Thank you for applying to the Staff Platform Engineer role at Northwind", body: "" };
    await processInbound(h.env.TEST_DB!, nwMail); // forwarded twice: one decision closes both
    const r = await processInbound(h.env.TEST_DB!, nwMail);
    expect(r).toMatchObject({ kind: "application_confirmation", status: "pending", applicationId: null });
    const { items } = await h.json(await h.call("GET", "/inbound/suggestions", TOKEN_A));
    expect(items[0].suggestion).toMatchObject({ company: "Northwind", title: "Staff Platform Engineer" });
    const ok = await acceptLatest();
    expect(ok.ok).toBe(true);
    expect((await h.json(await h.call("GET", "/inbound/suggestions", TOKEN_A))).items).toEqual([]);
    const nw = await appFor("Northwind");
    expect(nw).toMatchObject({ state: "submitted" });
    // A private, never-queued job: nobody's queue picks it up.
    const { rows } = await h.pg.query<{ status: string; ats_vendor: string }>("SELECT j.status, j.ats_vendor FROM mca.application a JOIN mca.job j ON j.id = a.job_id WHERE a.id = $1", [nw.id]);
    expect(rows[0]).toEqual({ status: "closed", ats_vendor: "manual" });
    // A later interview email now matches it.
    const r2 = await processInbound(h.env.TEST_DB!, { to: address, from: "careers@northwind.io", subject: "Northwind: interview for Staff Platform Engineer", body: "" });
    expect(r2).toMatchObject({ status: "pending", applicationId: nw.id });
  });

  it("shows Gmail's forwarding confirmation code and link", async () => {
    await processInbound(h.env.TEST_DB!, { to: address, from: "Gmail Team <forwarding-noreply@google.com>", subject: "(#123456789) Gmail Forwarding Confirmation - Receive Mail from alice@gmail.com",
      body: "To allow alice@gmail.com to automatically forward mail to your address, please click the link below to confirm the request:\r\n\r\nhttps://mail-settings.google.com/mail/vf-%5BABC123%5D-xyz\r\n" });
    const inbox = await h.json(await h.call("GET", "/inbound", TOKEN_A));
    expect(inbox.forwardingCode).toMatchObject({ code: "123456789", link: "https://mail-settings.google.com/mail/vf-%5BABC123%5D-xyz" });
    expect(inbox.recent.some((e: { classification: string }) => e.classification === "forwarding_code")).toBe(false);
  });
});

describe("matching helpers", () => {
  it("reads the role from a confirmation subject", () => {
    expect(titleFromSubject("Thank you for applying to the Staff Platform Engineer role at Northwind")).toBe("Staff Platform Engineer");
    expect(titleFromSubject("Your application for Senior Data Engineer")).toBe("Senior Data Engineer");
    expect(titleFromSubject("Thanks for applying!")).toBeNull();
  });
  it("prefers the application whose title is in the subject", () => {
    expect(titleOverlap("Interview: Backend Engineer, Payments", "Backend Engineer, Payments")).toBe(1);
    expect(titleOverlap("Interview: Backend Engineer, Payments", "Data Scientist")).toBe(0);
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

  it("marks a rejection from email once accepted", async () => {
    await processInbound(h.env.TEST_DB!, { to: address, from: "talent@acme.com", subject: "Update on your application",
      body: "Unfortunately we have decided to move forward with other candidates for this role." });
    await acceptLatest();
    expect((await appFor("Acme")).state).toBe("rejected");
  });
});
