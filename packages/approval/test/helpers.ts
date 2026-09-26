/**
 * Shared test plumbing for the M4-01 approval suite.
 *
 * Everything here is pure SQLite (no git, no processes, no network): the
 * concurrency tests open SEPARATE connections to the same file-backed
 * database under the SYSTEM temp directory — never inside H:\role-orchestrator,
 * which stays a non-git area.
 */
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { appliedMigrationRecords, createProject, createTaskRun, openDatabase } from "@role-orchestrator/store";
import { applyApprovalMigrations, type ActionDescriptor } from "../src/index.js";

/** Fixed clock base so expiry comparisons are deterministic. */
export const T0 = "2026-09-23T00:00:00.000Z";
/** 1 second after T0. */
export const T1 = "2026-09-23T00:00:01.000Z";
/** 1 hour after T0. */
export const T_PLUS_1H = "2026-09-23T01:00:00.000Z";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export interface World {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly scratchDir: string;
  readonly runId: string;
  close(): void;
}

/**
 * Fully migrated world (migrations 001..011) with one project and one
 * TaskRun — enough for the approvals table's requester FK.
 */
export function createApprovalWorld(label: string): World {
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), `ro-approval-${label}-`));
  const dbPath = path.join(scratchDir, "store.db");
  const db = openDatabase(dbPath);
  void applyApprovalMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 11 || records[10]?.version !== 11) {
    db.close();
    throw new Error("test helper: migrations 001..011 were not applied");
  }
  createProject(db, {
    id: "proj-1",
    repoRoot: path.join(scratchDir, "repo"),
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  const runId = "run-1";
  createTaskRun(db, {
    id: runId,
    projectId: "proj-1",
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "hash-config-1",
    baseSha: SHA_A,
    now: T0
  });
  return { db, dbPath, scratchDir, runId, close: () => db.close() };
}

let argvCounter = 0;

/**
 * A controlled local write action (medium-baseline: managed-worktree write,
 * no permission increments, verified capabilities only). NOT high risk by
 * itself — the tests push individual elements into the high-risk range.
 * All values are literal (no machine-specific paths) so digests computed
 * from this descriptor are reproducible on any machine.
 */
export function sampleAction(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  argvCounter += 1;
  return {
    runtime: "codex",
    argv: ["fake-codex", "exec", "--json", "--scenario", `success-${String(argvCounter)}`],
    cwd: "h:/worktrees/demo-exec",
    repo: {
      root: "h:/repos/demo",
      baseSha: SHA_A,
      targetSha: SHA_B
    },
    profileRevision: "rev-1",
    requiredPermissions: ["repo.write"],
    grantedPermissions: ["repo.read", "repo.write"],
    dimensions: ["write"],
    writeScope: "managed-worktree",
    requiredCapabilities: ["codex.noninteractive-entry"],
    ...overrides
  };
}

/** A high-risk variant (permission elevation) used for approval-then-consume flows. */
export function highRiskAction(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return sampleAction({
    dimensions: ["write", "network"],
    requiredCapabilities: ["codex.noninteractive-entry", "codex.structured-business-output"],
    ...overrides
  });
}
