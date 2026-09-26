/**
 * A31 Hardened posture gate for remote execution targets.
 *
 * docs/SECURITY_MODEL.md: "Hardened：必须具备经过实测的 OS/容器文件与网络约
 * 束，否则该模式不可选择。" A remote/container worker claims a boundary it
 * cannot show MEASURED evidence for — so per ACCEPTANCE A31 ("达不到必须禁用
 * 该声明和功能，不能修改测试使危险执行看起来通过") the Hardened posture is
 * DISABLED per target here: the request throws a typed error, and the
 * resolved-posture type cannot even carry "hardened" (a literal).
 *
 * The evidence table is data with a LITERAL "unverified" verification: no
 * real container runtime was ever measured by this package (red line 3).
 * Local process-tree-termination evidence that DOES exist (process-lab,
 * reports/M0-05) is recorded as local-only and explicitly NOT remote
 * evidence — propagation to a remote worker is a different claim.
 */
import { z } from "zod";
import { EXECUTION_TARGETS, ExecutionTargetSchema } from "@role-orchestrator/contracts";
import { HardenedPostureUnavailableError } from "./errors.js";

/** A boundary cell that cannot claim verified: the literal makes honesty the only expressible state. */
export const UnverifiedBoundaryCellSchema = z.strictObject({
  verification: z.literal("unverified"),
  evidence: z.null()
});
export type UnverifiedBoundaryCell = z.output<typeof UnverifiedBoundaryCellSchema>;

export interface RemoteTargetBoundaryEvidence {
  /** Filesystem boundary the remote runtime would enforce around the worktree. */
  readonly filesystem: UnverifiedBoundaryCell;
  /** Network boundary the remote runtime would enforce around the execution. */
  readonly network: UnverifiedBoundaryCell;
  /** Remote ANALOG of the A26 tree-kill: cancel reaching and emptying the remote process tree. */
  readonly remoteCancellation: UnverifiedBoundaryCell;
  /** Honest note on what local evidence exists and why it does not transfer. */
  readonly note: string;
}

const CELL: UnverifiedBoundaryCell = { verification: "unverified", evidence: null };

/**
 * Per-target boundary evidence. Every cell is unverified for every target:
 * the remote/container runtime itself is the thing that has never been
 * measured, so target differences (which WOULD matter in a real deployment)
 * cannot promote any cell today.
 */
export const BOUNDARY_EVIDENCE_BY_TARGET: Readonly<
  Record<(typeof EXECUTION_TARGETS)[number], RemoteTargetBoundaryEvidence>
> = {
  "windows-native": {
    filesystem: CELL,
    network: CELL,
    remoteCancellation: CELL,
    note:
      "LOCAL tree-kill semantics are verified on this host (reports/M0-05 §4 场景1, packages/process-lab; taskkill /T /F), " +
      "but that evidence is about the local launcher's own children — a remote/container worker's process tree is a different claim with zero measured evidence."
  },
  wsl: {
    filesystem: CELL,
    network: CELL,
    remoteCancellation: CELL,
    note:
      "LOCAL WSL2 process semantics are verified (negative-PGID SIGKILL, reports/M0-05 §4 场景5) — again local-only; " +
      "a worker inside a container/distro boundary has never been exercised, and path/world mixing stays rejected (A29)."
  },
  "linux-native": {
    filesystem: CELL,
    network: CELL,
    remoteCancellation: CELL,
    note: "No Linux host evidence exists at all (reports/M0-06 §4); every cell is unverified by absence of any machine."
  },
  "macos-native": {
    filesystem: CELL,
    network: CELL,
    remoteCancellation: CELL,
    note: "No macOS host evidence exists at all (reports/M0-06 §4); every cell is unverified by absence of any machine."
  }
};

/**
 * The ONLY posture a remote target can be granted. "hardened" is absent from
 * this union on purpose: a granted hardened posture is unrepresentable in
 * data until the evidence cells above are flipped by a real measurement.
 */
export const GRANTED_POSTURES = ["local-trusted"] as const;
export const GrantedPostureSchema = z.enum(GRANTED_POSTURES);
export type GrantedPosture = z.output<typeof GrantedPostureSchema>;

/** Requestable postures — "hardened" is requestable precisely so the refusal can be explicit. */
export const REQUESTABLE_POSTURES = ["local-trusted", "hardened"] as const;
export const RequestablePostureSchema = z.enum(REQUESTABLE_POSTURES);
export type RequestablePosture = z.output<typeof RequestablePostureSchema>;

export interface ResolvedPosture {
  readonly granted: GrantedPosture;
  readonly target: (typeof EXECUTION_TARGETS)[number];
  /** Mandatory caveats that must be shown wherever the posture is displayed. */
  readonly caveats: readonly string[];
}

/**
 * Resolve the posture for a remote assignment. Requesting "hardened" throws
 * per target with the honest reason; requesting "local-trusted" returns the
 * grant WITH its caveats (the caveats are part of the grant, not optional
 * documentation).
 */
export function resolvePosture(requested: RequestablePosture, target: string): ResolvedPosture {
  const posture = RequestablePostureSchema.parse(requested);
  const resolvedTarget = ExecutionTargetSchema.parse(target);
  if (posture === "hardened") {
    throw new HardenedPostureUnavailableError(resolvedTarget, hardeningRefusalReason(resolvedTarget));
  }
  return {
    granted: "local-trusted",
    target: resolvedTarget,
    caveats: [
      "remote worker is NOT multi-tenant security (see TENANCY_BOUNDARY_STATEMENT)",
      `filesystem/network boundary evidence for target "${resolvedTarget}" is unverified — no Hardened claim is made or displayable`,
      "execution evidence is protocol-level simulation only (reports/M7-03-remote-worker.md §9)"
    ]
  };
}

/** Per-target refusal reason for a Hardened request (quoted by the typed error). */
export function hardeningRefusalReason(target: (typeof EXECUTION_TARGETS)[number]): string {
  const evidence = BOUNDARY_EVIDENCE_BY_TARGET[target];
  return (
    `no measured OS/container filesystem/network boundary exists for this target ` +
    `(filesystem ${evidence.filesystem.verification}, network ${evidence.network.verification}); ` +
    "per docs/SECURITY_MODEL.md the Hardened mode is not selectable without measured evidence (A31)"
  );
}

/** Convenience gate for callers that only need the refusal: throws unless local-trusted is requested. */
export function requireGrantablePosture(requested: RequestablePosture, target: string): GrantedPosture {
  return resolvePosture(requested, target).granted;
}
