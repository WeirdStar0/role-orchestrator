/**
 * Thin executable entry for the standalone serve process (bin:
 * role-orchestrator-local-api-serve). All argument semantics live in
 * serve.ts; this file only wires argv -> parse -> run and maps ANY failure
 * to a stderr line plus exit code 1.
 *
 * Parent contract (desktop shell, ADR reports/M8-03-desktop-shell-adr.md):
 * spawn with an ARGV ARRAY, never a shell; judge liveness exclusively by an
 * HTTP probe against the bound loopback port — never by this process's
 * stdout text.
 */
import { parseServeArgs, runServe } from "./serve.js";

try {
  await runServe(parseServeArgs(process.argv.slice(2)));
} catch (error) {
  process.stderr.write(
    `role-orchestrator-local-api-serve: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exitCode = 1;
}
