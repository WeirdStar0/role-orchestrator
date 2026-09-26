/**
 * Shared plumbing for the e2e baseline tests.
 *
 * Every test file builds its OWN world (fresh temp scratch + fresh store) and
 * runs the SAME deterministic pipeline, so the suite is repeatable and the
 * files stay independent under vitest's parallel execution. Cleanup removes
 * the whole scratch tree with the review package's whitelisted primitives
 * (fs.rm is broken on Node 25/win32, M0-05) and never masks a test result.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { removeTreeRobust } from "@role-orchestrator/review";
import { snapshotRepositoryState, type RepositorySnapshot } from "@role-orchestrator/worktree";
import {
  BASELINE_NODE_SPECS,
  createBaselineRun,
  createBaselineWorld,
  baselineWorkflowRaw,
  runBaseline,
  type BaselineDriverError,
  type BaselineNodeSpec,
  type BaselineRunResult,
  type BaselineWorld
} from "../src/index.js";

export const RUN_ID = "run-e2e-baseline";

/**
 * Non-null assertion with a label — the strict-TS honest alternative to `!`:
 * a missing value fails the test with a named error instead of a TypeError.
 */
export function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}

export interface BaselineHarness {
  readonly world: BaselineWorld;
  readonly runId: string;
  readonly result: BaselineRunResult;
  snapshotUserRepo(): Promise<RepositorySnapshot>;
  branchHead(branch: string): Promise<string | null>;
  /** exit 0 when `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** Content of a file at a commit (`git show <sha>:<path>`). */
  fileAt(commitSha: string, relativePath: string): Promise<string>;
  commitCount(branch: string): Promise<number>;
  cleanup(): void;
}

export async function runFullBaseline(
  label: string,
  options?: {
    readonly specs?: readonly BaselineNodeSpec[];
    readonly runId?: string;
  }
): Promise<BaselineHarness> {
  const world = await createBaselineWorld(label);
  const runId = options?.runId ?? RUN_ID;
  createBaselineRun(world, runId);
  const result = await runBaseline({
    db: world.db,
    git: world.fixture.git,
    repoPath: world.repoPath,
    worktreesRoot: world.worktreesRoot,
    runId,
    baseSha: world.baseSha,
    workflow: baselineWorkflowRaw(options?.specs ?? BASELINE_NODE_SPECS),
    specs: options?.specs ?? BASELINE_NODE_SPECS
  });
  return buildHarness(world, runId, result);
}

export function buildHarness(
  world: BaselineWorld,
  runId: string,
  result: BaselineRunResult
): BaselineHarness {
  const git = world.fixture.git;
  let cleaned = false;
  return {
    world,
    runId,
    result,
    snapshotUserRepo: (): Promise<RepositorySnapshot> =>
      snapshotRepositoryState(git, world.repoPath),
    branchHead: async (branch: string): Promise<string | null> => {
      const head = await git.tryRun(world.repoPath, [
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`
      ]);
      return head.exitCode === 0 ? head.stdout.trim() : null;
    },
    isAncestor: async (ancestor: string, descendant: string): Promise<boolean> => {
      const check = await git.tryRun(world.repoPath, [
        "merge-base",
        "--is-ancestor",
        ancestor,
        descendant
      ]);
      return check.exitCode === 0;
    },
    fileAt: async (commitSha: string, relativePath: string): Promise<string> => {
      const content = await git.run(world.repoPath, ["show", `${commitSha}:${relativePath}`]);
      return content.stdout;
    },
    commitCount: async (branch: string): Promise<number> => {
      const count = await git.run(world.repoPath, ["rev-list", "--count", branch]);
      return Number.parseInt(count.stdout.trim(), 10);
    },
    cleanup: (): void => {
      if (cleaned) return;
      cleaned = true;
      world.close();
      removeTreeRobust(world.fixture.scratchDir);
    }
  };
}

/** Copy of a spec list with one node's fake-cli scenario replaced. */
export function withScenario(
  specs: readonly BaselineNodeSpec[],
  nodeId: string,
  scenario: string
): readonly BaselineNodeSpec[] {
  return specs.map((spec) => {
    if (spec.id !== nodeId) return spec;
    const next: BaselineNodeSpec = {
      id: spec.id,
      role: spec.role,
      kind: spec.kind,
      dependencies: [...spec.dependencies],
      capabilityTags: [...spec.capabilityTags],
      acceptanceCriteria: [...spec.acceptanceCriteria],
      title: spec.title,
      objective: spec.objective,
      scenario,
      ...(spec.delayMs !== undefined ? { delayMs: spec.delayMs } : {}),
      ...(spec.files !== undefined ? { files: { ...spec.files } } : {}),
      ...(spec.reviewsNode !== undefined ? { reviewsNode: spec.reviewsNode } : {})
    };
    return next;
  });
}

/** The driver error from a baseline run that is EXPECTED to fail. */
export async function expectDriverFailure(run: () => Promise<unknown>): Promise<BaselineDriverError> {
  try {
    await run();
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "BaselineDriverError") return error as BaselineDriverError;
    throw error;
  }
  throw new Error("expected the baseline driver to fail, but it succeeded");
}

/** Read a file inside the user repo (byte-faithful A11 comparisons). */
export function readWorldFile(world: BaselineWorld, relativePath: string): string {
  const absolute = path.join(world.repoPath, ...relativePath.split("/"));
  if (!existsSync(absolute)) {
    throw new Error(`expected user-repo file ${relativePath} to exist at ${absolute}`);
  }
  return readFileSync(absolute, "utf8");
}
