import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  enqueueOutboxMessage,
  openDatabase,
  setTaskRunStatus
} from "@role-orchestrator/store";
import { createApproval } from "@role-orchestrator/approval";
import { createWorktree } from "@role-orchestrator/worktree";
import {
  DAEMON_MIGRATIONS,
  DatabaseSchemaError,
  planCleanup,
  type CleanupItem,
  type CleanupPlan
} from "../src/index.js";
import {
  T0,
  createDaemonDb,
  createFixtureWorld,
  createFinishedExecutionWorktree,
  createIntegrationWorktree,
  insertIntegrationRecord,
  insertPublishedOutboxRow,
  insertReviewRecord,
  makeScratchDir,
  makeWorktreeDirty,
  removeTreeRobust,
  seedBusinessData,
  type FixtureRepo
} from "./helpers.js";

/**
 * The A40 inventory: EVERY cleanable object class is enumerated and annotated
 * with a safety level. The plan deletes NOTHING — it is the dry-run display
 * docs/GIT_AND_WORKSPACES.md 交付和清理 requires.
 */

const worlds: FixtureRepo[] = [];

async function makeWorld(label: string): Promise<FixtureRepo> {
  const world = await createFixtureWorld(label);
  worlds.push(world);
  return world;
}

afterAll(() => {
  for (const world of worlds) {
    removeTreeRobust(world.scratchDir);
  }
});

async function planFor(
  world: FixtureRepo,
  db: DatabaseSync,
  extra: { readonly cleanPublishedOutboxRows?: boolean } = {}
): Promise<CleanupPlan> {
  return await planCleanup(db, world.git, {
    now: T0,
    repoPath: world.repoPath,
    worktreesRoot: world.worktreesRoot,
    tempRoot: world.tempRoot,
    evidenceRoots: [world.evidenceRoot],
    cleanPublishedOutboxRows: extra.cleanPublishedOutboxRows
  });
}

function itemFor(plan: CleanupPlan, kind: string, target: string): CleanupItem {
  const wanted = target.replace(/\\/g, "/").toLowerCase();
  const matches = plan.items.filter(
    (item) => item.kind === kind && item.target.replace(/\\/g, "/").toLowerCase().endsWith(wanted)
  );
  expect(matches, `expected exactly one ${kind} item ending in ${wanted}`).toHaveLength(1);
  return matches[0] as CleanupItem;
}

const APPROVAL_ACTION = {
  runtime: "claude",
  argv: ["fake-cli", "--print", "x"],
  cwd: "h:/repos/x",
  repo: { root: "h:/repos/x", baseSha: "0".repeat(40), targetSha: null },
  profileRevision: "rev-1",
  requiredPermissions: [],
  grantedPermissions: [],
  dimensions: ["readonly"],
  writeScope: null,
  requiredCapabilities: []
} as const;

/** Creates a PENDING approval, then moves it to REJECTED (terminal audit). */
function insertRejectedApproval(db: DatabaseSync, idempotencyKey: string): string {
  const { approval } = createApproval(db, {
    idempotencyKey,
    action: APPROVAL_ACTION,
    ttlSeconds: 3600,
    now: T0
  });
  db.prepare(
    "UPDATE approvals SET status = 'REJECTED', rejected_by = 'user', rejected_at = ? WHERE id = ?"
  ).run(T0, approval.id);
  return approval.id;
}

describe("cleanup inventory classification (A40 dry run)", () => {
  it("annotates execution worktrees by true state: clean-terminal auto, dirty confirm, active retain, stale retain, orphan confirm", async () => {
    const world = await makeWorld("plan-exec");
    const store = createDaemonDb("plan-exec-db");
    try {
      const clean = await createFinishedExecutionWorktree(world, store.db, {
        runId: "run-clean",
        nodeId: "node-1",
        attempt: 1
      });
      const dirty = await createFinishedExecutionWorktree(world, store.db, {
        runId: "run-dirty",
        nodeId: "node-1",
        attempt: 1
      });
      makeWorktreeDirty(dirty.worktreePath);

      const stale = await createFinishedExecutionWorktree(world, store.db, {
        runId: "run-stale",
        nodeId: "node-1",
        attempt: 1
      });
      removeTreeRobust(stale.worktreePath); // registration remains, dir gone

      // ACTIVE execution: attempt stays STARTING (never terminal).
      const baseSha = await world.headSha();
      await createWorktree(world.git, {
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        runId: "run-active",
        nodeId: "node-1",
        attempt: 1,
        baseSha
      });
      // seedBusinessData leaves the attempt STARTING = an ACTIVE attempt.
      seedBusinessData(store.db, "run-active");

      const orphan = path.join(world.worktreesRoot, "orphan-leftover");
      mkdirSync(orphan, { recursive: true });
      writeFileSync(path.join(orphan, "junk.txt"), "leftover", "utf8");

      const plan = await planFor(world, store.db);

      const cleanItem = itemFor(plan, "execution-worktree", clean.worktreePath);
      expect(cleanItem.safety).toBe("auto");
      expect(cleanItem.action).toBe("git-worktree-remove");
      expect(cleanItem.retainedBranch).toBe(clean.branch);
      expect(cleanItem.reasons[0]).toContain("SUCCEEDED");

      const dirtyItem = itemFor(plan, "execution-worktree", dirty.worktreePath);
      expect(dirtyItem.safety).toBe("require-confirm");
      expect(dirtyItem.reasons.join(" ")).toContain("undelivered work");

      const activeItem = itemFor(
        plan,
        "execution-worktree",
        path.join(world.worktreesRoot, "run-active", "node-1", "1")
      );
      expect(activeItem.safety).toBe("retain");
      expect(activeItem.reasons.join(" ")).toContain("ACTIVE attempt");

      const staleItem = itemFor(plan, "execution-worktree", stale.worktreePath);
      expect(staleItem.safety).toBe("retain");
      expect(staleItem.action).toBe("manual");
      expect(staleItem.reasons.join(" ")).toContain("stale registration");

      const orphanItem = itemFor(plan, "unregistered-worktree-directory", orphan);
      expect(orphanItem.safety).toBe("require-confirm");
      expect(orphanItem.action).toBe("remove-directory");

      expect(plan.counts.auto + plan.counts.requireConfirm + plan.counts.retain).toBe(
        plan.items.length
      );
    } finally {
      store.close();
    }
  }, 90_000);

  it("annotates integration worktrees: delivered auto, non-delivered confirm, in-progress/conflict retain", async () => {
    const world = await makeWorld("plan-integ");
    const store = createDaemonDb("plan-integ-db");
    try {
      seedBusinessData(store.db, "run-delivered");
      setTaskRunStatus(store.db, { id: "run-delivered", status: "DELIVERED" });
      insertIntegrationRecord(store.db, { id: "ir-1", runId: "run-delivered", state: "COMPLETED" });
      const deliveredPath = await createIntegrationWorktree(world, "run-delivered");

      seedBusinessData(store.db, "run-planned");
      const plannedPath = await createIntegrationWorktree(world, "run-planned");

      seedBusinessData(store.db, "run-conflict");
      insertIntegrationRecord(store.db, { id: "ir-2", runId: "run-conflict", state: "PAUSED_CONFLICT" });
      const conflictPath = await createIntegrationWorktree(world, "run-conflict");

      seedBusinessData(store.db, "run-progress");
      insertIntegrationRecord(store.db, { id: "ir-3", runId: "run-progress", state: "IN_PROGRESS" });
      const progressPath = await createIntegrationWorktree(world, "run-progress");

      const plan = await planFor(world, store.db);

      expect(itemFor(plan, "integration-worktree", deliveredPath).safety).toBe("auto");
      expect(itemFor(plan, "integration-worktree", plannedPath).safety).toBe("require-confirm");
      const conflictItem = itemFor(plan, "integration-worktree", conflictPath);
      expect(conflictItem.safety).toBe("retain");
      expect(conflictItem.reasons.join(" ")).toContain("conflict scene");
      const progressItem = itemFor(plan, "integration-worktree", progressPath);
      expect(progressItem.safety).toBe("retain");
      expect(progressItem.reasons.join(" ")).toContain("single-writer");
      // The `_integration` layout directory itself is never proposed.
      expect(
        plan.items.find((item) =>
          item.target.replace(/\\/g, "/").endsWith("/_integration")
        )
      ).toBeUndefined();
    } finally {
      store.close();
    }
  }, 90_000);

  it("annotates validation workspaces via review_records: terminal auto, in-progress retain, unattributed confirm", async () => {
    const world = await makeWorld("plan-ws");
    const store = createDaemonDb("plan-ws-db");
    try {
      seedBusinessData(store.db, "run-ws");
      const doneDir = path.join(world.tempRoot, "ro-review-validation-done");
      const progressDir = path.join(world.tempRoot, "ro-review-validation-progress");
      const strayDir = path.join(world.tempRoot, "ro-review-validation-stray");
      for (const dir of [doneDir, progressDir, strayDir]) {
        mkdirSync(path.join(dir, "workspace"), { recursive: true });
      }
      insertReviewRecord(store.db, {
        id: "rr-done",
        runId: "run-ws",
        state: "COMPLETED",
        validationTempRoot: doneDir
      });
      insertReviewRecord(store.db, {
        id: "rr-progress",
        runId: "run-ws",
        state: "IN_PROGRESS",
        validationTempRoot: progressDir
      });

      const plan = await planFor(world, store.db);
      expect(itemFor(plan, "validation-workspace", doneDir).safety).toBe("auto");
      const progressItem = itemFor(plan, "validation-workspace", progressDir);
      expect(progressItem.safety).toBe("retain");
      expect(progressItem.reasons.join(" ")).toContain("IN_PROGRESS");
      expect(itemFor(plan, "validation-workspace", strayDir).safety).toBe("require-confirm");
    } finally {
      store.close();
    }
  }, 60_000);

  it("annotates evidence, temp databases and the live database; never enumerates unknown temp files", async () => {
    const world = await makeWorld("plan-files");
    const store = createDaemonDb("plan-files-db");
    try {
      mkdirSync(path.join(world.evidenceRoot, "review-run-ws"), { recursive: true });
      writeFileSync(path.join(world.evidenceRoot, "review-run-ws", "verdict.json"), "{}", "utf8");
      mkdirSync(path.join(world.tempRoot, "ro-store-junk"), { recursive: true });
      writeFileSync(path.join(world.tempRoot, "ro-store-junk", "test.db"), "x", "utf8");
      writeFileSync(path.join(world.tempRoot, "somebodys-file.txt"), "not ours", "utf8");

      const plan = await planFor(world, store.db);

      const evidenceItem = itemFor(
        plan,
        "evidence-directory",
        path.join(world.evidenceRoot, "review-run-ws")
      );
      expect(evidenceItem.safety).toBe("require-confirm");
      expect(evidenceItem.reasons.join(" ")).toContain("audit evidence");

      expect(itemFor(plan, "temp-database", path.join(world.tempRoot, "ro-store-junk")).safety).toBe(
        "auto"
      );
      const liveItem = itemFor(plan, "temp-database", store.dbPath);
      expect(liveItem.safety).toBe("retain");
      expect(liveItem.action).toBe("manual");
      expect(
        plan.items.find((item) => item.target.endsWith("somebodys-file.txt"))
      ).toBeUndefined();
    } finally {
      store.close();
    }
  }, 60_000);

  it("annotates queue rows: pending outbox protected, published residue opt-in, pending approvals protected with snapshot, terminal approvals audit-retained", async () => {
    const world = await makeWorld("plan-rows");
    const store = createDaemonDb("plan-rows-db");
    try {
      seedBusinessData(store.db, "run-rows"); // brings one PENDING outbox row
      insertPublishedOutboxRow(store.db, "msg-published-residue");
      enqueueOutboxMessage(store.db, {
        id: "msg-extra-pending",
        aggregateId: "run-rows",
        type: "retry.requested",
        payload: { synthetic: true },
        now: T0
      });
      createApproval(store.db, {
        idempotencyKey: "key-pending",
        action: APPROVAL_ACTION,
        ttlSeconds: 3600,
        now: T0
      });
      const rejectedId = insertRejectedApproval(store.db, "key-rejected");

      const defaultPlan = await planFor(world, store.db);
      const pendingRow = itemFor(defaultPlan, "outbox-row", "msg-run-rows");
      expect(pendingRow.safety).toBe("require-confirm");
      expect(pendingRow.reasons.join(" ")).toContain("undelivered");
      expect(itemFor(defaultPlan, "outbox-row", "msg-published-residue").safety).toBe("retain");

      const pendingApproval = defaultPlan.items.find(
        (item) => item.kind === "approval-row" && item.safety === "require-confirm"
      );
      expect(pendingApproval).toBeDefined();
      expect(pendingApproval?.snapshot?.actionDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(pendingApproval?.snapshot?.argv).toContain("fake-cli");
      const rejectedApproval = itemFor(defaultPlan, "approval-row", rejectedId);
      expect(rejectedApproval.safety).toBe("retain");
      expect(rejectedApproval.action).toBe("manual");

      const optInPlan = await planFor(world, store.db, { cleanPublishedOutboxRows: true });
      expect(itemFor(optInPlan, "outbox-row", "msg-published-residue").safety).toBe("auto");
      expect(itemFor(optInPlan, "outbox-row", "msg-run-rows").safety).toBe("require-confirm");
    } finally {
      store.close();
    }
  }, 60_000);

  it("refuses to scan a database that predates the tables cleanup reads (fail closed)", async () => {
    const world = await makeWorld("plan-schema");
    const scratch = makeScratchDir("plan-schema-db");
    try {
      const db = openDatabase(path.join(scratch, "old.db"));
      try {
        await applyMigrations(db, { now: T0 }); // store's 001 only
        await expect(
          planCleanup(db, world.git, {
            now: T0,
            repoPath: world.repoPath,
            worktreesRoot: world.worktreesRoot,
            tempRoot: world.tempRoot
          })
        ).rejects.toThrowError(DatabaseSchemaError);
      } finally {
        db.close();
      }
    } finally {
      removeTreeRobust(scratch);
    }
  }, 60_000);

  it("daemon chain applied via the store matches the composed list (apply-path sanity)", () => {
    const store = createDaemonDb("plan-chain");
    try {
      const rows = store.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all();
      expect(rows.map((row) => Number(row.version))).toEqual(
        DAEMON_MIGRATIONS.map((def) => def.version)
      );
    } finally {
      store.close();
    }
  });
});
