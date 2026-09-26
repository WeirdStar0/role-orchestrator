import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test file runs the FULL end-to-end chain: seven engine executions
    // (real fake-cli subprocesses) plus dozens of real git spawns, and the
    // files run concurrently under turbo's package-level parallelism.
    testTimeout: 240_000,
    hookTimeout: 240_000
  }
});
