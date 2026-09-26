import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Every test file launches a real Chromium, a live local-api server and
    // real fake-cli subprocesses over real git fixtures, and runs several
    // engine executions per flow. The files run concurrently under turbo's
    // package-level parallelism, so generous timeouts absorb Windows spawn
    // jitter without ever masking a real failure.
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // POLISH-1 evidence rotation: regular vitest runs of this package opt in
    // to same-label run-directory rotation (keep newest K, delete older).
    // The library default stays OFF; rotation is structurally unable to
    // delete the CURRENT run's directory (excluded by name), any other
    // label's directories, or anything outside the evidence root — so no
    // test can observe its own evidence vanishing mid-run. See
    // src/evidence.ts and reports/POLISH-1.md.
    env: {
      BROWSER_E2E_EVIDENCE_ROTATION: "1"
    }
  }
});
