import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test file runs the FULL cross-CLI chain: two engine executions
    // (real fake-cli subprocesses) plus real git spawns, and the files run
    // concurrently under turbo's package-level parallelism.
    testTimeout: 240_000,
    hookTimeout: 240_000
  }
});
