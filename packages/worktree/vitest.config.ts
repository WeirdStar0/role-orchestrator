import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test spawns dozens of real git processes; under turbo's parallel
    // package load a single spawn can take hundreds of ms (observed 8s for
    // the argv-trace test locally). Give the whole suite a generous budget.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
