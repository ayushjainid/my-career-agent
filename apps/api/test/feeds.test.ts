import { describe, expect, it } from "vitest";
import { countryCode, fetchSitemap, fetchTeamtailor, jobPostingsIn, parsePersonio } from "../src/ats/feeds.js";
import { fetchAmazon, fetchOracle } from "../src/ats/sites.js";

const jp = (title: string, country = "US") => `<html><script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "JobPosting", title,
  description: "<p>Build things. 5+ years of Go. $150,000 - $190,000 a year</p>", datePosted: "2026-11-20",
  jobLocation: { "@type": "Place", address: { addressLocality: "Austin", addressRegion: "TX", addressCountry: country } } }] })}</script></html>`;

describe("schema.org JobPosting", () => {
  it("finds postings inside @graph and reads country names and codes", () => {
    expect(jobPostingsIn(jp("Engineer"))).toHaveLength(1);
    expect(countryCode("United Kingdom")).toBe("GB");
    expect(countryCode({ "@type": "Country", name: "IRL" })).toBe("IE");
  });
});

describe("sitemap reader", () => {
  const site = (calls: string[]) => (async (url: string) => {
    calls.push(url);
    if (url.endsWith("/sitemap.xml")) return new Response(`<sitemapindex><sitemap><loc>https://jobs.example.com/sitemap-jobs.xml</loc></sitemap></sitemapindex>`);
    if (url.endsWith("/sitemap-jobs.xml")) return new Response(`<urlset>
      <url><loc>https://jobs.example.com/job/austin/senior-software-engineer/1</loc></url>
      <url><loc>https://jobs.example.com/job/austin/store-associate/2</loc></url>
      <url><loc>https://jobs.example.com/job/london/data-engineer/3</loc></url>
      <url><loc>https://jobs.example.com/job/pune/backend-developer/4</loc></url>
      <url><loc>https://jobs.example.com/about</loc></url></urlset>`);
    const t = url.split("/")[5]!;
    return new Response(jp(t, t === "data-engineer" ? "GB" : t === "backend-developer" ? "IN" : "US"));
  }) as unknown as typeof fetch;

  it("reads job pages for tech titles only, keeps the five countries, and touches known ones", async () => {
    const calls: string[] = [];
    const r = await fetchSitemap("https://jobs.example.com/sitemap.xml|/job/", { fetcher: site(calls), gapMs: 0, known: new Set(["/job/london/data-engineer/3"]) });
    expect(r.complete).toBe(true);
    expect(r.touch).toEqual(["/job/london/data-engineer/3"]);
    expect(r.jobs.map((j) => j.title)).toEqual(["senior-software-engineer"]); // India dropped, store role never fetched
    expect(calls.some((c) => c.includes("store-associate"))).toBe(false);
    expect(r.jobs[0]).toMatchObject({ atsVendor: "sitemap", atsJobId: "/job/austin/senior-software-engineer/1", locationText: "Austin, TX, US", pay: { min: 150000, max: 190000 } });
  });
});

describe("Teamtailor and Personio", () => {
  it("follows the feed's next_url and keeps the board name", async () => {
    const f = (async (url: string) => new Response(JSON.stringify(url.includes("page=2")
      ? { title: "Acme", items: [{ id: 2, url: "https://acme.teamtailor.com/jobs/2", _jobposting: { "@type": "JobPosting", title: "Data Engineer", jobLocation: { address: { addressCountry: "IT" } } } }] }
      : { title: "Acme", next_url: "https://acme.teamtailor.com/jobs.json?page=2", items: [{ id: 1, url: "u", _jobposting: { "@type": "JobPosting", title: "Backend Engineer" } }] }))) as unknown as typeof fetch;
    const r = await fetchTeamtailor("acme", { fetcher: f, gapMs: 0 });
    expect(r).toMatchObject({ name: "Acme", complete: true });
    expect(r.jobs.map((j) => j.title)).toEqual(["Backend Engineer", "Data Engineer"]);
  });
  it("parses Personio's XML", () => {
    const jobs = parsePersonio(`<workzag-jobs><position><id>42</id><office>Milan</office><name>Software Engineer</name><createdAt>2026-11-01T10:00:00+00:00</createdAt>
      <jobDescriptions><jobDescription><name>About</name><value><![CDATA[<p>Python and Go</p>]]></value></jobDescription></jobDescriptions></position></workzag-jobs>`, "acme.jobs.personio.de");
    expect(jobs[0]).toMatchObject({ atsVendor: "personio", atsJobId: "42", title: "Software Engineer", locationText: "Milan", applyUrl: "https://acme.jobs.personio.de/job/42" });
    expect(jobs[0]!.descriptionText).toContain("Python and Go");
  });
});

describe("career sites", () => {
  it("Amazon: reads each country and category until the reported hits, with full text", async () => {
    const f = (async (url: string) => {
      const u = new URL(url);
      const one = u.searchParams.get("country") === "USA" && u.searchParams.get("category[]") === "software-development";
      return new Response(JSON.stringify({ hits: one ? 1 : 0, jobs: one ? [{ id_icims: "77", title: "SDE II", normalized_location: "Seattle, WA, USA", posted_date: "November 25, 2026",
        job_path: "/en/jobs/77/sde-ii", description: "Build services.", basic_qualifications: "- 3+ years of Java" }] : [] }));
    }) as unknown as typeof fetch;
    const r = await fetchAmazon("amazon", { fetcher: f, gapMs: 0 });
    expect(r.complete).toBe(true);
    expect(r.jobs).toHaveLength(1);
    expect(r.jobs[0]).toMatchObject({ atsJobId: "77", applyUrl: "https://www.amazon.jobs/en/jobs/77/sde-ii" });
    expect(r.jobs[0]!.descriptionText).toContain("3+ years of Java");
  });
  it("Oracle: a 429 midway keeps what was read and closes nothing", async () => {
    let n = 0;
    const f = (async (url: string) => {
      if (url.includes("recruitingCEJobRequisitions")) {
        n++;
        if (n > 1) return new Response("", { status: 429 });
        return new Response(JSON.stringify({ items: [{ TotalJobsCount: 300, requisitionList: Array.from({ length: 100 }, (_, i) => ({ Id: String(i), Title: i ? "Branch Teller" : "Software Engineer", PrimaryLocationCountry: "US" })) }] }));
      }
      return new Response(JSON.stringify({ items: [{ ExternalDescriptionStr: "<p>Java</p>" }] }));
    }) as unknown as typeof fetch;
    const r = await fetchOracle("x.fa.oraclecloud.com|CX_1", { fetcher: f, gapMs: 0 });
    expect(r.complete).toBe(false);
    expect(r.jobs.map((j) => j.title)).toEqual(["Software Engineer"]);
  });
});
