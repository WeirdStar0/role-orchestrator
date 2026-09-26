import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Spawn-based scenario tests need generous margins on loaded Windows CI
    // machines; the ceiling only bounds worst-case hangs.
    testTimeout: 90_000,
    hookTimeout: 60_000
  }
});
