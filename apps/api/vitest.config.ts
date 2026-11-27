import { defineConfig } from "vitest/config";

// Tests stub fetch with their own fake sites, which have no robots.txt; robots handling has its own tests.
export default defineConfig({ test: { env: { MCA_SKIP_ROBOTS: "1", MCA_PACE_MS: "0" } } });
