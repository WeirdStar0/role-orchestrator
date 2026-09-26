import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The A07 stress tests (multi-connection contention + worker_threads)
    // genuinely take seconds, not milliseconds; the suite still fails, never
    // skips, when an invariant is violated.
    testTimeout: 60_000
  }
});
