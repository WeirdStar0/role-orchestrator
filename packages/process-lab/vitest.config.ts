import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Serial test FILES: every file hammers Win32_Process/PowerShell; on a
    // 2-core CI runner, parallel files saturate the CIM service and identity
    // queries intermittently return nothing (product-gates run 36228095295).
    fileParallelism: false,
    // These tests spawn real processes (cmd wrappers, PowerShell identity
    // queries, PID-reuse cohorts, WSL drivers) and wait on OS-level death.
    // The ceilings only bound worst-case hangs; steady-state waits poll.
    // Budgets at the reconcile suite class (240-360s there): on CI runners a
    // single cold Win32_Process query can cost 15-30s, and one test chains
    // several identity queries plus bounded taskkill/expectPidGone waits.
    testTimeout: 300_000,
    hookTimeout: 120_000
  }
});
