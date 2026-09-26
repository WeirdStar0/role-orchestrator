import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Context tests are pure SQLite + in-memory assembly (no git, no CLI),
    // but turbo runs many packages in parallel; give each test a generous
    // budget so a loaded machine cannot flake the suite.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
