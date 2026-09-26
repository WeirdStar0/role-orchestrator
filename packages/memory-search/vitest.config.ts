import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Retrieval/isolation tests are pure SQLite except the one git-fixture
    // staleness test (temp repo under the SYSTEM temp dir); turbo runs many
    // packages in parallel, so keep a generous budget to avoid load flakes.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
