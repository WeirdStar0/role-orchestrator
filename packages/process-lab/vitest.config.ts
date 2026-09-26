import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // These tests spawn real processes (cmd wrappers, PowerShell identity
    // queries, PID-reuse cohorts, WSL drivers) and wait on OS-level death.
    // The ceilings only bound worst-case hangs; steady-state waits poll.
    testTimeout: 120_000,
    hookTimeout: 60_000
  }
});
