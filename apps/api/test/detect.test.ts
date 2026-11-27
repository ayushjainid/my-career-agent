import { describe, expect, it } from "vitest";
import { boardsInPage, guessSite } from "../src/detect.js";

describe("career-site detector", () => {
  it("recognises job-system links in a careers page", () => {
    const html = `<a href="https://boards.greenhouse.io/acmeco/jobs/1">x</a> <iframe src="https://boards.greenhouse.io/embed/job_board?for=acmeco"></iframe>
      <a href="https://jobs.lever.co/acme-labs">x</a> <a href="https://acme.wd5.myworkdayjobs.com/en-US/External">x</a>
      <a href="https://ecxx.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions">x</a>
      <a href="https://acme.eightfold.ai/careers?domain=acme.com">x</a> <a href="https://acme.jobs.personio.de/">x</a>`;
    expect(boardsInPage(html).map((c) => `${c.vendor}:${c.board}`)).toEqual([
      "greenhouse:acmeco", "lever:acme-labs", "personio:acme.jobs.personio.de", "workday:acme.wd5.myworkdayjobs.com/External",
      "oracle:ecxx.fa.us2.oraclecloud.com|CX_1", "eightfold:acme.eightfold.ai|acme.com"]);
  });
  it("guesses the website from the name and checks the homepage names the company", async () => {
    const f = (async (url: string) => (url === "https://www.acme.com/" ? new Response("<title>Acme | Home</title>") : new Response("", { status: 404 }))) as unknown as typeof fetch;
    expect(await guessSite("ACME CORPORATION", f)).toBe("https://www.acme.com/");
    expect(await guessSite("ZETA ANALYTICS LLC", f)).toBeNull();
  });
});
