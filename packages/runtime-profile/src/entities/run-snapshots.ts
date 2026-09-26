import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, ProfileSnapshot, RoleId } from "@role-orchestrator/contracts";
import { ROLE_IDS, RoleIdSchema } from "@role-orchestrator/contracts";
import type { TaskRunRow } from "@role-orchestrator/store";
import {
  createTaskRun,
  getTaskRun,
  isUniqueViolation,
  withTransaction
} from "@role-orchestrator/store";
import type { Row } from "@role-orchestrator/store";
import { reqInt, reqStr, TimestampSchema } from "@role-orchestrator/store";
import {
  detectExternalConfigDrift,
  type ExternalConfigDriftResult,
  type ExternalConfigOptions
} from "../drift.js";
import {
  DuplicateRunError,
  ExecutionTargetMismatchError,
  RoleBindingResolutionError,
  SnapshotIntegrityError,
  UnknownRunSnapshotError,
  UnknownRoleError
} from "../errors.js";
import { canonicalJson, sha256Hex } from "../hashing.js";
import { assertNoProfileModelOverride } from "../no-override.js";
import { checkExecutionTarget } from "../target.js";
import { ProfileSnapshotSchema } from "./profile-revisions.js";
import { getProfile, type ProfileRow } from "./profiles.js";
import {
  getLatestProfileRevision,
  getProfileRevision,
  type ProfileRevisionRow
} from "./profile-revisions.js";
import { requireProject } from "./project-lookup.js";
import type { ReadyBindings, ResolvedRoleBinding } from "./role-bindings.js";
import { resolveRoleBinding, validateRoleBindingsReady } from "./role-bindings.js";

/**
 * A34 (immutable half) — run config snapshots.
 *
 * `createTaskRunWithProfileSnapshot` resolves all four role bindings ONCE,
 * freezes the role -> profile revision resolution into `run_profile_snapshots`
 * IN THE SAME TRANSACTION that creates the `task_runs` row, and computes the
 * run's `configSnapshotHash` from the frozen snapshots. From then on:
 * - the service read path (`readRunRoleProfile`) reads ONLY snapshot rows —
 *   later binding changes cannot affect an existing run;
 * - `getRunBindingDrift` reports the DB-level drift between the frozen
 *   snapshot and the CURRENT bindings (including model expectation changes);
 * - `checkRunProfileDrift` additionally compares the profile's external
 *   config files on disk against the revision baseline.
 */

export interface RunProfileSnapshotRow {
  readonly runId: string;
  readonly roleId: RoleId;
  readonly profileId: string;
  readonly profileRevision: number;
  /** Canonical JSON of the frozen contracts `ProfileSnapshot`. */
  readonly snapshotJson: string;
  /** sha256 of `snapshotJson`; verified on every read. */
  readonly snapshotHash: string;
  readonly createdAt: string;
}

const CreateTaskRunWithProfileSnapshotInputSchema = z.strictObject({
  runId: z.string().min(1).max(64),
  projectId: z.string().min(1).max(64),
  taskId: z.string().min(1).max(128),
  graphRevision: z.number().int().min(0),
  baseSha: z.string().min(1).max(256),
  /**
   * Optional explicit request-side executionTarget (A29). When provided and
   * different from the project's target, creation fails BEFORE anything is
   * written. There is no per-node/task model or profile field and there never
   * will be (A02) — profile selection comes from the role bindings alone.
   */
  requestedExecutionTarget: z.enum(["windows-native", "wsl", "linux-native", "macos-native"]).optional(),
  now: TimestampSchema
});

export type CreateTaskRunWithProfileSnapshotInput = z.input<
  typeof CreateTaskRunWithProfileSnapshotInputSchema
>;

export interface RunWithSnapshotResult {
  readonly run: TaskRunRow;
  readonly configSnapshotHash: string;
  /** Four snapshot rows, ROLE_IDS order. */
  readonly snapshots: readonly RunProfileSnapshotRow[];
  /** The frozen ProfileSnapshot per role, ROLE_IDS order. */
  readonly resolved: readonly ResolvedRoleBinding[];
}

/**
 * Deterministic run config hash over the frozen binding/snapshot set. The
 * same frozen set always produces the same hash (canonical JSON, sorted keys).
 */
export function computeRunConfigSnapshotHash(
  runId: string,
  resolved: readonly {
    readonly roleId: RoleId;
    readonly snapshot: ProfileSnapshot;
  }[]
): string {
  const bindings: Record<string, JsonValue> = {};
  const snapshotHashes: Record<string, JsonValue> = {};
  for (const entry of resolved) {
    bindings[entry.roleId] = {
      profileId: entry.snapshot.id,
      revision: entry.snapshot.revision,
      requestedModel: entry.snapshot.requestedModel
    };
    snapshotHashes[`${entry.snapshot.id}@${String(entry.snapshot.revision)}`] = entry.snapshot.hash;
  }
  return sha256Hex(
    canonicalJson({ schemaVersion: 1, runId, bindings, snapshotHashes })
  );
}

/**
 * Create a TaskRun together with its frozen profile snapshots (A34) in ONE
 * transaction:
 *
 * 1. A02 runtime guard: the raw input is deep-scanned for override fields
 *    (`model`, `profileId`, ...) BEFORE anything else — passing one is a
 *    typed rejection, not a silently ignored field.
 * 2. A01: all four role bindings must resolve (missing/unbound/multiple/
 *    unknown-profile/unknown-revision -> `RoleBindingsNotReadyError`).
 * 3. A29: the request target (if given) and every bound profile's target and
 *    path forms must match the project target.
 * 4. The run row + four snapshot rows commit atomically; any failure leaves
 *    neither.
 */
export function createTaskRunWithProfileSnapshot(
  db: DatabaseSync,
  input: CreateTaskRunWithProfileSnapshotInput
): RunWithSnapshotResult {
  assertNoProfileModelOverride(input, "createTaskRunWithProfileSnapshot input");
  const value = CreateTaskRunWithProfileSnapshotInputSchema.parse(input);

  return withTransaction(db, () => {
    const project = requireProject(db, value.projectId);
    if (
      value.requestedExecutionTarget !== undefined &&
      value.requestedExecutionTarget !== project.executionTarget
    ) {
      throw new ExecutionTargetMismatchError(
        "target-differ",
        project.executionTarget,
        value.requestedExecutionTarget,
        "requestedExecutionTarget",
        `requested executionTarget "${value.requestedExecutionTarget}" does not match project target "${project.executionTarget}"; no implicit conversion is performed (A29)`
      );
    }

    const ready: ReadyBindings = validateRoleBindingsReady(db, { projectId: value.projectId });
    for (const entry of ready.resolved) {
      checkExecutionTarget({
        projectTarget: project.executionTarget,
        profileTarget: entry.profile.executionTarget,
        executable: entry.profile.executable,
        configDir: entry.profile.configDir
      });
    }

    const configSnapshotHash = computeRunConfigSnapshotHash(value.runId, ready.resolved);
    let run: TaskRunRow;
    try {
      run = createTaskRun(db, {
        id: value.runId,
        projectId: value.projectId,
        taskId: value.taskId,
        graphRevision: value.graphRevision,
        configSnapshotHash,
        baseSha: value.baseSha,
        status: "PLANNED",
        now: value.now
      });
    } catch (error) {
      if (isUniqueViolation(error, "task_runs.id")) {
        throw new DuplicateRunError(value.runId, { cause: error });
      }
      throw error;
    }

    const snapshots = ready.resolved.map((entry) =>
      insertRunProfileSnapshot(db, {
        runId: value.runId,
        resolved: entry,
        now: value.now
      })
    );
    return { run, configSnapshotHash, snapshots, resolved: ready.resolved };
  });
}

function insertRunProfileSnapshot(
  db: DatabaseSync,
  input: {
    readonly runId: string;
    readonly resolved: ResolvedRoleBinding;
    readonly now: string;
  }
): RunProfileSnapshotRow {
  const snapshotJson = canonicalJson(input.resolved.snapshot);
  const snapshotHash = sha256Hex(snapshotJson);
  db.prepare(
    "INSERT INTO run_profile_snapshots(run_id, role_id, profile_id, profile_revision, snapshot_json, snapshot_hash, created_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    input.runId,
    input.resolved.roleId,
    input.resolved.snapshot.id,
    input.resolved.snapshot.revision,
    snapshotJson,
    snapshotHash,
    input.now
  );
  return {
    runId: input.runId,
    roleId: input.resolved.roleId,
    profileId: input.resolved.snapshot.id,
    profileRevision: input.resolved.snapshot.revision,
    snapshotJson,
    snapshotHash,
    createdAt: input.now
  };
}

export interface RunRoleProfile {
  readonly runId: string;
  readonly roleId: RoleId;
  /** The FROZEN snapshot — not the current binding state (A34). */
  readonly snapshot: ProfileSnapshot;
  readonly profileRevision: number;
  readonly snapshotHash: string;
}

function mapSnapshotRow(row: Row, expectedRole?: RoleId): RunProfileSnapshotRow {
  const roleIdRaw = reqStr(row, "role_id");
  const parsedRole = RoleIdSchema.safeParse(roleIdRaw);
  if (!parsedRole.success) {
    throw new UnknownRoleError(roleIdRaw);
  }
  if (expectedRole !== undefined && parsedRole.data !== expectedRole) {
    throw new UnknownRunSnapshotError(reqStr(row, "run_id"), expectedRole);
  }
  return {
    runId: reqStr(row, "run_id"),
    roleId: parsedRole.data,
    profileId: reqStr(row, "profile_id"),
    profileRevision: reqInt(row, "profile_revision"),
    snapshotJson: reqStr(row, "snapshot_json"),
    snapshotHash: reqStr(row, "snapshot_hash"),
    createdAt: reqStr(row, "created_at")
  };
}

/**
 * THE service read path for an existing run (A34): returns the frozen
 * snapshot for one role, read exclusively from `run_profile_snapshots`.
 * Fails closed: a missing snapshot row is `UnknownRunSnapshotError` (never a
 * silent fallback to current bindings), and a snapshot whose stored JSON no
 * longer matches its recorded hash — or whose parsed content disagrees with
 * the row key — is `SnapshotIntegrityError`.
 */
export function readRunRoleProfile(
  db: DatabaseSync,
  input: { readonly runId: string; readonly roleId: string }
): RunRoleProfile {
  assertKnownRoleId(input.roleId);
  const row = db
    .prepare("SELECT * FROM run_profile_snapshots WHERE run_id = ? AND role_id = ?")
    .get(input.runId, input.roleId);
  if (row === undefined) {
    throw new UnknownRunSnapshotError(input.runId, input.roleId);
  }
  const snapshotRow = mapSnapshotRow(row, input.roleId);
  const snapshot = parseFrozenSnapshot(snapshotRow);
  return {
    runId: snapshotRow.runId,
    roleId: snapshotRow.roleId,
    snapshot,
    profileRevision: snapshotRow.profileRevision,
    snapshotHash: snapshotRow.snapshotHash
  };
}

function assertKnownRoleId(roleId: string): asserts roleId is RoleId {
  const parsed = RoleIdSchema.safeParse(roleId);
  if (!parsed.success) {
    throw new UnknownRoleError(roleId);
  }
}

function parseFrozenSnapshot(row: RunProfileSnapshotRow): ProfileSnapshot {
  const actualHash = sha256Hex(row.snapshotJson);
  if (actualHash !== row.snapshotHash) {
    throw new SnapshotIntegrityError(
      row.runId,
      row.roleId,
      `frozen snapshot for run "${row.runId}" role "${row.roleId}" failed its integrity check: recorded ${row.snapshotHash}, computed ${actualHash}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.snapshotJson) as unknown;
  } catch (error) {
    throw new SnapshotIntegrityError(
      row.runId,
      row.roleId,
      `frozen snapshot for run "${row.runId}" role "${row.roleId}" is not valid JSON`,
      { cause: error }
    );
  }
  const result = ProfileSnapshotSchema.safeParse(parsed);
  if (!result.success) {
    throw new SnapshotIntegrityError(
      row.runId,
      row.roleId,
      `frozen snapshot for run "${row.runId}" role "${row.roleId}" does not match the ProfileSnapshot contract`
    );
  }
  if (result.data.id !== row.profileId || result.data.revision !== row.profileRevision) {
    throw new SnapshotIntegrityError(
      row.runId,
      row.roleId,
      `frozen snapshot content (${result.data.id}@${String(result.data.revision)}) disagrees with the row key (${row.profileId}@${String(row.profileRevision)})`
    );
  }
  return result.data;
}

/** All frozen snapshot rows of a run, ROLE_IDS order. */
export function listRunProfileSnapshots(
  db: DatabaseSync,
  runId: string
): readonly RunProfileSnapshotRow[] {
  const rows = db
    .prepare("SELECT * FROM run_profile_snapshots WHERE run_id = ? ORDER BY role_id ASC")
    .all(runId);
  return rows.map((row) => mapSnapshotRow(row));
}

// ---------------------------------------------------------------------------
// Drift queries
// ---------------------------------------------------------------------------

export type RunBindingDriftKind =
  | "none"
  | "binding-changed"
  | "missing"
  | "unbound"
  | "multiple"
  | "unknown-profile"
  | "unknown-revision";

export interface RunBindingDriftEntry {
  readonly roleId: RoleId;
  readonly kind: RunBindingDriftKind;
  /** Frozen state (what the run will keep using). */
  readonly frozen: { readonly profileId: string; readonly revision: number; readonly model: string | null } | null;
  /** Current binding state, when it resolves; null on any resolution failure. */
  readonly current: { readonly profileId: string; readonly revision: number; readonly model: string | null } | null;
  /** Latest revision of the CURRENT bound profile (informational, never auto-applied). */
  readonly latestRevision: number | null;
  readonly detail: string | null;
}

export interface RunBindingDriftResult {
  readonly runId: string;
  readonly drifted: boolean;
  readonly entries: readonly RunBindingDriftEntry[];
}

interface FrozenBindingView {
  readonly profileId: string;
  readonly revision: number;
  readonly model: string | null;
}

function frozenView(row: RunProfileSnapshotRow, snapshot: ProfileSnapshot): FrozenBindingView {
  return { profileId: row.profileId, revision: row.profileRevision, model: snapshot.requestedModel };
}

function currentView(resolved: ResolvedRoleBinding): FrozenBindingView {
  return {
    profileId: resolved.snapshot.id,
    revision: resolved.snapshot.revision,
    model: resolved.snapshot.requestedModel
  };
}

/**
 * DB-level drift between a run's FROZEN snapshots and the CURRENT role
 * bindings. A04 note: "binding-changed" is a finding, not an error — the run
 * keeps using its frozen revision either way. Model expectation changes are
 * visible as `frozen.model` vs `current.model`.
 */
export function getRunBindingDrift(db: DatabaseSync, runId: string): RunBindingDriftResult {
  const run = getTaskRun(db, runId);
  if (run === null) {
    throw new UnknownRunSnapshotError(runId, null);
  }
  const rows = new Map<string, { row: RunProfileSnapshotRow; snapshot: ProfileSnapshot }>();
  for (const row of listRunProfileSnapshots(db, runId)) {
    rows.set(row.roleId, { row, snapshot: parseFrozenSnapshot(row) });
  }

  const entries: RunBindingDriftEntry[] = [];
  let drifted = false;
  for (const roleId of ROLE_IDS) {
    const frozenEntry = rows.get(roleId);
    if (frozenEntry === undefined) {
      drifted = true;
      entries.push({
        roleId,
        kind: "missing",
        frozen: null,
        current: null,
        latestRevision: null,
        detail: "no frozen snapshot row for this role (incomplete run snapshot)"
      });
      continue;
    }
    const frozen = frozenView(frozenEntry.row, frozenEntry.snapshot);
    try {
      const current = resolveRoleBinding(db, { projectId: run.projectId, roleId });
      const view = currentView(current);
      const latest = getLatestProfileRevision(db, view.profileId);
      if (view.profileId !== frozen.profileId || view.revision !== frozen.revision) {
        drifted = true;
        entries.push({
          roleId,
          kind: "binding-changed",
          frozen,
          current: view,
          latestRevision: latest === null ? null : latest.revision,
          detail:
            `run keeps ${frozen.profileId}@${String(frozen.revision)} (model: ${frozen.model === null ? "cli-default" : frozen.model}); ` +
            `binding now points at ${view.profileId}@${String(view.revision)} (model: ${view.model === null ? "cli-default" : view.model})`
        });
      } else {
        entries.push({
          roleId,
          kind: "none",
          frozen,
          current: view,
          latestRevision: latest === null ? null : latest.revision,
          detail: null
        });
      }
    } catch (error) {
      if (!(error instanceof RoleBindingResolutionError)) {
        throw error;
      }
      drifted = true;
      entries.push({
        roleId,
        kind: error.kind,
        frozen,
        current: null,
        latestRevision: null,
        detail: error.message
      });
    }
  }
  return { runId, drifted, entries };
}

export interface RunExternalConfigDriftEntry {
  readonly profileId: string;
  readonly revision: number;
  readonly configDir: string;
  readonly result: ExternalConfigDriftResult | null;
  /** Set when the profile/revision rows themselves are gone (fail-closed). */
  readonly reason: string | null;
}

export interface RunProfileDriftResult {
  readonly runId: string;
  readonly binding: RunBindingDriftResult;
  readonly externalConfig: readonly RunExternalConfigDriftEntry[];
  readonly drifted: boolean;
}

const CheckRunProfileDriftOptionsSchema = z.strictObject({
  maxFileBytes: z.number().int().min(1).max(64 * 1_048_576).optional()
});

export interface CheckRunProfileDriftOptions {
  readonly maxFileBytes?: number | undefined;
}

/**
 * Full drift check for a run: binding drift (DB) plus external-config drift
 * (filesystem) for every distinct (profile, revision) the run froze. The
 * external comparison is always against the FROZEN revision's baseline — a
 * newer revision changing the files makes the OLD run drift (correctly: the
 * run must not silently adopt them).
 */
export async function checkRunProfileDrift(
  db: DatabaseSync,
  runId: string,
  options: CheckRunProfileDriftOptions = {}
): Promise<RunProfileDriftResult> {
  CheckRunProfileDriftOptionsSchema.parse(options);
  const binding = getRunBindingDrift(db, runId);
  const seen = new Set<string>();
  const external: RunExternalConfigDriftEntry[] = [];
  for (const row of listRunProfileSnapshots(db, runId)) {
    const key = `${row.profileId}@${String(row.profileRevision)}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const profile: ProfileRow | null = getProfile(db, row.profileId);
    const revision: ProfileRevisionRow | null = getProfileRevision(db, row.profileId, row.profileRevision);
    if (profile === null || revision === null) {
      external.push({
        profileId: row.profileId,
        revision: row.profileRevision,
        configDir: profile === null ? "(unknown profile)" : profile.configDir,
        result: null,
        reason:
          profile === null
            ? `profile "${row.profileId}" no longer exists`
            : `revision ${String(row.profileRevision)} of profile "${row.profileId}" no longer exists`
      });
      continue;
    }
    const driftOptions: ExternalConfigOptions =
      options.maxFileBytes === undefined ? {} : { maxFileBytes: options.maxFileBytes };
    const result = await detectExternalConfigDrift({
      configDir: profile.configDir,
      files: revision.externalConfigFiles,
      expectedHash: revision.externalConfigHash,
      options: driftOptions
    });
    external.push({
      profileId: row.profileId,
      revision: row.profileRevision,
      configDir: profile.configDir,
      result,
      reason: null
    });
  }
  const externalDrifted = external.some(
    (entry) => entry.result === null || entry.result.drifted
  );
  return {
    runId,
    binding,
    externalConfig: external,
    drifted: binding.drifted || externalDrifted
  };
}
