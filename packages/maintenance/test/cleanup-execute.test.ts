import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  claimOutboxMessages,
  completeOutboxMessage,
  countOutboxMessages
} from "@role-orchestrator/store";
import { createApproval } from "@role-orchestrator/approval";
import { UnknownCleanupItemError, executeCleanup, planCleanup } from "../src/index.js";
import {
  T0,
  createDaemonDb,
  createFixtureWorld,
  createFinishedExecutionWorktree,
  insertPublishedOutboxRow,
  insertReviewRecord,
  makeWorktreeDirty,
  removeTreeRobust,
  seedBusinessData,
  type FixtureRepo
} from "./helpers.js";

/**
 * The guarded execution: DEFAULT REFUSAL for everything protected (A40),
 * explicit per-item confirmation as the only bypass, optimistic state
 * re-checks between plan and execute, and an itemized receipt for everything
 * that happened.
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

/** git prints forward slashes; node builds backslashes — compare normalized. */
function norm(p: string): string {
  return p.split("\\").join("/").toLowerCase();
}

describe("cleanup execution (A40 guarded)", () => {
  it("default run executes ONLY auto items; every protected object is refused with a receipt row", async () => {
    const world = await makeWorld("exec-default");
    const store = createDaemonDb("exec-default-db");
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
      seedBusinessData(store.db, "run-rows"); // pending outbox row msg-run-rows
      createApproval(store.db, {
        idempotencyKey: "key-x",
        action: APPROVAL_ACTION,
        ttlSeconds: 3600,
        now: T0
      });

      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot,
        evidenceRoots: [world.evidenceRoot]
      });
      const receipt = await executeCleanup(store.db, world.git, plan, { now: T0 });

      // Auto: clean terminal worktree removed, branch retained (A40 traceability).
      expect(existsSync(clean.worktreePath)).toBe(false);
      const branches = await world.git.run(world.repoPath, [
        "for-each-ref",
        "refs/heads",
        "--format=%(refname:short)"
      ]);
      expect(branches.stdout).toContain(clean.branch);

      // Protected: refused, untouched, receipt row names the gate.
      expect(existsSync(dirty.worktreePath)).toBe(true);
      const dirtyRecord = receipt.records.find((record) => norm(record.target) === norm(dirty.worktreePath));
      expect(dirtyRecord?.outcome).toBe("refused");
      expect(dirtyRecord?.reasonCode).toBe("requires-explicit-confirmation");

      const pendingRecord = receipt.records.find(
        (record) => record.kind === "outbox-row" && record.target === "msg-run-rows"
      );
      expect(pendingRecord?.outcome).toBe("refused");
      expect(countOutboxMessages(store.db, { pendingOnly: true })).toBe(1);

      const approvalRecord = receipt.records.find(
        (record) => record.kind === "approval-row" && record.safety === "require-confirm"
      );
      expect(approvalRecord?.outcome).toBe("refused");
      expect(
        store.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status='PENDING'").get()?.n
      ).toBe(1);

      // Totals reflect what happened; the receipt is the audit trail.
      expect(receipt.totals.refused).toBeGreaterThan(0);
      expect(receipt.totals.executed).toBeGreaterThan(0);
      expect(receipt.planId).toBe(plan.planId);
    } finally {
      store.close();
    }
  }, 90_000);

  it("explicit confirmation admits exactly the named items: dirty worktree (force), pending outbox row, pending approval", async () => {
    const world = await makeWorld("exec-confirm");
    const store = createDaemonDb("exec-confirm-db");
    try {
      const dirty = await createFinishedExecutionWorktree(world, store.db, {
        runId: "run-dirty",
        nodeId: "node-1",
        attempt: 1
      });
      makeWorktreeDirty(dirty.worktreePath);
      seedBusinessData(store.db, "run-rows");
      createApproval(store.db, {
        idempotencyKey: "key-x",
        action: APPROVAL_ACTION,
        ttlSeconds: 3600,
        now: T0
      });

      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot,
        evidenceRoots: [world.evidenceRoot]
      });
      const dirtyItem = plan.items.find((item) => norm(item.target) === norm(dirty.worktreePath));
      const pendingItem = plan.items.find(
        (item) => item.kind === "outbox-row" && item.target === "msg-run-rows"
      );
      const approvalItem = plan.items.find(
        (item) => item.kind === "approval-row" && item.safety === "require-confirm"
      );
      expect(dirtyItem && pendingItem && approvalItem).toBeTruthy();

      const receipt = await executeCleanup(store.db, world.git, plan, {
        now: T0,
        confirmations: [dirtyItem?.id ?? "", pendingItem?.id ?? "", approvalItem?.id ?? ""]
      });

      // Dirty worktree: removed ONLY because its id was confirmed (force path
      // of the worktree package's discardWorktree).
      expect(existsSync(dirty.worktreePath)).toBe(false);
      const worktreeRecord = receipt.records.find((record) => norm(record.target) === norm(dirty.worktreePath));
      expect(worktreeRecord?.outcome).toBe("removed");
      expect(worktreeRecord?.confirmed).toBe(true);
      expect(worktreeRecord?.bytesFreed).toBeGreaterThan(0);

      // Pending outbox row: gone, guarded DELETE hit exactly one row.
      const pendingRecord = receipt.records.find((record) => record.target === "msg-run-rows");
      expect(pendingRecord?.outcome).toBe("deleted");
      expect(
        store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id='msg-run-rows'").get()?.n
      ).toBe(0);

      // Pending approval: gone; the plan snapshot preserves the digest.
      const approvalRecord = receipt.records.find((record) => record.itemId === approvalItem?.id);
      expect(approvalRecord?.outcome).toBe("deleted");
      expect(
        store.db.prepare("SELECT COUNT(*) AS n FROM approvals").get()?.n
      ).toBe(0);
      expect(approvalItem?.snapshot?.actionDigest).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      store.close();
    }
  }, 90_000);

  it("an unknown confirmation id aborts BEFORE anything executes", async () => {
    const world = await makeWorld("exec-unknown");
    const store = createDaemonDb("exec-unknown-db");
    try {
      const clean = await createFinishedExecutionWorktree(world, store.db, {
        runId: "run-clean",
        nodeId: "node-1",
        attempt: 1
      });
      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot
      });
      await expect(
        executeCleanup(store.db, world.git, plan, { now: T0, confirmations: ["execution-worktree#nope"] })
      ).rejects.toThrowError(UnknownCleanupItemError);
      // Nothing happened.
      expect(existsSync(clean.worktreePath)).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it("optimistic guard, outbox: a row delivered after planning is refused, not deleted", async () => {
    const world = await makeWorld("exec-guard-row");
    const store = createDaemonDb("exec-guard-row-db");
    try {
      seedBusinessData(store.db, "run-rows"); // pending outbox row msg-run-rows
      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot
      });
      const pendingItem = plan.items.find(
        (item) => item.kind === "outbox-row" && item.target === "msg-run-rows"
      );

      // Between plan and execute, a dispatcher delivers the message.
      const claimed = claimOutboxMessages(store.db, {
        claimToken: "tok-dispatch",
        now: T0,
        leaseMs: 60_000
      });
      expect(claimed).toHaveLength(1);
      expect(completeOutboxMessage(store.db, { id: "msg-run-rows", claimToken: "tok-dispatch", now: T0 })).toBe(true);

      const receipt = await executeCleanup(store.db, world.git, plan, {
        now: T0,
        confirmations: [pendingItem?.id ?? ""]
      });
      const record = receipt.records.find((r) => r.target === "msg-run-rows");
      expect(record?.outcome).toBe("refused");
      expect(record?.reasonCode).toBe("target-changed-since-plan");
      // The row survived (it is now published residue, not deleted).
      expect(
        store.db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE id='msg-run-rows'").get()?.n
      ).toBe(1);
    } finally {
      store.close();
    }
  }, 60_000);

  it("optimistic guard, worktree: undelivered changes appearing after planning refuse the auto item", async () => {
    const world = await makeWorld("exec-guard-wt");
    const store = createDaemonDb("exec-guard-wt-db");
    try {
      const clean = await createFinishedExecutionWorktree(world, store.db, {
        runId: "run-clean",
        nodeId: "node-1",
        attempt: 1
      });
      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot
      });
      makeWorktreeDirty(clean.worktreePath); // becomes undelivered work AFTER the plan

      const receipt = await executeCleanup(store.db, world.git, plan, { now: T0 });
      const record = receipt.records.find((r) => norm(r.target) === norm(clean.worktreePath));
      expect(record?.outcome).toBe("refused");
      expect(record?.reasonCode).toBe("uncommitted-changes-appeared");
      expect(existsSync(clean.worktreePath)).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it("a plan whose scan roots drifted is refused per item instead of trusted", async () => {
    const world = await makeWorld("exec-drift");
    const store = createDaemonDb("exec-drift-db");
    try {
      const doneDir = path.join(world.tempRoot, "ro-review-validation-done");
      mkdirSync(doneDir, { recursive: true });
      seedBusinessData(store.db, "run-rows");
      insertReviewRecord(store.db, {
        id: "rr-done",
        runId: "run-rows",
        state: "COMPLETED",
        validationTempRoot: doneDir
      });
      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot
      });
      // Hand-drifted plan: point the temp root elsewhere.
      const drifted = {
        ...plan,
        scanRoots: { ...plan.scanRoots, tempRoot: path.join(world.scratchDir, "elsewhere") }
      };
      const receipt = await executeCleanup(store.db, world.git, drifted, { now: T0 });
      const record = receipt.records.find((r) => r.kind === "validation-workspace");
      expect(record?.outcome).toBe("refused");
      expect(record?.reasonCode).toBe("target-outside-scan-root");
      expect(existsSync(doneDir)).toBe(true);
    } finally {
      store.close();
    }
  }, 60_000);

  it("published residue is deleted only under the opt-in, in one transaction", async () => {
    const world = await makeWorld("exec-residue");
    const store = createDaemonDb("exec-residue-db");
    try {
      seedBusinessData(store.db, "run-rows");
      insertPublishedOutboxRow(store.db, "msg-res-1");
      insertPublishedOutboxRow(store.db, "msg-res-2");

      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot,
        cleanPublishedOutboxRows: true
      });
      const receipt = await executeCleanup(store.db, world.git, plan, { now: T0 });
      const removed = receipt.records.filter(
        (r) => r.kind === "outbox-row" && r.target.startsWith("msg-res-")
      );
      expect(removed).toHaveLength(2);
      expect(removed.every((r) => r.outcome === "deleted")).toBe(true);
      expect(countOutboxMessages(store.db, { pendingOnly: false })).toBe(1); // only the pending one
    } finally {
      store.close();
    }
  }, 60_000);

  it("validation workspace with a completed review is auto-cleaned; evidence keeps its confirm gate", async () => {
    const world = await makeWorld("exec-ws");
    const store = createDaemonDb("exec-ws-db");
    try {
      seedBusinessData(store.db, "run-rows");
      const doneDir = path.join(world.tempRoot, "ro-review-validation-done");
      mkdirSync(path.join(doneDir, "workspace"), { recursive: true });
      writeFileSync(path.join(doneDir, "workspace", "log.txt"), "output", "utf8");
      insertReviewRecord(store.db, {
        id: "rr-done",
        runId: "run-rows",
        state: "COMPLETED",
        validationTempRoot: doneDir
      });
      mkdirSync(path.join(world.evidenceRoot, "ev-dir"), { recursive: true });

      const plan = await planCleanup(store.db, world.git, {
        now: T0,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        tempRoot: world.tempRoot,
        evidenceRoots: [world.evidenceRoot]
      });
      const receipt = await executeCleanup(store.db, world.git, plan, { now: T0 });

      expect(existsSync(doneDir)).toBe(false);
      const wsRecord = receipt.records.find((r) => r.kind === "validation-workspace");
      expect(wsRecord?.outcome).toBe("removed");

      expect(existsSync(path.join(world.evidenceRoot, "ev-dir"))).toBe(true);
      const evRecord = receipt.records.find((r) => r.kind === "evidence-directory");
      expect(evRecord?.outcome).toBe("refused");
      expect(evRecord?.reasonCode).toBe("requires-explicit-confirmation");
    } finally {
      store.close();
    }
  }, 60_000);
});
