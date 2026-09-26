import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The one test file drives the FULL dogfood chain: eight engine
    // executions (real fake-cli subprocesses), dozens of real git spawns,
    // one reconcile scan with a (non-consulted) probe hook and the whole
    // expansion/approval/recovery protocol.
    testTimeout: 240_000,
    hookTimeout: 240_000
  }
});
