// Dublin and Milan: Irish permits as sponsor evidence, Italian postings answered in Italian.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { harness, TOKEN_A } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let dublin: { companyId: string; jobId: string };
let dublinLow: { companyId: string; jobId: string };
let milan: { companyId: string; jobId: string };
let roleId: string;

const MILAN = `Chi siamo
Siamo una fintech milanese con 300 persone e cresciamo velocemente.

Di cosa ti occuperai
- Progettare e sviluppare microservizi in Python e Java
- Collaborare con il team prodotto

Requisiti
- Almeno 5 anni di esperienza nello sviluppo backend
- Ottima conoscenza di Python, SQL e AWS
- Italiano fluente

Cosa offriamo
- RAL 55.000 - 70.000 € in base all'esperienza
- Modalità di lavoro ibrida, sede a Milano`;

const DUBLIN = `About the role
We're hiring a Senior Data Engineer in Dublin.

Requirements
- 5+ years of Python
- SQL
- AWS

We support Critical Skills Employment Permit applications.`;

beforeAll(async () => {
  h = await harness();
  h.env.AI_KEY_SECRET = "test-secret-value-0123456789";
  const mk = async (name: string, country: string, location: string, text: string, pay: [number, number]) => {
    const ids = await h.addCompany(name, [], text);
    await h.pg.query(
      "UPDATE mca.job SET country = $2, location_text = $3, pay_currency = 'EUR', pay_min = $4, pay_max = $5, pay_period = 'year' WHERE id = $1",
      [ids.jobId, country, location, pay[0], pay[1]],
    );
    await h.pg.query("DELETE FROM mca.sponsor_record WHERE company_id = $1", [ids.companyId]);
    return ids;
  };
  dublin = await mk("Intercom", "IE", "Dublin, Ireland", DUBLIN, [85000, 105000]);
  dublinLow = await mk("Smallco", "IE", "Dublin, Ireland", DUBLIN, [30000, 35000]);
  milan = await mk("Satispay", "IT", "Milano, Italia", MILAN, [55000, 70000]);
  for (const c of [dublin, dublinLow])
    await h.pg.query(
      `INSERT INTO mca.sponsor_record (company_id, country, source, employer_name, employer_norm, filings, certified, period_end)
       VALUES ($1, 'IE', 'dete_permits', 'Employer Ltd', 'EMPLOYER', 12, 12, '2026-10-31')`, [c.companyId]);

  await h.call("PUT", "/profile", TOKEN_A, { homeCountry: "IN", dailyTarget: 10 });
  const r = await h.json(await h.call("POST", "/facts", TOKEN_A, [
    { kind: "role", text: "Data engineer at Hooli, cut pipeline cost by 40% for 3M users", org: "Hooli", skills: ["python", "sql", "aws"], startDate: "2018-01-01", verified: true },
  ]));
  roleId = r.ids[0];
  await h.call("PUT", "/languages", TOKEN_A, [{ language: "English", level: "C2" }, { language: "Italian", level: "C1" }]);
  await h.call("PUT", "/work-auth/IE", TOKEN_A, { status: "needs_sponsorship" });
  await h.call("PUT", "/work-auth/IT", TOKEN_A, { status: "needs_sponsorship" });
  await h.call("POST", "/targets", TOKEN_A, { country: "IE", title: "Data Engineer" });
  await h.call("POST", "/targets", TOKEN_A, { country: "IT", title: "Data Engineer" });
  await h.call("PUT", "/answers/contact.full_name", TOKEN_A, { answer: "Alice Example" });
  await h.call("PUT", "/answers/contact.email", TOKEN_A, { answer: "alice@example.com" });
});

afterEach(() => vi.unstubAllGlobals());

describe("Dublin", () => {
  it("queues employers with Irish permits and flags pay under the permit minimum", async () => {
    await h.call("POST", "/queue/build", TOKEN_A);
    const items = (await h.json(await h.call("GET", "/queue", TOKEN_A))).items as Array<{ company: string; flags?: string[]; sponsorship?: unknown }>;
    const byName = new Map(items.map((i) => [i.company, i]));
    expect(byName.has("Intercom")).toBe(true);
    expect(JSON.stringify(byName.get("Smallco") ?? {})).toMatch(/General Employment Permit minimum of €36,605/) // under every permit: the lowest one is named;
    expect(JSON.stringify(byName.get("Intercom"))).not.toMatch(/minimum of/);
  });

  it("asks for Irish work-authorization answers, not US ones", async () => {
    const p = await h.json(await h.call("GET", `/packets/${dublin.jobId}`, TOKEN_A));
    expect(p.language).toBe("en");
    expect(p.blockers.join(" | ")).toMatch(/right to work in Ireland/);
    expect(p.blockers.join(" | ")).not.toMatch(/United States|U\.S\./);
    await h.call("PUT", "/answers/ie.right_to_work", TOKEN_A, { answer: "No", sensitive: true });
    await h.call("PUT", "/answers/ie.needs_permit", TOKEN_A, { answer: "Yes", sensitive: true });
    const after = await h.json(await h.call("GET", `/packets/${dublin.jobId}`, TOKEN_A));
    expect(after.blockers).toEqual([]);
    expect(after.fields.map((f: { key: string }) => f.key)).toContain("ie.needs_permit");
  });
});

describe("Milan, in Italian", () => {
  it("marks the packet Italian and shows Italian form labels", async () => {
    await h.call("PUT", "/answers/it.right_to_work", TOKEN_A, { answer: "No", sensitive: true });
    await h.call("PUT", "/answers/it.needs_permit", TOKEN_A, { answer: "Sì", sensitive: true });
    const p = await h.json(await h.call("GET", `/packets/${milan.jobId}`, TOKEN_A));
    expect(p.language).toBe("it");
    expect(p.job.description).toBeUndefined();
    const f = p.fields.find((x: { key: string }) => x.key === "it.needs_permit");
    expect(f.formLabel).toBe("Hai bisogno di un permesso di lavoro o della Carta Blu UE?");
    expect(p.fields.map((x: { key: string }) => x.key)).not.toContain("ie.needs_permit");
    expect(p.blockers).toEqual([]);
  });

  it("builds an Italian CV, warns about English lines, and uses saved Italian versions", async () => {
    const before = await h.json(await h.call("GET", `/resume?jobId=${milan.jobId}`, TOKEN_A));
    expect(before.locale).toBe("it");
    const text = before.lines.join("\n");
    expect(text).toMatch(/Esperienza professionale/i);
    expect(text).toMatch(/GDPR/);
    expect(before.check.issues.map((i: { code: string }) => i.code)).toContain("untranslated");

    const it = "Data engineer presso Hooli: ridotto del 40% il costo delle pipeline per 3M utenti";
    expect((await h.call("PATCH", `/facts/${roleId}`, TOKEN_A, { translations: { it } })).status).toBe(200);
    const facts = await h.json(await h.call("GET", "/facts", TOKEN_A));
    expect(facts.items.find((x: { id: string }) => x.id === roleId).translations).toEqual({ it });

    const after = await h.json(await h.call("GET", `/resume?jobId=${milan.jobId}`, TOKEN_A));
    expect(after.lines.join("\n")).toContain("ridotto del 40%");
    expect(after.check.issues.map((i: { code: string }) => i.code)).not.toContain("untranslated");

    const en = await h.json(await h.call("GET", `/resume?jobId=${milan.jobId}&lang=en`, TOKEN_A));
    expect(en.locale).toBe("en");
    expect(en.lines.join("\n")).not.toMatch(/GDPR/);

    // Clearing the Italian version removes it.
    await h.call("PATCH", `/facts/${roleId}`, TOKEN_A, { translations: { it: null } });
    const cleared = await h.json(await h.call("GET", "/facts", TOKEN_A));
    expect(cleared.items.find((x: { id: string }) => x.id === roleId).translations).toEqual({});
  });

  it("translates with the user's own key and flags changed numbers, saving nothing", async () => {
    expect((await h.call("PUT", "/ai/key", TOKEN_A, { provider: "anthropic", apiKey: "sk-ant-api03-" + "x".repeat(40) + "WXYZ" })).status).toBe(200);
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({
      translations: [{ id: roleId, text: "Data engineer presso Hooli: ridotto del 45% il costo delle pipeline per 3M utenti" }] }) }] }), { status: 200 }));
    const r = await h.json(await h.call("POST", "/ai/translate", TOKEN_A, { to: "it", factIds: [roleId] }));
    expect(r.items).toHaveLength(1);
    expect(r.items[0].problems.join(" ")).toMatch(/40/);
    const facts = await h.json(await h.call("GET", "/facts", TOKEN_A));
    expect(facts.items.find((x: { id: string }) => x.id === roleId).translations).toEqual({});
  });

  it("drafts application answers in Italian", async () => {
    let system = "";
    vi.stubGlobal("fetch", async (_u: string, init: { body: string }) => {
      system = JSON.parse(init.body).system;
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify({ text: "In Hooli ho ridotto i costi del 40%.", citedFactIds: [roleId] }) }] }), { status: 200 });
    });
    const r = await h.call("POST", "/ai/draft", TOKEN_A, { jobId: milan.jobId, question: "Perché Satispay?", kind: "short_answer", maxChars: 300 });
    expect(r.status).toBe(200);
    expect(system).toMatch(/Italian/);
  });
});
