import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test spawns real git processes plus validation commands; under
    // turbo's parallel package load a single spawn can take hundreds of ms.
    // Give the whole suite a generous budget (same as worktree/integration).
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
