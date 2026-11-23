// Beta loop B2: tailored resumes from verified facts, as files an ATS can read.
import { unzipSync, strFromU8 } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import { harness, TOKEN_A } from "./harness.js";

let h: Awaited<ReturnType<typeof harness>>;
let jobId: string;

async function pdfText(bytes: ArrayBuffer): Promise<{ text: string; pages: number }> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return { text: out.join("\n"), pages: doc.numPages };
}

beforeAll(async () => {
  h = await harness();
  ({ jobId } = await h.addCompany("Acme", [], "Requirements\n- 5+ years of Python\n- Kubernetes\n- SQL\nNice to have\n- Terraform"));
  await h.call("PUT", "/profile", TOKEN_A, { homeCountry: "US" });
  await h.call("POST", "/facts", TOKEN_A, [
    { kind: "role", text: "Senior Data Engineer", org: "Hooli", skills: ["python"], startDate: "2020-03-01", verified: true },
    { kind: "role", text: "Data Engineer", org: "Initech", skills: ["sql"], startDate: "2017-06-01", endDate: "2020-02-01", verified: true },
    { kind: "achievement", text: "Moved 40 batch pipelines to Kubernetes, cutting cost by 40%", org: "Hooli", skills: ["kubernetes", "python"], startDate: "2021-01-01", verified: true },
    { kind: "achievement", text: "Organised the office book club", org: "Hooli", skills: [], startDate: "2022-01-01", verified: true },
    { kind: "achievement", text: "Built the SQL reporting layer used by 200 analysts", org: "Initech", skills: ["sql"], startDate: "2018-01-01", verified: true },
    { kind: "achievement", text: "Invented a perpetual motion machine", org: "Hooli", skills: ["python"], verified: false },
    { kind: "education", text: "MS Computer Science", org: "São Paulo State University", startDate: "2015-08-01", endDate: "2017-05-01", verified: true },
    { kind: "skill", text: "Terraform", skills: ["terraform"], verified: true },
  ]);
  for (const [k, v] of [["contact.full_name", "Ana Müller-Šimić"], ["contact.email", "ana@example.com"], ["contact.phone", "+1 646 555 0100"]])
    await h.call("PUT", `/answers/${k}`, TOKEN_A, { answer: v });
});

describe("resume model (B2)", () => {
  it("uses only verified facts, ranks bullets for the job, and checks the text an ATS reads", async () => {
    const r = await h.json(await h.call("GET", `/resume?jobId=${jobId}`, TOKEN_A));
    const hooli = r.resume.experience[0];
    expect(hooli.heading).toBe("Senior Data Engineer");
    expect(hooli.dates).toBe("Mar 2020 - Present");
    expect(hooli.bullets[0]).toMatch(/Kubernetes/); // the relevant achievement leads
    expect(JSON.stringify(r.resume)).not.toMatch(/perpetual motion/); // unverified never appears
    expect([...r.resume.skills.slice(0, 3)].sort()).toEqual(["kubernetes", "python", "sql"]); // job's keywords first
    expect(r.check.issues.filter((i: { severity: string }) => i.severity === "error")).toEqual([]);
    expect(r.check.ok).toBe(true);
    expect(r.check.issues.some((i: { detail: string }) => /can't show some characters/.test(i.detail))).toBe(true); // ć in the name
    expect(r.check.issues.filter((i: { code: string }) => i.code === "non_ascii_date")).toEqual([]);
  });

  it("refuses without a name or verified facts", async () => {
    expect((await h.call("GET", "/resume", "b".repeat(20) + "-token-bob")).status).toBe(409);
  });
});

describe("resume files (B2)", () => {
  it("renders a PDF whose real text layer has the name, contact, employers and dates", async () => {
    const r = await h.call("GET", `/resume?jobId=${jobId}&format=pdf`, TOKEN_A);
    expect(r.headers.get("content-type")).toBe("application/pdf");
    expect(r.headers.get("content-disposition")).toMatch(/Ana-Muller-Simic-Resume-Acme\.pdf/);
    const { text, pages } = await pdfText(await r.arrayBuffer());
    expect(pages).toBe(1);
    // Standard PDF fonts cover ü and Š but not ć, which folds to c.
    for (const s of ["Ana Müller-Šimic", "ana@example.com", "Hooli", "Initech", "Mar 2020 - Present", "Kubernetes"]) expect(text).toContain(s);

  });

  it("renders a valid DOCX with the same content", async () => {
    const r = await h.call("GET", `/resume?format=docx`, TOKEN_A);
    const files = unzipSync(new Uint8Array(await r.arrayBuffer()));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["[Content_Types].xml", "word/document.xml", "word/styles.xml"]));
    const xml = strFromU8(files["word/document.xml"]!);
    expect(xml).toContain("Ana Müller-Šimić"); // the DOCX keeps every character
    expect(xml).toContain("São Paulo State University");
    expect(xml).not.toContain("perpetual");
  });
});
