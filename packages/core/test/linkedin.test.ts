import { describe, expect, it } from "vitest";
import { draftReferralAsk, isAnswerKey, isSensitiveKey, parseCsv, parseLinkedInDate, parseLinkedInExport } from "../src/index.js";

describe("LinkedIn export (P4)", () => {
  it("parses quoted CSV with commas, doubled quotes, newlines and CRLF", () => {
    expect(parseCsv('a,"b, c","say ""hi"""\r\n"multi\nline",2,3\r\n')).toEqual([["a", "b, c", 'say "hi"'], ["multi\nline", "2", "3"]]);
  });

  it("reads LinkedIn's two date formats and rejects others", () => {
    expect(parseLinkedInDate("05 Mar 2021")).toBe("2021-03-05");
    expect(parseLinkedInDate("2024-03-05 14:02:11 UTC")).toBe("2024-03-05");
    expect(parseLinkedInDate("March 5")).toBeNull();
  });

  it("dedupes people, normalises URLs and company names, and works without messages.csv", () => {
    const r = parseLinkedInExport(
      "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n" +
        "Jo,Kim,https://www.linkedin.com/in/JoKim/?trk=x,,Stripe Inc,Eng,01 Jan 2020\n" +
        "Jo,Kim,https://www.linkedin.com/in/jokim,,Stripe Inc,Eng,01 Jan 2020\n" +
        "Al,,,,,,\n",
    );
    expect(r.connections).toHaveLength(2);
    expect(r.connections[0]).toMatchObject({ key: "https://www.linkedin.com/in/jokim", companyNorm: "STRIPE", messagesCount: 0 });
    expect(r.connections[1]).toMatchObject({ key: "name:al", companyName: null });
    expect(r.messageFileUsed).toBe(false);
  });

  it("drafts a short ask that names the role and makes no easy", () => {
    const d = draftReferralAsk({ contactFirstName: "Jo", company: "Stripe", role: "Data Engineer", jobUrl: null, senderName: "Al", warm: false });
    expect(d).toContain("Data Engineer role at Stripe");
    expect(d).toMatch(/Completely fine if not/);
    expect(d.split(/\s+/).length).toBeLessThan(70);
  });
});

describe("answer bank keys (P5)", () => {
  it("accepts dotted keys and fixes sensitivity for standard questions", () => {
    expect(isAnswerKey("us.work_authorized")).toBe(true);
    expect(isAnswerKey("Bad Key")).toBe(false);
    expect(isSensitiveKey("us.needs_sponsorship_now", false)).toBe(true);
    expect(isSensitiveKey("contact.email", true)).toBe(false);
    expect(isSensitiveKey("custom.question", true)).toBe(true);
  });
});
