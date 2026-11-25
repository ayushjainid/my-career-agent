import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detectFormat, extractText, findDateRange, importResume, ImportError, parseDate, structure, toIsoEnd } from "../src/index.js";
import { decodeCork } from "../src/text.js";
import { nodeReaders } from "./readers.js";
import { score } from "./score.js";

const fixture = (f: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
const expected = (k: string) => JSON.parse(readFileSync(new URL(`./expected/${k}.json`, import.meta.url), "utf8"));

// Every format of one person must give the same facts. c and d were written after tuning on a and b.
const FILES = ["a-jake.tex", "a-jake.pdf", "a-classic.docx", "a-classic.pdf", "b-moderncv.tex", "b-moderncv.pdf", "b-twocol.docx", "b-twocol.pdf", "c-header.docx", "c-header.pdf", "d-awesome.tex", "d-left-dates.pdf"];

describe("extraction precision on fixture resumes", () => {
  for (const f of FILES) {
    it(`reads every field of ${f}`, async () => {
      const got = await importResume(f, fixture(f), nodeReaders);
      const s = score(got, expected(f[0]!));
      expect(s.misses).toEqual([]);
    }, 30000);
  }
});

describe("hard cases", () => {
  it("repairs pdfTeX's T1 font encoding (ligatures, dashes, accents)", () => {
    expect(decodeCork("Air\u001dow Certi\u001ced \u0015 Ivanovi¢")).toBe("Airflow Certified – Ivanović");
  });

  it("refuses old .doc files and unknown formats with a way forward", async () => {
    const doc = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0, 0, 0]);
    expect(detectFormat("cv.doc", doc)).toBe("doc");
    await expect(importResume("cv.doc", doc, nodeReaders)).rejects.toThrow(/save it as \.docx/i);
    await expect(importResume("cv.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47]), nodeReaders)).rejects.toBeInstanceOf(ImportError);
  });

  it("warns when a PDF has no text layer", async () => {
    // A one-page PDF with no text at all, as a scanner produces.
    const empty = new TextEncoder().encode("%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF");
    const r = await importResume("scan.pdf", empty, nodeReaders);
    expect(r.warnings.join(" ")).toMatch(/scanned/);
  });

  it("reads pasted text with the same rules", () => {
    const r = structure(extractText(`Priya Raman
priya@example.com | (312) 555-0101 | Chicago, IL

EXPERIENCE
Staff Engineer, Globex Corporation    Apr 2020 - Present
• Cut checkout latency 30% for 8M shoppers
• Mentored 6 engineers

SKILLS
Go, Rust, PostgreSQL, Terraform`));
    expect(r.contact).toMatchObject({ name: "Priya Raman", email: "priya@example.com", phone: "(312) 555-0101", location: "Chicago, IL" });
    expect(r.experience).toEqual([expect.objectContaining({ title: "Staff Engineer", org: "Globex Corporation", start: "2020-04", current: true, bullets: ["Cut checkout latency 30% for 8M shoppers", "Mentored 6 engineers"] })]);
    expect(r.skills).toEqual(["Go", "Rust", "PostgreSQL", "Terraform"]);
  });

  it("marks guesses instead of hiding them", () => {
    const r = structure(extractText(`Sam Lee
EXPERIENCE
Northwind | Contoso
• Did a thing that mattered a great deal to the business`));
    expect(r.experience[0]!.unsure).toEqual(expect.arrayContaining(["title", "org", "dates"]));
  });
});

describe("dates", () => {
  it("reads the ways resumes write dates", () => {
    expect(parseDate("Sept. 2019")).toBe("2019-09");
    expect(parseDate("03/2021")).toBe("2021-03");
    expect(parseDate("2021-03")).toBe("2021-03");
    expect(parseDate("Summer 2020")).toBe("2020-06");
    expect(parseDate("Mär 2020")).toBe("2020-03");
    expect(findDateRange("Jan 2019 – Present")).toMatchObject({ start: "2019-01", end: null, current: true });
    expect(findDateRange("04/2021 - heute")).toMatchObject({ start: "2021-04", current: true });
    expect(findDateRange("2015 to 2019")).toMatchObject({ start: "2015", end: "2019" });
    expect(findDateRange("handling 300 analysts")).toBeNull();
    expect(toIsoEnd("2024-02")).toBe("2024-02-29");
  });
});
