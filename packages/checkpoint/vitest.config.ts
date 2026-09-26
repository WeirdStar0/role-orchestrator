import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The E2E suites spawn the fake-cli dist bin (dogfood) and wait on real
    // process exits; give the suite the same generous budget as engine/review.
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
