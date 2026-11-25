// With no jobs in the catalog, building the queue says why instead of reporting a silent zero.
import { expect, it } from "vitest";
import { harness, TOKEN_A } from "./harness.js";

it("explains an empty catalog", async () => {
  const h = await harness();
  await h.setupProfile(TOKEN_A);
  const r = await h.json(await h.call("POST", "/queue/build", TOKEN_A));
  expect(r).toMatchObject({ queued: 0, excluded: 0, heldBack: 0 });
  expect(r.note).toMatch(/no open jobs to choose from yet/);
});
