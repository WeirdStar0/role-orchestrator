import { mkdirSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import {
  MigrationError,
  applyMigrations,
  appendEvent,
  createActiveAttempt,
  createProject,
  createTaskRun,
  enqueueOutboxMessage,
  inspectBackupFile,
  openDatabase,
  restoreBackup,
  setAttemptPhase,
  verifyEventChecksums,
  verifyMigrations
} from "@role-orchestrator/store";
import { proposeMemory } from "@role-orchestrator/memory";
import { createApproval } from "@role-orchestrator/approval";
import { DAEMON_CHAIN_MAX_VERSION, DAEMON_MIGRATIONS } from "./chain.js";
import { RecoveryDrillError } from "./errors.js";

/**
 * The EXECUTABLE upgrade-failure recovery runbook (A41, M6-02).
 *
 * `runUpgradeRecoveryDrill` performs the whole story the README documents on
 * REAL databases with the REAL daemon migration chain (001..017) and REAL
 * business data (run / execution / events / memory / outbox / approval),
 * seeded through the owning packages' public APIs:
 *
 * - Scenario A — clean failure: a new migration 018 with broken SQL fails and
 *   ROLLS BACK. The database remains at 017, fully readable and checksum-
 *   verified. Recovery = fix the migration code and re-run; nothing was
 *   recorded, so the corrected 018 is NOT a "replay of a bad migration".
 * - Scenario B — damaged state, restore from the pre-upgrade backup: the
 *   same failed upgrade, but this time the database is additionally damaged
 *   (simulating the "upgrade regretted / partially applied by hand" state).
 *   verifyMigrations refuses (checksum-mismatch), so the runbook path is:
 *   close all connections -> inspect the pre-upgrade backup -> restore with
 *   `expectedMigrations` -> verify migrations AND business data -> apply the
 *   FIXED 018.
 *
 * The drill never fakes a pass: every invariant is checked against real
 * queries, and any violation throws RecoveryDrillError (the drill failing is
 * a bug in the drill or the framework, never an ops event).
 */

const DrillInputSchema = z.strictObject({
  /** Absolute directory the drill may create its two scenario databases in. */
  workDir: z
    .string()
    .min(1)
    .max(2048)
    .refine((value) => path.isAbsolute(value), { message: "must be an absolute path" }),
  now: z.string().min(1).optional()
});

export interface UpgradeRecoveryDrillInput {
  readonly workDir: string;
  readonly now?: string | undefined;
}

export interface DrillSeededCounts {
  readonly projects: number;
  readonly runs: number;
  readonly executions: number;
  readonly events: number;
  readonly memories: number;
  readonly outboxMessages: number;
  readonly approvals: number;
}

export interface DrillStep {
  readonly step: number;
  readonly action: string;
  readonly result: string;
}

export interface DrillScenarioA {
  readonly dbPath: string;
  readonly badMigrationVersion: number;
  readonly failureKind: "application-failed";
  /** verifyMigrations right after the failure: 001..017, ok. */
  readonly verifyVersionsAfterFailure: readonly number[];
  readonly fixedVersionApplied: readonly number[];
  readonly verifyVersionsAfterFix: readonly number[];
}

export interface DrillScenarioB {
  readonly dbPath: string;
  readonly backupPath: string;
  readonly damage: "schema_migrations checksum of 017 tampered";
  readonly verifyErrorAfterDamage: "checksum-mismatch";
  readonly backupInspectionBytes: number;
  readonly restoredBytes: number;
  readonly restoredVerifiedMigrationCount: number;
  readonly verifyVersionsAfterRestore: readonly number[];
  readonly seededDataIntact: boolean;
  readonly fixedVersionApplied: readonly number[];
  readonly verifyVersionsAfterFix: readonly number[];
}

export interface UpgradeRecoveryDrillReport {
  readonly executedAt: string;
  readonly daemonChainVersions: readonly number[];
  readonly seeded: DrillSeededCounts;
  readonly scenarioA: DrillScenarioA;
  readonly scenarioB: DrillScenarioB;
  /** The runbook steps as actually executed, for the operator's audit log. */
  readonly steps: readonly DrillStep[];
}

// The deliberately broken upgrade: unbalanced paren => guaranteed SQL error,
// in a transaction that also rolls back the schema_migrations reservation.
const BAD_MIGRATION_NAME = "018-drill-broken-upgrade";
const FIXED_MIGRATION_NAME = "018-drill-fixed-upgrade";

const DRILL_ID_PREFIXES = {
  project: "proj-drill",
  run: "run-drill",
  execution: "exec-drill",
  node: "node-drill",
  eventA: "ev-drill-a",
  eventB: "ev-drill-b",
  memory: "mem-drill",
  outbox: "msg-drill",
  approval: "apr-drill"
} as const;

interface Seeded {
  readonly counts: DrillSeededCounts;
}

function count(db: DatabaseSync, sql: string): number {
  const row = db.prepare(sql).get();
  const value = row?.n;
  if (typeof value !== "number") {
    throw new RecoveryDrillError(`count query returned no numeric n (${sql})`);
  }
  return value;
}

function seededCounts(db: DatabaseSync): DrillSeededCounts {
  return {
    projects: count(db, "SELECT COUNT(*) AS n FROM projects"),
    runs: count(db, "SELECT COUNT(*) AS n FROM task_runs"),
    executions: count(db, "SELECT COUNT(*) AS n FROM executions"),
    events: count(db, "SELECT COUNT(*) AS n FROM events"),
    memories: count(db, "SELECT COUNT(*) AS n FROM memories"),
    outboxMessages: count(db, "SELECT COUNT(*) AS n FROM outbox"),
    approvals: count(db, "SELECT COUNT(*) AS n FROM approvals")
  };
}

/**
 * Seed one scenario database with the full daemon chain and REAL business
 * data written through the owning packages' public APIs.
 */
async function seedDaemonDatabase(db: DatabaseSync, now: string): Promise<Seeded> {
  const applied = await applyMigrations(db, { now, migrations: DAEMON_MIGRATIONS });
  if (applied.appliedVersions.length !== DAEMON_CHAIN_MAX_VERSION) {
    throw new RecoveryDrillError(
      `expected the full daemon chain to apply (${String(DAEMON_CHAIN_MAX_VERSION)} migrations), got ${String(applied.appliedVersions.length)}`
    );
  }

  createProject(db, {
    id: DRILL_ID_PREFIXES.project,
    repoRoot: "h:/repos/drill-fixture",
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now
  });
  createTaskRun(db, {
    id: DRILL_ID_PREFIXES.run,
    projectId: DRILL_ID_PREFIXES.project,
    taskId: "task-drill",
    graphRevision: 0,
    configSnapshotHash: "hash-drill-config",
    baseSha: "0".repeat(40),
    now
  });
  createActiveAttempt(db, {
    id: DRILL_ID_PREFIXES.execution,
    runId: DRILL_ID_PREFIXES.run,
    nodeId: DRILL_ID_PREFIXES.node,
    definitionRevision: "rev-drill-1",
    attempt: 1,
    dispatchToken: "dt-drill-1",
    phase: "STARTING",
    now
  });
  setAttemptPhase(db, { id: DRILL_ID_PREFIXES.execution, phase: "SUCCEEDED", now });

  appendEvent(db, {
    id: DRILL_ID_PREFIXES.eventA,
    executionId: DRILL_ID_PREFIXES.execution,
    seq: 0,
    type: "started",
    payload: { synthetic: true },
    occurredAt: now
  });
  appendEvent(db, {
    id: DRILL_ID_PREFIXES.eventB,
    executionId: DRILL_ID_PREFIXES.execution,
    seq: 1,
    type: "result_reported",
    payload: { synthetic: true, artifactRefs: [] },
    occurredAt: now
  });

  proposeMemory(db, {
    id: DRILL_ID_PREFIXES.memory,
    projectId: DRILL_ID_PREFIXES.project,
    type: "discovery",
    content: "Drill fixture memory: the fake CLI reports artifact_reported events for every written file.",
    evidenceRefs: [],
    actor: { kind: "role", roleId: "developer", executionId: DRILL_ID_PREFIXES.execution },
    now
  });

  enqueueOutboxMessage(db, {
    id: DRILL_ID_PREFIXES.outbox,
    aggregateId: DRILL_ID_PREFIXES.run,
    type: "run.completed",
    payload: { synthetic: true },
    now
  });

  createApproval(db, {
    idempotencyKey: "drill-approval-1",
    action: {
      runtime: "claude",
      argv: ["fake-cli", "--print", "hello"],
      cwd: "h:/repos/drill-fixture",
      repo: { root: "h:/repos/drill-fixture", baseSha: "0".repeat(40), targetSha: null },
      profileRevision: "rev-drill-1",
      requiredPermissions: [],
      grantedPermissions: [],
      dimensions: ["readonly"],
      writeScope: null,
      requiredCapabilities: []
    },
    ttlSeconds: 3600,
    now
  });

  const counts = seededCounts(db);
  if (
    counts.projects !== 1 ||
    counts.runs !== 1 ||
    counts.executions !== 1 ||
    counts.events !== 2 ||
    counts.memories !== 1 ||
    counts.outboxMessages !== 1 ||
    counts.approvals !== 1
  ) {
    throw new RecoveryDrillError(`seeded counts wrong: ${JSON.stringify(counts)}`);
  }
  if (verifyEventChecksums(db).length !== 0) {
    throw new RecoveryDrillError("seeded events failed checksum verification");
  }
  return { counts };
}

function assertBusinessDataIntact(db: DatabaseSync, expected: DrillSeededCounts): boolean {
  const actual = seededCounts(db);
  return JSON.stringify(actual) === JSON.stringify(expected);
}

/**
 * Run the full upgrade-failure recovery drill. See the module doc for the
 * scenario semantics; `packages/maintenance/README.md` holds the human
 * runbook this drill proves.
 */
export async function runUpgradeRecoveryDrill(input: UpgradeRecoveryDrillInput): Promise<UpgradeRecoveryDrillReport> {
  const value = DrillInputSchema.parse(input);
  const now = value.now ?? new Date().toISOString();
  mkdirSync(value.workDir, { recursive: true });

  const badVersion = DAEMON_CHAIN_MAX_VERSION + 1;
  const badMigration = {
    version: badVersion,
    name: BAD_MIGRATION_NAME,
    upSql: "CREATE TABLE drill_broken (id TEXT PRIMARY KEY STRICT;"
  };
  const fixedMigration = {
    version: badVersion,
    name: FIXED_MIGRATION_NAME,
    upSql: "CREATE TABLE drill_fixed (id TEXT PRIMARY KEY, note TEXT NOT NULL) STRICT;"
  };
  const steps: DrillStep[] = [];
  let stepNumber = 0;
  const step = (action: string, result: string): void => {
    stepNumber += 1;
    steps.push({ step: stepNumber, action, result });
  };

  // ============================ Scenario A =================================
  const pathA = path.join(value.workDir, "scenario-a.db");
  const dbA = openDatabase(pathA);
  let seededA: DrillSeededCounts;
  let scenarioA: DrillScenarioA;
  try {
    step("seed scenario A", `full daemon chain 001..${String(DAEMON_CHAIN_MAX_VERSION)} + business data (run/execution/events/memory/outbox/approval)`);
    seededA = (await seedDaemonDatabase(dbA, now)).counts;

    let failureVersion: number | null = null;
    let failureKind: string | null = null;
    try {
      await applyMigrations(dbA, {
        now,
        migrations: [...DAEMON_MIGRATIONS, badMigration]
      });
    } catch (error) {
      if (error instanceof MigrationError) {
        failureKind = error.kind;
        failureVersion = error.version;
      } else {
        throw error;
      }
    }
    if (failureKind !== "application-failed" || failureVersion !== badVersion) {
      throw new RecoveryDrillError(
        `scenario A: expected MigrationError(application-failed, ${String(badVersion)}), got kind=${String(failureKind)} version=${String(failureVersion)}`
      );
    }
    step(
      "apply broken migration 018 (Scenario A)",
      `MigrationError(application-failed, version ${String(badVersion)}) — the transaction rolled back the DDL AND the version reservation`
    );

    const verifyA = verifyMigrations(dbA, { migrations: DAEMON_MIGRATIONS });
    if (!assertBusinessDataIntact(dbA, seededA)) {
      throw new RecoveryDrillError("scenario A: business data changed after a failed migration");
    }
    step(
      "verify database after failure (Scenario A)",
      `verifyMigrations ok at 001..${String(DAEMON_CHAIN_MAX_VERSION)}; all seeded data readable; NO restore needed`
    );

    const fixedA = await applyMigrations(dbA, {
      now,
      migrations: [...DAEMON_MIGRATIONS, fixedMigration]
    });
    const verifyAFixed = verifyMigrations(dbA, {
      migrations: [...DAEMON_MIGRATIONS, fixedMigration]
    });
    if (!assertBusinessDataIntact(dbA, seededA)) {
      throw new RecoveryDrillError("scenario A: business data changed after the fixed migration");
    }
    step(
      "fix the migration code and re-run (Scenario A)",
      `corrected 018 applied (${fixedA.appliedVersions.join(", ")}) — legitimate because the failed attempt recorded NOTHING; not a replay of a bad migration`
    );

    scenarioA = {
      dbPath: pathA,
      badMigrationVersion: badVersion,
      failureKind: "application-failed",
      verifyVersionsAfterFailure: verifyA.versions,
      fixedVersionApplied: fixedA.appliedVersions,
      verifyVersionsAfterFix: verifyAFixed.versions
    };
  } finally {
    dbA.close();
  }

  // ============================ Scenario B =================================
  const pathB = path.join(value.workDir, "scenario-b.db");
  const backupPathB = `${pathB}.pre-upgrade.db`;
  const dbB = openDatabase(pathB);
  let dbBClosed = false;
  let seededB: DrillSeededCounts;
  let inspectionBytes: number;
  let restoredBytes: number;
  let restoredVerifiedMigrationCount: number;
  let verifyVersionsAfterRestore: readonly number[];
  let verifyErrorAfterDamage: "checksum-mismatch";
  let dataIntactAfterRestore: boolean;
  let fixedApplied: readonly number[];
  let verifyVersionsAfterFix: readonly number[];
  try {
    seededB = (await seedDaemonDatabase(dbB, now)).counts;
    step("seed scenario B", "same full chain + business data as scenario A");

    // The upgrade request carries backupPath: the pre-upgrade backup is
    // written BEFORE the first pending migration.
    try {
      await applyMigrations(dbB, {
        now,
        migrations: [...DAEMON_MIGRATIONS, badMigration],
        backupPath: backupPathB
      });
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error;
    }
    const backupInspection = inspectBackupFile(backupPathB);
    if (backupInspection.integrity !== "ok") {
      throw new RecoveryDrillError("scenario B: pre-upgrade backup missing or failed inspection");
    }
    inspectionBytes = backupInspection.bytes;
    step(
      "upgrade with backupPath (Scenario B)",
      `applyMigrations wrote ${path.basename(backupPathB)} BEFORE 018 ran; the upgrade failed again (application-failed)`
    );

    // Simulate the damaged post-upgrade state that makes a plain retry
    // impossible: schema_migrations no longer matches the shipped chain.
    const damage = dbB.prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 17").run("f".repeat(64));
    if (Number(damage.changes) !== 1) {
      throw new RecoveryDrillError("scenario B: damage simulation did not modify migration 017's checksum");
    }
    let damagedKind: string | null = null;
    try {
      verifyMigrations(dbB, { migrations: DAEMON_MIGRATIONS });
    } catch (error) {
      if (error instanceof MigrationError) damagedKind = error.kind;
    }
    if (damagedKind !== "checksum-mismatch") {
      throw new RecoveryDrillError(
        `scenario B: expected checksum-mismatch after damage, got ${String(damagedKind)}`
      );
    }
    verifyErrorAfterDamage = "checksum-mismatch";
    step(
      "database damaged after the failed upgrade (Scenario B)",
      "verifyMigrations now refuses with checksum-mismatch — this database must NOT be operated on; restore is the only path"
    );

    dbB.close();
    dbBClosed = true;
    step(
      "close EVERY connection to the database",
      "restore is a file operation and corrupts state under a live connection — the runbook requires quiescence first"
    );

    const restored = restoreBackup({
      backupPath: backupPathB,
      databasePath: pathB,
      expectedMigrations: DAEMON_MIGRATIONS
    });
    restoredBytes = restored.bytes;
    restoredVerifiedMigrationCount = restored.verifiedMigrationCount ?? -1;
    if (restored.backupIntegrity !== "ok" || restoredVerifiedMigrationCount !== DAEMON_CHAIN_MAX_VERSION) {
      throw new RecoveryDrillError(
        `scenario B: restore verification incomplete (integrity=${restored.backupIntegrity}, verified=${String(restoredVerifiedMigrationCount)})`
      );
    }
    step(
      "inspect + restore from the pre-upgrade backup",
      `integrity ok; ${String(restoredVerifiedMigrationCount)} migration records checksum-verified against the shipped chain; ${String(restored.removedSidecars.length)} stale sidecar(s) removed`
    );

    const dbB2 = openDatabase(pathB);
    try {
      const verifyB = verifyMigrations(dbB2, { migrations: DAEMON_MIGRATIONS });
      verifyVersionsAfterRestore = verifyB.versions;
      dataIntactAfterRestore = assertBusinessDataIntact(dbB2, seededB);
      if (!dataIntactAfterRestore) {
        throw new RecoveryDrillError("scenario B: seeded business data lost after restore");
      }
      step(
        "verify restored database",
        `verifyMigrations ok at 001..${String(DAEMON_CHAIN_MAX_VERSION)}; seeded data byte-for-byte count-identical (run/execution/events/memory/outbox/approval)`
      );

      const fixedB = await applyMigrations(dbB2, {
        now,
        migrations: [...DAEMON_MIGRATIONS, fixedMigration]
      });
      fixedApplied = fixedB.appliedVersions;
      const verifyBFixed = verifyMigrations(dbB2, {
        migrations: [...DAEMON_MIGRATIONS, fixedMigration]
      });
      verifyVersionsAfterFix = verifyBFixed.versions;
      if (!assertBusinessDataIntact(dbB2, seededB)) {
        throw new RecoveryDrillError("scenario B: business data changed after the fixed migration");
      }
      step(
        "apply the FIXED 018 and verify",
        `corrected 018 applied (${fixedB.appliedVersions.join(", ")}); the restored database has no record of the bad attempt, so the same version number is legitimate`
      );
    } finally {
      dbB2.close();
    }
  } finally {
    if (!dbBClosed) {
      dbB.close();
    }
  }

  const scenarioB: DrillScenarioB = {
    dbPath: pathB,
    backupPath: backupPathB,
    damage: "schema_migrations checksum of 017 tampered",
    verifyErrorAfterDamage,
    backupInspectionBytes: inspectionBytes,
    restoredBytes,
    restoredVerifiedMigrationCount,
    verifyVersionsAfterRestore,
    seededDataIntact: dataIntactAfterRestore,
    fixedVersionApplied: fixedApplied,
    verifyVersionsAfterFix
  };

  step(
    "drill complete",
    "both recovery branches proved on the real daemon chain: clean-failure retry and backup-restore retry"
  );

  return {
    executedAt: now,
    daemonChainVersions: DAEMON_MIGRATIONS.map((def) => def.version),
    seeded: seededA,
    scenarioA,
    scenarioB,
    steps
  };
}
