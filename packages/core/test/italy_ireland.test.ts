import { describe, expect, it } from "vitest";
import {
  detectLanguage, eligibilityGate, extractLanguageRequirements, extractRequirements, inferCountry, languageGate,
  parsePayFromText, permitPayCheck, sponsorshipFor, sponsorshipSignal,
} from "../src/index.js";

// Written the way Milan tech postings usually are: Italian headings, RAL, a language line.
const MILAN = `Chi siamo
Siamo una fintech milanese con 300 persone e cresciamo velocemente.

Di cosa ti occuperai
- Progettare e sviluppare microservizi in Kotlin e Java
- Collaborare con il team prodotto

Requisiti
- Almeno 5 anni di esperienza nello sviluppo backend
- Ottima conoscenza di Kotlin, PostgreSQL e Kubernetes
- Ottima conoscenza della lingua inglese
- Italiano fluente

Costituisce titolo preferenziale
- Esperienza con Kafka

Cosa offriamo
- RAL 55.000 - 70.000 € in base all'esperienza
- Modalità di lavoro ibrida, sede a Milano`;

const DUBLIN = `About the role
We're hiring a Senior Software Engineer in Dublin.

Requirements
- 6+ years building distributed systems in Go or Java
- Experience with AWS

We support Critical Skills Employment Permit applications for the right candidate.
Salary: €85,000 - €105,000 per year.`;

describe("Italian postings", () => {
  it("knows the language", () => {
    expect(detectLanguage(MILAN)).toBe("it");
    expect(detectLanguage(DUBLIN)).toBe("en");
    expect(detectLanguage("Python, SQL")).toBe("other");
  });

  it("reads Italian sections, years and seniority", () => {
    const r = extractRequirements("Senior Backend Engineer", MILAN);
    expect(r.mustHave).toEqual(["kotlin", "kubernetes", "sql"]); // Java is under "Di cosa ti occuperai", a duty, not a requirement
    expect(r.niceToHave).toEqual(["kafka"]);
    expect(r.mustHave).not.toContain("kafka");
    expect(r.minYears).toBe(5);
    expect(r.postingLanguage).toBe("it");
    expect(extractRequirements("Responsabile sviluppo software", MILAN).seniority).toBe("lead");
    expect(extractRequirements("Stagista sviluppatore", MILAN).seniority).toBe("entry");
  });

  it("reads RAL in its usual forms", () => {
    expect(parsePayFromText(MILAN)).toMatchObject({ min: 55000, max: 70000, currency: "EUR", period: "year" });
    expect(parsePayFromText("RAL: 40-50k")).toMatchObject({ min: 40000, max: 50000 });
    expect(parsePayFromText("Retribuzione annua lorda da 38.000 a 45.000 euro")).toMatchObject({ min: 38000, max: 45000 });
    expect(parsePayFromText("45.000€ - 55.000€")).toMatchObject({ min: 45000, max: 55000, currency: "EUR" });
    expect(parsePayFromText("dal 2019 al 2021")).toBeNull();
  });

  it("reads language requirements in Italian, and Italian postings need Italian", () => {
    const reqs = extractLanguageRequirements(MILAN);
    expect(reqs).toEqual(expect.arrayContaining([
      expect.objectContaining({ language: "english", level: 5, optional: false }),
      expect.objectContaining({ language: "italian", level: 5, optional: false }),
    ]));
    const quiet = extractLanguageRequirements("Requisiti\nOttima conoscenza di Java e Spring. Sede di lavoro a Milano, contratto a tempo indeterminato con il nostro team.");
    expect(quiet).toEqual([expect.objectContaining({ language: "italian", level: 4, line: "The posting is written in Italian." })]);
    expect(extractLanguageRequirements("Gradita la conoscenza della lingua tedesca.")).toEqual(expect.arrayContaining([expect.objectContaining({ language: "german", optional: true })]));
    expect(languageGate(MILAN, [{ language: "English", level: "C2" }]).verdict).toBe("FAIL");
    expect(languageGate(MILAN, [{ language: "English", level: "C2" }, { language: "Italian", level: "B2" }]).verdict).toBe("FLAG");
    expect(languageGate(MILAN, [{ language: "English", level: "C2" }, { language: "Italian", level: "C1" }]).verdict).toBe("PASS");
  });

  it("flags roles reserved for categorie protette and reads citizenship rules", () => {
    const g = eligibilityGate("La ricerca è rivolta esclusivamente a candidati appartenenti alle categorie protette (L. 68/99).", "needs_sponsorship");
    expect(g.verdict).toBe("FLAG");
    expect(g.notes[0]).toMatch(/Law 68\/1999/);
    expect(eligibilityGate("È richiesta la cittadinanza italiana.", "needs_sponsorship").verdict).toBe("FAIL");
  });

  it("reads sponsorship wording in Italian and Irish English", () => {
    expect(sponsorshipSignal("Non offriamo sponsorizzazione del visto.")).toBe("negative");
    expect(sponsorshipSignal("È richiesto il permesso di soggiorno.")).toBe("negative");
    expect(sponsorshipSignal("Offriamo supporto per il visto e la Carta Blu.")).toBe("positive");
    expect(sponsorshipSignal(DUBLIN)).toBe("positive");
    expect(sponsorshipSignal("Candidates must have the right to work in Ireland.")).toBe("negative");
  });
});

describe("Ireland and Italy country packs", () => {
  it("places Dublin and Milan, but not Dublin, CA", () => {
    expect(inferCountry("Dublin, Ireland")).toBe("IE");
    expect(inferCountry("Dublin")).toBe("IE");
    expect(inferCountry("Cork or Remote (Ireland)")).toBe("IE");
    expect(inferCountry("Dublin, CA")).toBe("US");
    expect(inferCountry("Milano, Lombardia")).toBe("IT");
    expect(inferCountry("Milan, Italy (Hybrid)")).toBe("IT");
    expect(inferCountry("Rome, GA")).toBe("US");
    expect(inferCountry("Belfast")).toBe("GB");
  });

  it("scores Irish permits on record, and Italy by the posting", () => {
    const t = { minFilings: 1, minPermCertified: 0 };
    expect(sponsorshipFor("IE", { filings: 24, certified: 0, denied: 0, withdrawn: 0, latestPeriodEnd: null } as never, t, "none").passes).toBe(true);
    expect(sponsorshipFor("IE", null, t, "none")).toMatchObject({ passes: false, reasons: ["No Irish employment permits issued to this employer on record."] });
    expect(sponsorshipFor("IT", null, t, "none")).toMatchObject({ passes: true });
    expect(sponsorshipFor("IT", null, t, "negative").passes).toBe(false);
  });

  it("checks posted pay against the permit minimum", () => {
    expect(permitPayCheck("IE", { min: 30000, max: 35000, currency: "EUR", period: "year" })).toMatchObject({ status: "below", minimum: { permit: "General Employment Permit", annual: 36605 } });
    expect(permitPayCheck("IE", { min: 85000, max: 105000, currency: "EUR", period: "year" }).status).toBe("ok");
    expect(permitPayCheck("IT", { min: 30000, max: 34000, currency: "EUR", period: "year" })).toMatchObject({ status: "below", minimum: { annual: 36300 } });
    expect(permitPayCheck("IT", null).status).toBe("unknown");
    expect(permitPayCheck("US", { min: 1, max: 2, currency: "USD", period: "year" }).status).toBe("unknown");
  });
});
