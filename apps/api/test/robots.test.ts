import { describe, expect, it } from "vitest";
import { allowedBy, parseRobots, robotsAllows } from "../src/lib/robots.js";

describe("robots.txt", () => {
  const txt = `User-agent: LinkedInBot\nAllow: /\n\nUser-agent: *\nDisallow: /internal\nDisallow: /search*?q=\nAllow: /internal/public$\n`;
  it("uses the * group when we're not named, longest rule wins", () => {
    const r = parseRobots(txt);
    expect(allowedBy(r, "/en/search.json?offset=0")).toBe(true);
    expect(allowedBy(r, "/internal/x")).toBe(false);
    expect(allowedBy(r, "/internal/public")).toBe(true);
    expect(allowedBy(r, "/search/a?q=1")).toBe(false);
  });
  it("blocks everything for a Disallow: / under *", () => {
    expect(allowedBy(parseRobots("User-agent: LinkedInBot\nAllow: /\nUser-agent: *\nDisallow: /"), "/v1/x")).toBe(false);
  });
  it("prefers a group that names us", () => {
    expect(allowedBy(parseRobots("User-agent: *\nDisallow: /\nUser-agent: MyCareerAgentBot\nAllow: /"), "/x")).toBe(true);
  });
  it("treats a missing file as allow-all and a server error as deny-all", async () => {
    const f404 = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    const f500 = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
    expect(await robotsAllows("https://a.example/x", f404)).toBe(true);
    expect(await robotsAllows("https://b.example/x", f500)).toBe(false);
  });
});
