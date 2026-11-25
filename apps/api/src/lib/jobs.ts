import type { Env } from "../env.js";

/** Starts .github/workflows/jobs.yml (fetch jobs, sync Gmail, optionally build one user's queue). */
export function startJobs(env: Env, inputs: Record<string, string>): Promise<Response> {
  return fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/jobs.yml/dispatches`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "my-career-agent",
      "content-type": "application/json",
    },
    body: JSON.stringify({ ref: "main", inputs }),
  });
}
