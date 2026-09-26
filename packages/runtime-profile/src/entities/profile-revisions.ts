import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { ProfileSnapshot } from "@role-orchestrator/contracts";
import { hashExternalConfigFiles, normalizeExternalConfigManifest } from "../drift.js";
import {
  ExternalConfigViolationError,
  ProfileRevisionConflictError,
  UnknownProfileError
} from "../errors.js";
import { canonicalJson, sha256Hex } from "../hashing.js";
import type { Row } from "@role-orchestrator/store";
import { optStr, reqInt, reqStr, TimestampSchema } from "@role-orchestrator/store";
import { isUniqueViolation } from "@role-orchestrator/store";
import type { ProfileRow } from "./profiles.js";
import { getProfile } from "./profiles.js";

/**
 * `profile_revisions` — immutable, append-only revisions. A revision pins the
 * full execution-relevant configuration: model expectation (null = use the
 * CLI default model), plus the external host-config baseline
 * (`externalConfigHash` over the EXPLICIT non-credential file manifest).
 * Runtime validation of the model value happens at execution time (capability
 * probe); storing an open string never implies a provider supports it
 * (docs/PROFILE_AND_MODEL.md).
 */
export interface ProfileRevisionRow {
  readonly profileId: string;
  readonly revision: number;
  readonly model: string | null;
  readonly externalConfigHash: string;
  /** The pinned manifest: normalized, deduplicated, sorted relative paths. */
  readonly externalConfigFiles: readonly string[];
  /** sha256 over the canonical revision config; equals `ProfileSnapshot.hash`. */
  readonly configHash: string;
  readonly createdAt: string;
}

const CreateProfileRevisionInputSchema = z.strictObject({
  profileId: z.string().min(1).max(64),
  revision: z.number().int().min(1).optional(),
  /** Explicit model expectation; `null` = the CLI's own default model. */
  model: z.string().min(1).max(200).nullable(),
  externalConfigFiles: z.array(z.string().min(1).max(1024)).max(256),
  /**
   * Precomputed baseline hash. When omitted, the baseline is computed NOW from
   * the profile's configDir (requires the declared files to exist and pass the
   * credential/size/symlink screens). Provide it only when registering a
   * profile before its configDir exists on this machine.
   */
  externalConfigHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  now: TimestampSchema
});

export type CreateProfileRevisionInput = z.input<typeof CreateProfileRevisionInputSchema>;

/**
 * Create the next immutable revision. Refuses: unknown profile
 * (`UnknownProfileError`), an explicit revision that already exists
 * (`ProfileRevisionConflictError`), and any manifest entry matching a
 * credential pattern / escaping configDir (`ExternalConfigViolationError`) —
 * credential files are never registered, let alone hashed.
 *
 * NOTE: when the baseline is computed from disk this function is async and
 * performs file reads; call it OUTSIDE `withTransaction` (do not hold the
 * write lock during I/O). The INSERT itself is a single atomic statement.
 */
export async function createProfileRevision(
  db: DatabaseSync,
  input: CreateProfileRevisionInput
): Promise<ProfileRevisionRow> {
  const value = CreateProfileRevisionInputSchema.parse(input);
  const profile = getProfile(db, value.profileId);
  if (profile === null) {
    throw new UnknownProfileError(value.profileId);
  }

  // Validate + normalize + credential-screen + dedupe + sort the manifest.
  // requireClean=true: registration refuses bad entries outright.
  const manifest = normalizeExternalConfigManifest(value.externalConfigFiles, true);
  const files = manifest.map((entry) => entry.path);

  const latest = getLatestProfileRevision(db, value.profileId);
  const revision = value.revision ?? (latest === null ? 1 : latest.revision + 1);
  if (getProfileRevision(db, value.profileId, revision) !== null) {
    throw new ProfileRevisionConflictError(value.profileId, revision);
  }

  let externalConfigHash: string;
  if (value.externalConfigHash !== undefined) {
    externalConfigHash = value.externalConfigHash;
  } else {
    try {
      externalConfigHash = (await hashExternalConfigFiles(profile.configDir, files)).manifestHash;
    } catch (error) {
      if (error instanceof ExternalConfigViolationError) {
        throw new ExternalConfigViolationError(
          error.kind,
          error.path,
          `cannot baseline revision: ${error.message}`,
          { cause: error }
        );
      }
      throw error;
    }
  }

  const configHash = profileConfigHash(profile, { revision, model: value.model, files });

  try {
    db.prepare(
      "INSERT INTO profile_revisions(profile_id, revision, model, external_config_hash, external_config_files, config_hash, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run(
      value.profileId,
      revision,
      value.model,
      externalConfigHash,
      JSON.stringify(files),
      configHash,
      value.now
    );
  } catch (error) {
    if (isUniqueViolation(error, "profile_revisions.revision")) {
      throw new ProfileRevisionConflictError(value.profileId, revision, { cause: error });
    }
    throw error;
  }
  return {
    profileId: value.profileId,
    revision,
    model: value.model,
    externalConfigHash,
    externalConfigFiles: files,
    configHash,
    createdAt: value.now
  };
}

/**
 * Canonical revision config hash — the `ProfileSnapshot.hash` value. Sorted
 * key canonical JSON so it is stable across processes.
 */
export function profileConfigHash(
  profile: ProfileRow,
  revision: { readonly revision: number; readonly model: string | null; readonly files: readonly string[] }
): string {
  return sha256Hex(
    canonicalJson({
      id: profile.id,
      revision: revision.revision,
      runtime: profile.runtime,
      executable: profile.executable,
      executionTarget: profile.executionTarget,
      configDir: profile.configDir,
      model: revision.model,
      credentialGroup: profile.credentialGroup,
      maxConcurrency: profile.maxConcurrency,
      timeoutSeconds: profile.timeoutSeconds,
      externalConfigFiles: [...revision.files].sort()
    })
  );
}

/**
 * Build the frozen `ProfileSnapshot` (the contracts type — reused, not
 * redefined) for a revision. Secret-free by construction: the snapshot type
 * has no field that could carry credential material.
 */
export function profileRevisionToSnapshot(profile: ProfileRow, revision: ProfileRevisionRow): ProfileSnapshot {
  return {
    id: profile.id,
    revision: revision.revision,
    hash: revision.configHash,
    runtime: profile.runtime,
    executable: profile.executable,
    executionTarget: profile.executionTarget,
    configDir: profile.configDir,
    requestedModel: revision.model,
    credentialGroup: profile.credentialGroup,
    externalConfigHash: revision.externalConfigHash
  };
}

/**
 * Runtime body for the frozen contracts `ProfileSnapshot` type (which is a
 * type-only interface). Kept in strict parity with the interface; the test
 * suite asserts assignability in both meaningful directions so drift fails
 * the build.
 */
export const ProfileSnapshotSchema = z.strictObject({
  id: z.string().min(1).max(64),
  revision: z.number().int().min(1),
  hash: z.string().min(1).max(128),
  runtime: z.enum(["claude", "codex"]),
  executable: z.string().min(1).max(2048),
  executionTarget: z.enum(["windows-native", "wsl", "linux-native", "macos-native"]),
  configDir: z.string().min(1).max(2048),
  requestedModel: z.string().min(1).max(200).nullable(),
  credentialGroup: z.string().min(1).max(64),
  externalConfigHash: z.string().min(1).max(128)
});

/** Compile-time: the schema inference satisfies the frozen contract type. */
export type ProfileSnapshotSchemaMatchesContract = z.infer<typeof ProfileSnapshotSchema> extends ProfileSnapshot
  ? true
  : false;

function mapProfileRevisionRow(row: Row): ProfileRevisionRow {
  const rawFiles = reqStr(row, "external_config_files");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawFiles) as unknown;
  } catch (error) {
    throw new Error("stored external_config_files is not valid JSON", { cause: error });
  }
  const files = z.array(z.string().min(1).max(1024)).max(256).parse(parsed);
  return {
    profileId: reqStr(row, "profile_id"),
    revision: reqInt(row, "revision"),
    model: optStr(row, "model"),
    externalConfigHash: reqStr(row, "external_config_hash"),
    externalConfigFiles: files,
    configHash: reqStr(row, "config_hash"),
    createdAt: reqStr(row, "created_at")
  };
}

export function getProfileRevision(
  db: DatabaseSync,
  profileId: string,
  revision: number
): ProfileRevisionRow | null {
  const row = db
    .prepare("SELECT * FROM profile_revisions WHERE profile_id = ? AND revision = ?")
    .get(profileId, revision);
  return row === undefined ? null : mapProfileRevisionRow(row);
}

export function getLatestProfileRevision(db: DatabaseSync, profileId: string): ProfileRevisionRow | null {
  const row = db
    .prepare("SELECT * FROM profile_revisions WHERE profile_id = ? ORDER BY revision DESC LIMIT 1")
    .get(profileId);
  return row === undefined ? null : mapProfileRevisionRow(row);
}

export function listProfileRevisions(db: DatabaseSync, profileId: string): readonly ProfileRevisionRow[] {
  const rows = db
    .prepare("SELECT * FROM profile_revisions WHERE profile_id = ? ORDER BY revision ASC")
    .all(profileId);
  return rows.map(mapProfileRevisionRow);
}
