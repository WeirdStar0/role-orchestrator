/**
 * M10-02 M7 (integration-driver) — the OPTIONAL integration phase for
 * multi-node graphs, extracted from the dogfood driver's integration branch
 * and de-dogfooded (M10-02 step 3). A composition root whose graph carries
 * integration-kind nodes settles them through HERE; the production single
 * "execute" node graph has no such node and the phase stays DORMANT — the
 * RunDriver surface never exposes it (structure guarded by the driver
 * surface suite).
 *
 * Semantics (the dogfood/e2e-baseline/pump shared shape): the parents are
 * assembled with the M5 buildParents rule, the integration service
 * single-writer-merges them into a candidate, the candidateSha enters the
 * caller's candidates table, and the candidate IS the successor baseline for
 * downstream nodes.
 */
import type { DatabaseSync } from "node:sqlite";
import type { GitRunner } from "@role-orchestrator/worktree";
import { integrateParents } from "@role-orchestrator/integration";
import { buildParents, type AcceptedOutputs } from "./dependency-resolver.js";

/** One recorded integration candidate (nodeId -> candidateSha). */
export type IntegrationCandidates = Map<string, string>;

export interface IntegrationClaimInput {
  readonly repoPath: string;
  readonly worktreesRoot: string;
  readonly runId: string;
  readonly nodeId: string;
  /** The run's frozen base commit (the merge's fallback base). */
  readonly baseSha: string;
  /** The node's dependency ids, in order (resolved via acceptedOutputs). */
  readonly dependencies: readonly string[];
  readonly acceptedOutputs: AcceptedOutputs;
  /** The candidates table this phase records the candidateSha into. */
  readonly candidates: IntegrationCandidates;
  readonly now: string;
}

export interface IntegrationSettlement {
  readonly candidateSha: string;
  /** The successor baseline for downstream nodes: the candidate itself. */
  readonly baselineSha: string;
  readonly kind: "integrated" | "already-integrated";
  readonly inputShaSet: readonly { readonly nodeId: string; readonly branch: string; readonly headSha: string }[];
}

/**
 * Settle ONE integration-kind claim: assemble the parents (M5 rule — a
 * dependency without an accepted output is a pump-contract violation),
 * single-writer merge, record the candidateSha, answer the successor
 * baseline.
 */
export async function settleIntegrationClaim(
  deps: { readonly db: DatabaseSync; readonly git: GitRunner },
  input: IntegrationClaimInput
): Promise<IntegrationSettlement> {
  const parents = buildParents(input.nodeId, input.dependencies, input.acceptedOutputs);
  const integrated = await integrateParents(deps, {
    repoPath: input.repoPath,
    worktreesRoot: input.worktreesRoot,
    runId: input.runId,
    nodeId: input.nodeId,
    baseSha: input.baseSha,
    parents,
    now: input.now
  });
  input.candidates.set(input.nodeId, integrated.candidateSha);
  return {
    candidateSha: integrated.candidateSha,
    baselineSha: integrated.candidateSha,
    kind: integrated.kind,
    inputShaSet: integrated.kind === "integrated" ? integrated.inputShaSet : parents
  };
}
