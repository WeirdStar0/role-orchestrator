import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // The matrix runs REAL subprocesses (fake-cli dist bin, cmd placeholders,
    // PowerShell identity probes); one file at a time keeps the OS-level
    // windows deterministic without weakening any assertion.
    fileParallelism: false
  }
});
