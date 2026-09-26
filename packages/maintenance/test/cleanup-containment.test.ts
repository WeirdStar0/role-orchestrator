import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { createWorktree } from "@role-orchestrator/worktree";
import { executeCleanup, planCleanup, type CleanupItem, type CleanupPlan } from "../src/index.js";
import {
  T0,
  createDaemonDb,
  createFixtureWorld,
  removeTreeRobust,
  seedBusinessData,
  type FixtureRepo
} from "./helpers.js";

/**
 * A40 containment regression tests (round-3 review defect).
 *
 * The standard layout <root>/<run>/<node>/<attempt> makes <run> and
 * <run>/<node> ANCESTORS of a registered worktree. The plan must never
 * propose them as cleanable ("unregistered-worktree-directory" was a false
 * statement for a directory that holds a registered worktree), and the
 * executor must refuse — as the last physical gate — any directory removal
 * whose tree would take a registered worktree or a retain item of the plan
 * with it. Genuine orphans (no registered worktree inside) stay cleanable:
 * the fix must not over-refuse.
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

async function planFor(world: FixtureRepo, db: DatabaseSync): Promise<CleanupPlan> {
  return await planCleanup(db, world.git, {
    now: T0,
    repoPath: world.repoPath,
    worktreesRoot: world.worktreesRoot,
    tempRoot: world.tempRoot,
    evidenceRoots: [world.evidenceRoot]
  });
}

/** git prints forward slashes; node builds backslashes — compare normalized. */
function norm(p: string): string {
  return p.split("\\").join("/").toLowerCase();
}

/** Relative file inventory (path -> size) of a tree, for intactness checks. */
function snapshotTree(dir: string): Map<string, number> {
  const files = new Map<string, number>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const entryPath = path.join(current, entry);
      const stats = statSync(entryPath);
      if (stats.isDirectory()) {
        walk(entryPath);
      } else {
        files.set(path.relative(dir, entryPath).split("\\").join("/"), stats.size);
      }
    }
  };
  walk(dir);
  return files;
}

/** An ACTIVE attempt (phase STARTING, never terminal) owning a real worktree. */
async function createActiveWorktree(
  world: FixtureRepo,
  db: DatabaseSync,
  runId: string
): Promise<{ readonly worktreePath: string; readonly runDir: string; readonly nodeDir: string }> {
  const baseSha = await world.headSha();
  const created = await createWorktree(world.git, {
    repoPath: world.repoPath,
    worktreesRoot: world.worktreesRoot,
    runId,
    nodeId: "node-1",
    attempt: 1,
    baseSha
  });
  seedBusinessData(db, runId); // leaves the attempt STARTING = ACTIVE (A23)
  const runDir = path.join(world.worktreesRoot, runId);
  return { worktreePath: created.worktreePath, runDir, nodeDir: path.join(runDir, "node-1") };
}

describe("A40 containment: ancestors of registered worktrees are never cleanable", () => {
  it("(a) planCleanup proposes NO item for the ancestors of an active worktree, while residue inside them stays visible", async () => {
    const world = await makeWorld("contain-plan");
    const store = createDaemonDb("contain-plan-db");
    try {
      const active = await createActiveWorktree(world, store.db, "run-live");

      // A failed create INSIDE the live run directory: attempt 2 never
      // registered, its directory stayed on disk (A40 keeps failures visible).
      const failedAttempt = path.join(active.nodeDir, "2");
      mkdirSync(failedAttempt, { recursive: true });
      writeFileSync(path.join(failedAttempt, "junk.txt"), "leftover", "utf8");

      // A genuine orphan OUTSIDE any registered layout.
      const orphan = path.join(world.worktreesRoot, "orphan-leftover");
      mkdirSync(orphan, { recursive: true });
      writeFileSync(path.join(orphan, "junk.txt"), "leftover", "utf8");

      const plan = await planFor(world, store.db);

      // The structural containers <run> and <run>/<node> are NOT cleanup
      // objects: no item of any kind targets them.
      const containerItems = plan.items.filter(
        (item) => norm(item.target) === norm(active.runDir) || norm(item.target) === norm(active.nodeDir)
      );
      expect(containerItems).toEqual([]);

      // The active worktree itself is retain (A23), untouched by the fix.
      const activeItem = plan.items.find(
        (item) => item.kind === "execution-worktree" && norm(item.target) === norm(active.worktreePath)
      );
      expect(activeItem?.safety).toBe("retain");

      // No over-skipping: the failed attempt inside the live run directory is
      // still enumerated (require-confirm), and the genuine orphan too.
      const failedItem = plan.items.find(
        (item) => item.kind === "unregistered-worktree-directory" && norm(item.target) === norm(failedAttempt)
      );
      expect(failedItem?.safety).toBe("require-confirm");
      expect(failedItem?.action).toBe("remove-directory");
      const orphanItem = plan.items.find(
        (item) => item.kind === "unregistered-worktree-directory" && norm(item.target) === norm(orphan)
      );
      expect(orphanItem?.safety).toBe("require-confirm");
    } finally {
      store.close();
    }
  }, 90_000);

  it("(b) a defect-era plan that confirmed the ancestor's removal is REFUSED; the active worktree and its tree survive byte-for-byte", async () => {
    const world = await makeWorld("contain-attack");
    const store = createDaemonDb("contain-attack-db");
    try {
      const active = await createActiveWorktree(world, store.db, "run-live");

      const plan = await planFor(world, store.db);

      // Reproduce the round-3 defect at the plan boundary: the run directory
      // mislabeled as an unregistered-worktree-directory (exactly what
      // scanDir proposed before the fix), behind the operator's confirmation.
      const bogusAncestor: CleanupItem = {
        id: "unregistered-worktree-directory#defect-era-ancestor",
        kind: "unregistered-worktree-directory",
        target: active.runDir,
        action: "remove-directory",
        safety: "require-confirm",
        reasons: ["(defect-era classification) directory exists under the engine worktrees root but git does not know it — leftover of a failed create (A40 keeps failures on disk)"],
        detail: `unregistered directory ${active.runDir}`,
        retainedBranch: null,
        snapshot: null
      };
      const attackPlan: CleanupPlan = { ...plan, items: [...plan.items, bogusAncestor] };

      const treeBefore = snapshotTree(world.worktreesRoot);

      const receipt = await executeCleanup(store.db, world.git, attackPlan, {
        now: T0,
        confirmations: [bogusAncestor.id]
      });

      const attackRecord = receipt.records.find((record) => record.itemId === bogusAncestor.id);
      expect(attackRecord?.outcome).toBe("refused");
      expect(attackRecord?.reasonCode).toBe("containment-guard");
      expect(attackRecord?.confirmed).toBe(true);

      // The contradiction is gone: nothing inside the run directory was
      // removed, and the active worktree survives with its full tree.
      expect(existsSync(active.worktreePath)).toBe(true);
      expect(existsSync(path.join(active.worktreePath, ".git"))).toBe(true);
      const treeAfter = snapshotTree(world.worktreesRoot);
      expect([...treeAfter.entries()]).toEqual([...treeBefore.entries()]);
      const removedInsideRun = receipt.records.filter(
        (record) =>
          record.outcome === "removed" && norm(record.target).startsWith(`${norm(active.runDir)}/`)
      );
      expect(removedInsideRun).toEqual([]);

      // The plan's own retain row for the active worktree is still refused
      // (retain-by-policy) — refused + removed can no longer coexist here.
      const activeRecord = receipt.records.find(
        (record) => norm(record.target) === norm(active.worktreePath)
      );
      expect(activeRecord?.outcome).toBe("refused");
      expect(activeRecord?.reasonCode).toBe("retain-by-policy");
    } finally {
      store.close();
    }
  }, 90_000);

  it("(b2) a plan overtaken by a registration between plan and execute is refused via the execution-time git re-list", async () => {
    const world = await makeWorld("contain-race");
    const store = createDaemonDb("contain-race-db");
    try {
      // At plan time this is a GENUINE unregistered directory.
      const lateDir = path.join(world.worktreesRoot, "late-run");
      mkdirSync(lateDir, { recursive: true });
      writeFileSync(path.join(lateDir, "junk.txt"), "leftover", "utf8");

      const plan = await planFor(world, store.db);
      const lateItem = plan.items.find(
        (item) => item.kind === "unregistered-worktree-directory" && norm(item.target) === norm(lateDir)
      );
      expect(lateItem?.safety).toBe("require-confirm");

      // ...then a worktree gets registered INSIDE it before execution.
      const baseSha = await world.headSha();
      const nestedWt = path.join(lateDir, "node-1", "1");
      await world.git.run(world.repoPath, [
        "worktree", "add", "-b", "exec/late-run/node-1/1", nestedWt, baseSha
      ]);
      expect(existsSync(nestedWt)).toBe(true);

      const receipt = await executeCleanup(store.db, world.git, plan, {
        now: T0,
        confirmations: [lateItem?.id ?? ""]
      });
      const record = receipt.records.find((r) => r.itemId === lateItem?.id);
      expect(record?.outcome).toBe("refused");
      expect(record?.reasonCode).toBe("containment-guard");
      // git prints forward slashes; compare normalized.
      expect(norm(record?.detail ?? "")).toContain(norm(nestedWt));
      expect(existsSync(nestedWt)).toBe(true);
      expect(existsSync(path.join(nestedWt, "seed.txt"))).toBe(true);
      expect(existsSync(lateDir)).toBe(true);
    } finally {
      store.close();
    }
  }, 90_000);

  it("(c) a genuine orphan directory (no registered worktree inside) is still planned and cleanly removable on confirmation", async () => {
    const world = await makeWorld("contain-orphan");
    const store = createDaemonDb("contain-orphan-db");
    try {
      const orphan = path.join(world.worktreesRoot, "real-orphan");
      mkdirSync(path.join(orphan, "nested"), { recursive: true });
      writeFileSync(path.join(orphan, "nested", "junk.txt"), "removable leftover", "utf8");

      const plan = await planFor(world, store.db);
      const orphanItem = plan.items.find(
        (item) => item.kind === "unregistered-worktree-directory" && norm(item.target) === norm(orphan)
      );
      expect(orphanItem).toBeDefined();
      expect(orphanItem?.safety).toBe("require-confirm");
      expect(orphanItem?.action).toBe("remove-directory");

      const receipt = await executeCleanup(store.db, world.git, plan, {
        now: T0,
        confirmations: [orphanItem?.id ?? ""]
      });
      const record = receipt.records.find((r) => r.itemId === orphanItem?.id);
      expect(record?.outcome).toBe("removed");
      expect(record?.reasonCode).toBeNull();
      expect(record?.bytesFreed).toBeGreaterThan(0);
      expect(existsSync(orphan)).toBe(false);
    } finally {
      store.close();
    }
  }, 90_000);
});
