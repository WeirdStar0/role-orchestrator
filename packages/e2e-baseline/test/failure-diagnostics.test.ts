/**
 * Deliverable 3 — 失败时输出可诊断的现场摘要.
 *
 * The SAME pipeline with one node switched to the fake-cli `error-result`
 * scenario: the engine fails the attempt fail-closed (A06), the driver turns
 * the node FAILED, propagation BLOCKs every downstream node, and the driver
 * surfaces `BaselineDriverError` whose site summary contains the real store
 * facts: failed node + reasons, downstream BLOCKED states, the preserved
 * (A40) worktree, and the last persisted events. The user repository is
 * untouched by the failed run, and nothing was committed on the failed
 * node's exec branch.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { listExecutionsForRun } from "@role-orchestrator/store";
import { listRunNodes } from "@role-orchestrator/dag";
import { listQueueEntries } from "@role-orchestrator/scheduler";
import { removeTreeRobust } from "@role-orchestrator/review";
import { snapshotRepositoryState, type RepositorySnapshot } from "@role-orchestrator/worktree";
import {
  BASELINE_NODE_SPECS,
  DIRTY_FILE_CONTENT,
  DIRTY_FILE_REL,
  createBaselineRun,
  createBaselineWorld,
  baselineWorkflowRaw,
  runBaseline,
  type BaselineDriverError,
  type BaselineWorld
} from "../src/index.js";
import { expectDriverFailure, readWorldFile, withScenario } from "./helpers.js";

const RUN_ID = "run-e2e-failure";

interface FailureSite {
  readonly world: BaselineWorld;
  readonly branchHead: (branch: string) => Promise<string | null>;
  readonly snapshotUserRepo: () => Promise<RepositorySnapshot>;
  readonly cleanup: () => void;
}

let preRunSnapshot: RepositorySnapshot | null = null;
let failure: BaselineDriverError | null = null;
let site: FailureSite | null = null;

afterAll(() => {
  site?.cleanup();
});

describe("失败诊断：error-result 节点产生可诊断现场摘要且不破坏现场", () => {
  it("驱动器以 BaselineDriverError 失败，摘要携带全部关键事实", async () => {
    const world = await createBaselineWorld("failure");
    createBaselineRun(world, RUN_ID);
    preRunSnapshot = await snapshotRepositoryState(world.fixture.git, world.repoPath);
    const specs = withScenario(BASELINE_NODE_SPECS, "backend", "error-result");

    failure = await expectDriverFailure(() =>
      runBaseline({
        db: world.db,
        git: world.fixture.git,
        repoPath: world.repoPath,
        worktreesRoot: world.worktreesRoot,
        runId: RUN_ID,
        baseSha: world.baseSha,
        workflow: baselineWorkflowRaw(specs),
        specs
      })
    );

    // Keep the failed world wired for cleanup and read-only git helpers.
    const git = world.fixture.git;
    site = {
      world,
      branchHead: async (branch: string): Promise<string | null> => {
        const head = await git.tryRun(world.repoPath, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`
        ]);
        return head.exitCode === 0 ? head.stdout.trim() : null;
      },
      snapshotUserRepo: (): Promise<RepositorySnapshot> =>
        snapshotRepositoryState(git, world.repoPath),
      cleanup: (): void => {
        world.close();
        removeTreeRobust(world.fixture.scratchDir);
      }
    };
    const summary = failure.summary;

    // The failed node, its engine reasons, and the fail-closed bookkeeping.
    expect(summary).toContain("backend=FAILED");
    expect(summary).toContain("nonzero-exit");
    expect(summary).toContain("final-result-error");
    // Downstream propagation: the successor is BLOCKED, not silently stuck.
    expect(summary).toContain("integrate=BLOCKED");
    // The surviving sibling is visible with its state.
    expect(summary).toContain("frontend=SUCCEEDED");
    // The failed node's worktree is preserved, not auto-cleaned (A40).
    expect(summary).toContain("worktree preserved (A40)");
    // Last persisted events of the failed execution are in the summary.
    expect(summary).toContain("last events of");
    expect(summary).toContain("lifecycle_outcome");
    // The headline names the node and its phase.
    expect(failure.message).toContain('node "backend" finished FAILED');
  });

  it("失败节点无输出提交，worktree 保留，用户仓库无损", async () => {
    if (site === null || preRunSnapshot === null || failure === null) {
      throw new Error("failure site not ready");
    }
    const { world } = site;

    // Node states in the store: backend FAILED, its successors BLOCKED. The
    // sibling frontend was claimed FIRST (sha-derived queue order) and really
    // SUCCEEDED before the backend attempt even started.
    const nodes = listRunNodes(world.db, RUN_ID);
    const stateOf = (nodeId: string): string =>
      nodes.find((node) => node.nodeId === nodeId)?.state ?? "(missing)";
    expect(stateOf("backend")).toBe("FAILED");
    expect(stateOf("frontend")).toBe("SUCCEEDED");
    expect(stateOf("integrate")).toBe("BLOCKED");
    expect(stateOf("followup")).toBe("BLOCKED");
    expect(stateOf("integrate-followup")).toBe("BLOCKED");

    // Exactly the two dispatched attempts exist: one SUCCEEDED, one FAILED.
    const executions = [...listExecutionsForRun(world.db, RUN_ID)].sort((a, b) =>
      a.nodeId.localeCompare(b.nodeId)
    );
    expect(executions.map((row) => `${row.nodeId}:${row.phase}`)).toEqual([
      "backend:FAILED",
      "frontend:SUCCEEDED",
      "plan:SUCCEEDED"
    ]);

    // The failed node's exec branch carries NO output commit beyond the base.
    const backendHead = await site.branchHead(`exec/${RUN_ID}/backend/1`);
    expect(backendHead).toBe(world.baseSha);

    // Its worktree survives on disk at the exact path the summary reports (A40).
    const preserved = summaryWorktreePath(failure.summary);
    expect(preserved).not.toBeNull();
    expect(existsSync(preserved as string)).toBe(true);

    // The user repo: same fingerprint as before the run, dirty file intact.
    const post = await site.snapshotUserRepo();
    expect(post.rawStatusSha256).toBe(preRunSnapshot.rawStatusSha256);
    expect(post.headSha).toBe(world.baseSha);
    expect(readWorldFile(world, DIRTY_FILE_REL)).toBe(DIRTY_FILE_CONTENT);

    // The queue consumed all three dispatched attempts exactly once
    // (plan in round 1, frontend in round 2, the failed backend in round 3).
    const queue = listQueueEntries(world.db, { state: "COMPLETED" });
    expect(queue.map((entry) => entry.nodeId).sort()).toEqual(["backend", "frontend", "plan"]);
  });
});

/** Extract the preserved-worktree path the site summary reports. */
function summaryWorktreePath(summary: string): string | null {
  const match = /worktree preserved \(A40\): (.+)/.exec(summary);
  return match?.[1]?.trim() ?? null;
}
