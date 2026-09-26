import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Spawn-based tests (timeout, interrupt, grandchild tree-kill) need
    // generous margins to stay stable on loaded Windows machines; the ceiling
    // only bounds worst-case hangs, tests stay fast in practice.
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
