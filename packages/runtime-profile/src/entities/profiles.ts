import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { ExecutionTarget } from "@role-orchestrator/contracts";
import { ExecutionTargetSchema, IdSchema, RUNTIMES, RuntimeSchema } from "@role-orchestrator/contracts";
import { isUniqueViolation } from "@role-orchestrator/store";
import type { Row } from "@role-orchestrator/store";
import { reqInt, reqStr, TimestampSchema } from "@role-orchestrator/store";
import { DuplicateProfileError } from "../errors.js";
import { checkExecutionTarget } from "../target.js";

/** The two bundled CLI runtimes (mirrors contracts RuntimeSchema). */
export type Runtime = (typeof RUNTIMES)[number];

/**
 * `profiles` — one local CLI runtime environment (R11). Field bounds reuse the
 * frozen contract schemas (`IdSchema`, `RuntimeSchema`, `ExecutionTargetSchema`)
 * and mirror `contracts/schema/profiles.ts` bounds; `model` and `extraArgs`
 * intentionally live at the REVISION level (a model change is a new revision,
 * and `extraArgs` accepts only empty in v1 so nothing is stored).
 */
export interface ProfileRow {
  readonly id: string;
  readonly runtime: Runtime;
  readonly executable: string;
  readonly executionTarget: ExecutionTarget;
  readonly configDir: string;
  readonly credentialGroup: string;
  readonly maxConcurrency: number;
  readonly timeoutSeconds: number;
  readonly createdAt: string;
}

const CreateProfileInputSchema = z.strictObject({
  id: IdSchema,
  runtime: RuntimeSchema,
  executable: z.string().min(1).max(2048),
  executionTarget: ExecutionTargetSchema,
  configDir: z.string().min(1).max(2048),
  credentialGroup: IdSchema,
  maxConcurrency: z.number().int().min(1).max(32),
  timeoutSeconds: z.number().int().min(30).max(86400),
  now: TimestampSchema
});

export type CreateProfileInput = z.input<typeof CreateProfileInputSchema>;

/**
 * Register a profile. The A29 path-form check runs here — registration is the
 * earliest point a windows-native/wsl mixed-world path can be refused.
 * Registering the same id twice raises `DuplicateProfileError`.
 */
export function createProfile(db: DatabaseSync, input: CreateProfileInput): ProfileRow {
  const value = CreateProfileInputSchema.parse(input);
  // profileTarget === projectTarget here; the target-differ branch cannot
  // fire, the path-form checks are what this validates (A29 at the earliest
  // possible point).
  checkExecutionTarget({
    projectTarget: value.executionTarget,
    profileTarget: value.executionTarget,
    executable: value.executable,
    configDir: value.configDir
  });
  try {
    db.prepare(
      "INSERT INTO profiles(id, runtime, executable, execution_target, config_dir, credential_group, max_concurrency, timeout_seconds, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      value.id,
      value.runtime,
      value.executable,
      value.executionTarget,
      value.configDir,
      value.credentialGroup,
      value.maxConcurrency,
      value.timeoutSeconds,
      value.now
    );
  } catch (error) {
    if (isUniqueViolation(error, "profiles.id")) {
      throw new DuplicateProfileError(value.id, { cause: error });
    }
    throw error;
  }
  return {
    id: value.id,
    runtime: value.runtime,
    executable: value.executable,
    executionTarget: value.executionTarget,
    configDir: value.configDir,
    credentialGroup: value.credentialGroup,
    maxConcurrency: value.maxConcurrency,
    timeoutSeconds: value.timeoutSeconds,
    createdAt: value.now
  };
}

function mapProfileRow(row: Row): ProfileRow {
  return {
    id: reqStr(row, "id"),
    runtime: RuntimeSchema.parse(reqStr(row, "runtime")),
    executable: reqStr(row, "executable"),
    executionTarget: ExecutionTargetSchema.parse(reqStr(row, "execution_target")),
    configDir: reqStr(row, "config_dir"),
    credentialGroup: reqStr(row, "credential_group"),
    maxConcurrency: reqInt(row, "max_concurrency"),
    timeoutSeconds: reqInt(row, "timeout_seconds"),
    createdAt: reqStr(row, "created_at")
  };
}

export function getProfile(db: DatabaseSync, id: string): ProfileRow | null {
  const row = db.prepare("SELECT * FROM profiles WHERE id = ?").get(id);
  return row === undefined ? null : mapProfileRow(row);
}

export function listProfiles(db: DatabaseSync): readonly ProfileRow[] {
  const rows = db.prepare("SELECT * FROM profiles ORDER BY id ASC").all();
  return rows.map(mapProfileRow);
}
