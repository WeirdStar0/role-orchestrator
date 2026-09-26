import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The concurrency tests open several SQLite connections with short busy
    // timeouts; give the suite a generous budget like the store/review suites.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
