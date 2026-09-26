/**
 * `ro-release-audit` — executable M6-03 check entry point.
 *
 * Sections (or `all`):
 *   secrets       repo-wide secret scan verdict + findings (A42/A36)
 *   dependencies  lockfile/package.json/registry/license/notices audit
 *   license       Apache-2.0 candidate verification
 *   governance    Codeowners / private channel / license / approval inventory
 *
 * Output: a single JSON document on stdout. Exit codes are the contract:
 *   0 — no release-blocking audit outcome (known reservations and
 *       maintainer-pending governance items are NOT blocking here; they are
 *       reported for the maintainer)
 *   1 — at least one blocking audit outcome (unclassified secret finding,
 *       dependency mismatch, missing integrity, candidate license divergence)
 *   2 — usage or precondition error
 */
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { scanSecrets } from "./secrets-scan.js";
import { auditDependencies } from "./dependency-audit.js";
import { checkLicenseCandidate } from "./license-check.js";
import { inventoryGovernance } from "./governance.js";
import { ReleaseAuditError } from "./errors.js";

export interface CliResult {
  readonly exitCode: 0 | 1 | 2;
  readonly output: string;
}

const ArgsSchema = z.strictObject({
  section: z.enum(["secrets", "dependencies", "license", "governance", "all"]).default("all"),
  repoRoot: z.string().min(1).default(process.cwd())
});

export interface ReleaseAuditReport {
  readonly section: string;
  readonly repoRoot: string;
  readonly secrets?: ReturnType<typeof scanSecrets> | undefined;
  readonly dependencies?: ReturnType<typeof auditDependencies> | undefined;
  readonly license?: ReturnType<typeof checkLicenseCandidate> | undefined;
  readonly governance?: ReturnType<typeof inventoryGovernance> | undefined;
  readonly blocking: readonly string[];
}

export function buildAuditReport(section: string, repoRoot: string): ReleaseAuditReport {
  const blocking: string[] = [];
  const wanted = (name: string): boolean => section === "all" || section === name;
  let secrets: ReturnType<typeof scanSecrets> | undefined;
  let dependencies: ReturnType<typeof auditDependencies> | undefined;
  let license: ReturnType<typeof checkLicenseCandidate> | undefined;
  let governance: ReturnType<typeof inventoryGovernance> | undefined;

  if (wanted("secrets")) {
    secrets = scanSecrets({ repoRoot });
    for (const finding of secrets.findings) {
      if (finding.classification === "needs-judgment") {
        blocking.push(`secrets: ${finding.file}:${finding.line} rule=${finding.rule} needs judgment`);
      }
    }
  }
  if (wanted("dependencies")) {
    dependencies = auditDependencies({ repoRoot });
    for (const mismatch of dependencies.specifierMismatches) {
      blocking.push(`dependencies: specifier mismatch: ${mismatch}`);
    }
    for (const missing of dependencies.missingIntegrity) {
      blocking.push(`dependencies: lockfile entry without integrity pin: ${missing}`);
    }
    for (const unknown of dependencies.unknownLicenses) {
      blocking.push(`dependencies: unknown license id "${unknown.license}" on ${unknown.name}@${unknown.version}`);
    }
  }
  if (wanted("license")) {
    license = checkLicenseCandidate({ repoRoot });
    if (license.status === "candidate-diverges") {
      blocking.push("license: candidate text diverges from canonical Apache-2.0 wording");
    }
    if (!license.candidateExists) {
      blocking.push("license: candidate file LICENSE.proposed.txt is missing");
    }
  }
  if (wanted("governance")) {
    governance = inventoryGovernance({ repoRoot });
  }
  return { section, repoRoot, blocking, secrets, dependencies, license, governance };
}

export async function runReleaseAuditCli(args: readonly string[]): Promise<CliResult> {
  let parsed: z.infer<typeof ArgsSchema>;
  try {
    parsed = ArgsSchema.parse({ section: args[0], repoRoot: args[1] === undefined ? undefined : args[1] });
  } catch (cause) {
    return {
      exitCode: 2,
      output: `usage: ro-release-audit [secrets|dependencies|license|governance|all] [repoRoot]\nerror: ${String(cause)}`
    };
  }
  try {
    const report = buildAuditReport(parsed.section, parsed.repoRoot);
    const exitCode: 0 | 1 = report.blocking.length > 0 ? 1 : 0;
    return { exitCode, output: `${JSON.stringify(report, null, 2)}\n` };
  } catch (cause) {
    const message = cause instanceof ReleaseAuditError ? cause.message : String(cause);
    return { exitCode: 2, output: `release-audit precondition failed: ${message}\n` };
  }
}

// Direct execution: `node .../dist/cli.js <section> [repoRoot]` (the bin entry).
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  void runReleaseAuditCli(process.argv.slice(2)).then((result) => {
    process.stdout.write(result.output);
    process.exitCode = result.exitCode;
  });
}
