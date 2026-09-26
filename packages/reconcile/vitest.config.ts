import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Serial test FILES: scan-processes hammers Win32_Process for minutes;
    // in parallel it starves scan-store's pure-DB tests past their default
    // 5s budget and perturbs the shared CIM service (product-gates run
    // 36234121720).
    fileParallelism: false,
    testTimeout: 120_000
  }
});
