// POC loops P4 (referrals) and P5 (apply packet, answer bank, tracker), end to end.
import { beforeAll, describe, expect, it } from "vitest";
import { harness, TOKEN_A, TOKEN_B } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let factIds: string[];
let acme: { companyId: string; jobId: string };
let appId: string;

const CONNECTIONS = [
  "Notes:",
  '"When exporting your connection data, you may notice that some of the email addresses are missing."',
  "",
  "First Name,Last Name,URL,Email Address,Company,Position,Connected On",
  "Priya,Shah,https://www.linkedin.com/in/priyashah,,Acme Inc.,Staff Engineer,05 Mar 2019",
  'Tom,Lee,https://www.linkedin.com/in/tomlee/,,"Acme, Inc.",Recruiter,12 Jan 2026',
  "Ana,Gomez,https://www.linkedin.com/in/anagomez,,Globex Corporation,PM,01 Feb 2022",
  "Sam,Roe,https://www.linkedin.com/in/samroe,,Nowhere LLC,Engineer,01 Feb 2022",
  ",,,,,,",
].join("\n");
const MESSAGES = [
  "CONVERSATION ID,CONVERSATION TITLE,FROM,SENDER PROFILE URL,TO,RECIPIENT PROFILE URLS,DATE,SUBJECT,CONTENT,FOLDER",
  "c1,,Priya Shah,https://www.linkedin.com/in/priyashah,Me,https://www.linkedin.com/in/me,2026-10-01 10:00:00 UTC,,hi,INBOX",
  "c1,,Me,https://www.linkedin.com/in/me,Priya Shah,https://www.linkedin.com/in/priyashah,2026-10-02 10:00:00 UTC,,hello,INBOX",
].join("\n");

beforeAll(async () => {
  h = await harness();
  acme = await h.addCompany("Acme");
  await h.addCompany("Globex", ["GLOBEX CORPORATION"]);
  factIds = await h.setupProfile(TOKEN_A);
  await h.call("POST", "/queue/build", TOKEN_A);
  const items = (await h.json(await h.call("GET", "/queue", TOKEN_A))).items as Array<{ id: string; company: string }>;
  appId = items.find((i) => i.company === "Acme")!.id;
});

describe("P4 referrals", () => {
  it("imports Connections.csv with messages and matches companies by name and alias", async () => {
    const r = await h.json(await h.call("POST", "/connections/import", TOKEN_A, { connectionsCsv: CONNECTIONS, messagesCsv: MESSAGES }));
    expect(r).toMatchObject({ imported: 4, skipped: 0, messagesUsed: true, total: 4, matched: 3, companies: 2 });
  });

  it("ranks who can refer for a job and drafts the ask", async () => {
    await h.call("PUT", "/answers/contact.full_name", TOKEN_A, { answer: "Alice Example" });
    const r = await h.json(await h.call("GET", `/referrals/${acme.jobId}`, TOKEN_A));
    expect(r.items.map((i: { full_name: string }) => i.full_name)).toEqual(["Priya Shah", "Tom Lee"]); // conversation ranks first
    expect(r.items[0].draft).toMatch(/^Hi Priya, hope you're doing well!/);
    expect(r.items[0].draft).toContain("Senior Data Engineer role at Acme");
    expect(r.items[0].draft).toContain("Alice Example");
  });

  it("records an ask, and re-importing keeps it while updating details", async () => {
    const r = await h.json(await h.call("GET", `/referrals/${acme.jobId}`, TOKEN_A));
    expect((await h.call("POST", `/applications/${appId}/referral`, TOKEN_A, { contactId: r.items[0].id })).status).toBe(200);
    await h.call("POST", "/connections/import", TOKEN_A, { connectionsCsv: CONNECTIONS.replace("Staff Engineer", "Principal Engineer") });
    const after = await h.json(await h.call("GET", `/referrals/${acme.jobId}`, TOKEN_A));
    const priya = after.items.find((i: { full_name: string }) => i.full_name === "Priya Shah");
    expect(priya.position).toBe("Principal Engineer");
    expect(priya.last_ask_at).not.toBeNull();
    expect(priya.messages_count).toBe(2); // the import without messages.csv kept earlier counts
    const packet = await h.json(await h.call("GET", `/packets/${acme.jobId}`, TOKEN_A));
    expect(packet.application.referral_name).toBe("Priya Shah");
  });

  it("refuses files that are not a Connections export, and other users' data", async () => {
    expect((await h.call("POST", "/connections/import", TOKEN_A, { connectionsCsv: "a,b\n1,2" })).status).toBe(400);
    const r = await h.json(await h.call("GET", `/referrals/${acme.jobId}`, TOKEN_B));
    expect(r.items).toEqual([]);
  });
});

describe("P5 answer bank, packet and tracker", () => {
  it("lists missing standard questions and forces standard sensitivity", async () => {
    await h.call("PUT", "/answers/us.work_authorized", TOKEN_A, { answer: "Yes", sensitive: false });
    const r = await h.json(await h.call("GET", "/answers", TOKEN_A));
    expect(r.items.find((i: { question_key: string }) => i.question_key === "us.work_authorized").sensitive).toBe(true);
    expect(r.missing.map((q: { key: string }) => q.key)).toContain("us.needs_sponsorship_now");
    expect((await h.call("PUT", "/answers/Bad Key", TOKEN_A, { answer: "x" })).status).toBe(400);
  });

  it("blocks the packet until sensitive US answers exist and free-text answers pass their checks", async () => {
    let p = await h.json(await h.call("GET", `/packets/${acme.jobId}`, TOKEN_A));
    expect(p.ready).toBe(false);
    expect(p.blockers.join(" ")).toMatch(/require visa sponsorship/);

    for (const k of ["us.needs_sponsorship_now", "us.needs_sponsorship_future"]) await h.call("PUT", `/answers/${k}`, TOKEN_A, { answer: "Yes" });
    await h.call("PUT", "/answers/pay.expectation", TOKEN_A, { answer: "USD 180,000-200,000" });
    const bad = await h.json(await h.call("PUT", `/applications/${appId}/answers`, TOKEN_A, [
      { label: "Why Acme?", kind: "short_answer", text: "I cut pipeline cost by 55%.", citedFactIds: [factIds[0]], maxChars: 200 },
    ]));
    expect(bad.items[0].grounding.unsupportedFigures).toEqual(["55%"]);
    p = await h.json(await h.call("GET", `/packets/${acme.jobId}`, TOKEN_A));
    expect(p.ready).toBe(false);

    await h.call("PUT", `/applications/${appId}/answers`, TOKEN_A, [
      { label: "Why Acme?", kind: "short_answer", text: "I cut pipeline cost by 40% for 3M users.", citedFactIds: [factIds[0]], maxChars: 200 },
    ]);
    p = await h.json(await h.call("GET", `/packets/${acme.jobId}`, TOKEN_A));
    expect(p.blockers).toEqual([]);
    expect(p.ready).toBe(true);
    expect(p.fields.find((f: { key: string }) => f.key === "us.work_authorized")).toMatchObject({ value: "Yes", sensitive: true });
    expect(p.job.apply_url).toMatch(/greenhouse/);
  });

  it("reviews answers without saving them", async () => {
    const r = await h.json(await h.call("POST", "/answers/review", TOKEN_A, [{ label: "Intro", kind: "self_intro", text: "Too short.", citedFactIds: [] }]));
    expect(r.items[0].full.problems.join(" ")).toMatch(/aim for at least 100/);
  });

  it("freezes answers at submission and lists the application in the tracker", async () => {
    await h.call("POST", `/applications/${appId}/status`, TOKEN_A, { state: "approved" });
    expect((await h.call("POST", `/applications/${appId}/status`, TOKEN_A, { state: "submitted" })).status).toBe(200);
    const frozen = await h.pg.query<{ submitted_text: string }>("SELECT submitted_text FROM mca.application_answer WHERE application_id = $1", [appId]);
    expect(frozen.rows[0]?.submitted_text).toContain("40% for 3M users");
    expect((await h.call("PUT", `/applications/${appId}/answers`, TOKEN_A, [{ label: "x", kind: "other", text: "y", citedFactIds: [] }])).status).toBe(409);
    const t = await h.json(await h.call("GET", "/applications?state=submitted", TOKEN_A));
    expect(t.items).toHaveLength(1);
    expect(t.items[0]).toMatchObject({ company: "Acme", state: "submitted", referral_name: "Priya Shah" });
    expect((await h.json(await h.call("GET", "/applications", TOKEN_B))).items).toEqual([]);
  });
});
