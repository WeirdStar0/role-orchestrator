import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every suite in this package is pure SQLite + pure functions (no child
    // processes, no git fixtures), but the repo convention keeps the same
    // generous budget as the other suites so a loaded machine never turns
    // scheduling latency into a flaky failure.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
