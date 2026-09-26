import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The dispatch/execute test spawns the fake-cli child process and the
    // review-fixture tests create git repositories in the system temp dir;
    // give the suite the same generous budget as the engine/review suites.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
