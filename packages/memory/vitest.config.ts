import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Memory tests are pure SQLite (two-connection CAS included, no git, no
    // CLI), but turbo runs many packages in parallel; give each test a
    // generous budget so a loaded machine cannot flake the suite.
    testTimeout: 60_000,
    hookTimeout: 60_000
  }
});
