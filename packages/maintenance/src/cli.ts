#!/usr/bin/env node
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { openDatabase } from "@role-orchestrator/store";
import { GitRunner } from "@role-orchestrator/worktree";
import { runUpgradeRecoveryDrill } from "./backup-drill.js";
import { executeCleanup } from "./cleanup.js";
import { planCleanup } from "./inventory.js";
import type { CleanupPlan } from "./inventory.js";
import { MaintenanceError } from "./errors.js";

/**
 * Minimal operations CLI for M6-02 (runbook companion). Every command prints
 * a JSON document and exits 0 only when the operation fully succeeded:
 *
 * - `upgrade-drill [--work-dir <dir>]`
 *       Runs the A41 upgrade-failure recovery drill on the real daemon
 *       migration chain in a temp directory and prints the report.
 * - `cleanup-plan --db <path> [--repo <path> --worktrees-root <path>]
 *       [--temp-root <path>] [--evidence-root <path>]... [--clean-published-outbox]
 *       Builds the dry-run inventory (the plan) and prints it. Deletes NOTHING.
 * - `cleanup-execute --plan-file <plan.json> [--confirm <itemId>]... [--now <ts>]`
 *       Executes a previously printed plan; only item ids passed via
 *       --confirm can bypass the A40 default refusal.
 *
 * Exit codes: 0 success · 1 operation error · 2 usage error.
 */

export interface MaintenanceCliResult {
  readonly exitCode: number;
  readonly output: string;
}

const USAGE = `usage:
  ro-maintenance upgrade-drill [--work-dir <dir>]
  ro-maintenance cleanup-plan --db <path> [--repo <path> --worktrees-root <path>]
      [--temp-root <path>] [--evidence-root <path>]... [--clean-published-outbox] [--now <ts>]
  ro-maintenance cleanup-execute --plan-file <plan.json> [--confirm <itemId>]... [--now <ts>]`;

interface ParsedArgs {
  readonly command: string;
  readonly flags: Map<string, string[]>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const command = argv[0] ?? "";
  const flags = new Map<string, string[]>();
  let current: string | null = null;
  for (const arg of argv.slice(1)) {
    if (arg.startsWith("--")) {
      current = arg.slice(2);
      flags.set(current, []);
      continue;
    }
    if (current === null) {
      throw new MaintenanceError(`unexpected argument "${arg}" (${USAGE})`);
    }
    flags.get(current)?.push(arg);
  }
  return { command, flags };
}

function requiredSingle(flags: Map<string, string[]>, name: string): string {
  const values = flags.get(name);
  if (values === undefined || values.length !== 1 || values[0] === "") {
    throw new MaintenanceError(`missing required --${name} (${USAGE})`);
  }
  return values[0] ?? "";
}

async function run(argv: readonly string[]): Promise<MaintenanceCliResult> {
  const parsed = parseArgs(argv);
  const emit = (payload: unknown): MaintenanceCliResult => ({
    exitCode: 0,
    output: JSON.stringify(payload, null, 2)
  });

  switch (parsed.command) {
    case "upgrade-drill": {
      const workDir = parsed.flags.get("work-dir")?.[0] ?? mkdtempSync(path.join(os.tmpdir(), "ro-maintenance-drill-"));
      const report = await runUpgradeRecoveryDrill({ workDir });
      return emit(report);
    }
    case "cleanup-plan": {
      const dbPath = requiredSingle(parsed.flags, "db");
      const db = openDatabase(dbPath);
      try {
        const git = new GitRunner();
        const plan = await planCleanup(db, git, {
          now: parsed.flags.get("now")?.[0] ?? new Date().toISOString(),
          repoPath: parsed.flags.get("repo")?.[0],
          worktreesRoot: parsed.flags.get("worktrees-root")?.[0],
          tempRoot: parsed.flags.get("temp-root")?.[0],
          evidenceRoots: parsed.flags.get("evidence-root"),
          cleanPublishedOutboxRows: parsed.flags.has("clean-published-outbox")
        });
        return emit(plan);
      } finally {
        db.close();
      }
    }
    case "cleanup-execute": {
      const planFile = requiredSingle(parsed.flags, "plan-file");
      const plan = JSON.parse(readFileSync(planFile, "utf8")) as CleanupPlan;
      const db = openDatabase(plan.databasePath);
      try {
        const git = new GitRunner();
        const receipt = await executeCleanup(db, git, plan, {
          now: parsed.flags.get("now")?.[0] ?? new Date().toISOString(),
          confirmations: parsed.flags.get("confirm")
        });
        return { exitCode: receipt.totals.failed > 0 ? 1 : 0, output: JSON.stringify(receipt, null, 2) };
      } finally {
        db.close();
      }
    }
    case "":
    case "help":
    case "--help":
      return { exitCode: 2, output: USAGE };
    default:
      return { exitCode: 2, output: `unknown command "${parsed.command}"\n${USAGE}` };
  }
}

/**
 * Entry point usable programmatically (tests call this) or from the shell.
 * Never throws: errors are printed as JSON and mapped to exit code 1.
 */
export async function runMaintenanceCli(argv: readonly string[]): Promise<MaintenanceCliResult> {
  try {
    return await run(argv);
  } catch (error) {
    const name = error instanceof Error ? error.name : "Error";
    const message = error instanceof Error ? error.message : String(error);
    return {
      exitCode: 1,
      output: JSON.stringify({ error: name, message }, null, 2)
    };
  }
}

// Direct execution: `node .../dist/cli.js <command>` (the bin entry).
const invoked = process.argv[1];
if (invoked !== undefined && import.meta.url === pathToFileURL(invoked).href) {
  void runMaintenanceCli(process.argv.slice(2)).then((result) => {
    if (result.output.length > 0) process.stdout.write(`${result.output}\n`);
    process.exitCode = result.exitCode;
  });
}
