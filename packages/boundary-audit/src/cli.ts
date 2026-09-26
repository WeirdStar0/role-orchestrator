/**
 * `ro-boundary-audit` — executable M7-04 boundary check entry point.
 *
 * Output: a single JSON document (the BoundaryAuditResult) on stdout.
 * Exit codes are the contract:
 *   0 — verdict "pass": no boundary violation found
 *   1 — verdict "fail": at least one boundary violation
 *   2 — usage or precondition error (bad args, missing root/manifest)
 */
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { auditCommercialBoundary } from "./audit.js";
import { BoundaryAuditError } from "./errors.js";

export interface CliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly output: string;
}

const ArgsSchema = z.strictObject({
  repoRoot: z.string().min(1).default(process.cwd())
});

export async function runBoundaryAuditCli(args: readonly string[]): Promise<CliResult> {
  // Flags are not supported; a leading "-" can never be a legitimate
  // repoRoot, so it is a usage error instead of being parsed as a path.
  if (args.length > 1 || args.some((arg) => arg.startsWith("-"))) {
    return {
      exitCode: 2,
      output:
        "usage: ro-boundary-audit [repoRoot]\nerror: at most one positional argument (repoRoot); flags are not supported\n"
    };
  }
  let parsed: z.infer<typeof ArgsSchema>;
  try {
    parsed = ArgsSchema.parse({ repoRoot: args[0] === undefined ? undefined : args[0] });
  } catch (cause) {
    return {
      exitCode: 2,
      output: `usage: ro-boundary-audit [repoRoot]\nerror: ${String(cause)}\n`
    };
  }
  try {
    const result = auditCommercialBoundary(parsed);
    return { exitCode: result.verdict === "pass" ? 0 : 1, output: `${JSON.stringify(result, null, 2)}\n` };
  } catch (cause) {
    const message = cause instanceof BoundaryAuditError ? cause.message : String(cause);
    return { exitCode: 2, output: `boundary-audit precondition failed: ${message}\n` };
  }
}

// Direct execution: `node .../dist/cli.js [repoRoot]` (the bin entry).
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  void runBoundaryAuditCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  });
}
