/**
 * Shared plumbing for the cross-CLI context tests (M3-04).
 *
 * Every test file builds its OWN world (fresh temp scratch + fresh store,
 * migrations 001..010), seeds the project's memory through the REAL write
 * paths (propose -> verify -> user-only promote), runs the SAME cross-CLI
 * driver, and cleans up the whole scratch tree with the review package's
 * whitelisted primitive (fs.rm is broken on Node 25/win32, M0-05). Cleanup
 * never masks a test result.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listEventsForExecution } from "@role-orchestrator/store";
import { removeTreeRobust } from "@role-orchestrator/review";
import { BASELINE_T0 } from "@role-orchestrator/e2e-baseline";
import { openMemoryAccess, type MemoryAccess } from "@role-orchestrator/memory-search";
import { promoteProjectRule, proposeMemory, verifyMemory } from "@role-orchestrator/memory";
import {
  CTX_E2E_NODE_SPECS,
  CTX_E2E_PROJECT_A,
  createCrossCliRun,
  createCrossCliWorld,
  ctxE2eWorkflowRaw,
  runCrossCliHandoff,
  type ContextE2eDriverError,
  type ContextE2eNodeSpec,
  type CrossCliHandoffResult,
  type CrossCliWorld
} from "../src/index.js";

export const RUN_ID = "run-ctx-e2e";

/** The retrieval query every seeded memory answers (single ASCII token). */
export const MEMORY_QUERY = "ctxe2e";

export interface SeededMemories {
  /** User-promoted ACTIVE project rule (goes into every bundle). */
  readonly ruleId: string;
  /** VERIFIED fact describing the structured handoff. */
  readonly factId: string;
}

/**
 * Seed the project's rule + fact through the real memory write paths:
 * propose (role actor) -> verify (verifier role, never the proposer) ->
 * promote (USER actor, the only path to an active project_rule; promotion
 * requires the verified state).
 */
export function seedHandoffMemories(
  world: CrossCliWorld,
  input: { readonly projectId: string } & Partial<SeededMemories>
): SeededMemories {
  const ruleId = input.ruleId ?? "mem-ctxe2e-rule-1";
  const factId = input.factId ?? "mem-ctxe2e-fact-1";
  proposeMemory(world.db, {
    id: ruleId,
    projectId: input.projectId,
    type: "project_rule",
    // NOTE: deliberately no "ctxe2e" marker — the rule reaches bundles via
    // listActiveProjectRules (the policy channel), not via memory retrieval.
    content:
      "跨方言交接规则：只允许结构化、版本化的事实与产物引用进入上下文；" +
      "禁止复制会话记录、认证文件或任何凭据形态字符串。",
    evidenceRefs: ["design"],
    actor: { kind: "role", roleId: "coordinator" },
    now: BASELINE_T0
  });
  verifyMemory(world.db, {
    projectId: input.projectId,
    memoryId: ruleId,
    expectedVersion: 1,
    actor: { kind: "role", roleId: "reviewer" },
    now: BASELINE_T0
  });
  promoteProjectRule(world.db, {
    projectId: input.projectId,
    memoryId: ruleId,
    expectedVersion: 2,
    actor: { kind: "user", displayName: "e2e-operator" },
    now: BASELINE_T0
  });
  proposeMemory(world.db, {
    id: factId,
    projectId: input.projectId,
    type: "fact",
    content:
      "ctxe2e 交接事实：design 节点的产物以 artifact 引用 + commit SHA + " +
      "contentHash 进入下游 bundle manifest，可逐片段追溯。",
    evidenceRefs: ["design"],
    actor: { kind: "role", roleId: "architect" },
    now: BASELINE_T0
  });
  verifyMemory(world.db, {
    projectId: input.projectId,
    memoryId: factId,
    expectedVersion: 1,
    actor: { kind: "role", roleId: "reviewer" },
    now: BASELINE_T0
  });
  return { ruleId, factId };
}

export interface HandoffHarness {
  readonly world: CrossCliWorld;
  readonly access: MemoryAccess;
  readonly runId: string;
  readonly result: CrossCliHandoffResult;
  readonly seeded: SeededMemories;
  /** Persisted events of one execution, payload parsed. */
  eventsOf(executionId: string): readonly { readonly seq: number; readonly type: string; readonly raw: string }[];
  /** The prompt stdin file the engine wrote into a node's worktree. */
  promptFileOf(executionId: string, worktreePath: string): string;
  cleanup(): void;
}

export interface HandoffHarnessOptions {
  readonly specs?: readonly ContextE2eNodeSpec[];
  readonly withProjectB?: boolean;
  /** Extra memory seeding AFTER the standard rule+fact. */
  readonly seedExtra?: (world: CrossCliWorld, projectId: string) => void;
  /** Runs after seeding, BEFORE the driver starts (snapshot point). */
  readonly beforeRun?: (world: CrossCliWorld) => void;
  readonly budgetBytes?: number | null;
}

/** Build the world, seed the rule+fact, run the full cross-CLI handoff. */
export async function runHandoffHarness(
  label: string,
  options: HandoffHarnessOptions = {}
): Promise<HandoffHarness> {
  const world = await createCrossCliWorld(label, {
    withProjectB: options.withProjectB ?? false
  });
  const seeded = seedHandoffMemories(world, { projectId: CTX_E2E_PROJECT_A });
  options.seedExtra?.(world, CTX_E2E_PROJECT_A);
  createCrossCliRun(world, RUN_ID);
  // Snapshot point: the run row exists (so frozen profile snapshots can be
  // read) but no node has run yet.
  options.beforeRun?.(world);
  const access = openMemoryAccess(world.db, { projectId: CTX_E2E_PROJECT_A });
  const result = await runCrossCliHandoff({
    db: world.db,
    git: world.fixture.git,
    repoPath: world.repoPath,
    worktreesRoot: world.worktreesRoot,
    runId: RUN_ID,
    baseSha: world.baseSha,
    workflow: ctxE2eWorkflowRaw(options.specs ?? CTX_E2E_NODE_SPECS),
    specs: options.specs ?? CTX_E2E_NODE_SPECS,
    access,
    projectId: CTX_E2E_PROJECT_A,
    memoryQuery: MEMORY_QUERY,
    ...(options.budgetBytes === undefined ? {} : { budgetBytes: options.budgetBytes })
  });
  return buildHarness(world, access, result, seeded);
}

export function buildHarness(
  world: CrossCliWorld,
  access: MemoryAccess,
  result: CrossCliHandoffResult,
  seeded: SeededMemories
): HandoffHarness {
  let cleaned = false;
  return {
    world,
    access,
    runId: RUN_ID,
    result,
    seeded,
    eventsOf: (executionId) =>
      // Raw strings on purpose: the negative assertions grep the EXACT
      // persisted bytes, not a re-serialized copy.
      listEventsForExecution(world.db, executionId).map((event) => ({
        seq: event.seq,
        type: event.type,
        raw: event.payload
      })),
    promptFileOf: (executionId, worktreePath): string => {
      const file = join(worktreePath, `stdin-${executionId}.prompt.txt`);
      if (!existsSync(file)) {
        throw new Error(`expected prompt file ${file} to exist`);
      }
      return readFileSync(file, "utf8");
    },
    cleanup: (): void => {
      if (cleaned) return;
      cleaned = true;
      world.close();
      removeTreeRobust(world.fixture.scratchDir);
    }
  };
}

/** The driver error from a handoff run that is EXPECTED to fail. */
export async function expectDriverFailure(run: () => Promise<unknown>): Promise<ContextE2eDriverError> {
  try {
    await run();
  } catch (error) {
    const name = (error as { name?: string }).name;
    if (name === "ContextE2eDriverError") return error as ContextE2eDriverError;
    throw error;
  }
  throw new Error("expected the cross-cli driver to fail, but it succeeded");
}
