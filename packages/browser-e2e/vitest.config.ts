import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test file launches a real Chromium, a live local-api server and
    // real fake-cli subprocesses over real git fixtures, and runs several
    // engine executions per flow. The files run concurrently under turbo's
    // package-level parallelism, so generous timeouts absorb Windows spawn
    // jitter without ever masking a real failure.
    testTimeout: 240_000,
    hookTimeout: 240_000
  }
});
