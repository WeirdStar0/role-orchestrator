/**
 * The context bundle manifest (M3-01) — the ordered, hash-anchored document
 * describing ONE assembled bundle (docs/MEMORY_AND_CONTEXT.md section 5:
 * 保存 contextManifest：片段顺序、来源、版本、内容 hash、删减原因和估算方式).
 *
 * Structure:
 * - `fragments` — the KEPT fragments in assembly order (layer priority
 *   project_rule -> role -> task -> dependency, then caller order inside a
 *   layer). This is exactly what the agent would see.
 * - `omitted` — fragments dropped by byte-budget truncation, with the full
 *   provenance and content hash of what was dropped and why. Truncation is
 *   recorded, never silent.
 * - `contentHash` — sha256 over the CANONICAL serialization of the kept
 *   fragments (order included). This is "bundle 整体 sha256".
 * - `budgetMethod` — always "estimated-bytes" in M3-01: the window is not
 *   verified, so the budget is conservative BYTES and marked estimated
 *   (docs/MEMORY_AND_CONTEXT.md section 5). Token-precision methods are a
 *   later upgrade, not an assumption.
 * - `omittedReasons` — distinct drop reasons (contracts' ContextManifest
 *   vocabulary).
 *
 * The manifest itself is tamper-evident: `manifestDigest(manifest)` is the
 * sha256 of the canonical (explicit key order) JSON, stored alongside the
 * bundle and recomputed on every read and verification.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import {
  ContextLayerSchema,
  ContextSourceSchema,
  ContextTrustSchema,
  Hex64Schema
} from "./fragments.js";

export const CONTEXT_MANIFEST_SCHEMA_VERSION = 1;

/**
 * The budget is counted in UTF-8 bytes and marked estimated — the contract
 * family's "estimated-*" vocabulary with the honest unit. A null budgetBytes
 * means "no budget configured" (nothing is ever dropped then).
 */
export const ContextBudgetMethodSchema = z.literal("estimated-bytes");
export type ContextBudgetMethod = z.output<typeof ContextBudgetMethodSchema>;

export const BUDGET_OMITTED_REASON = "budget-bytes-exceeded";

/** Manifest record of ONE fragment (kept fragments carry no omittedReason). */
const FragmentManifestFields = {
  sequence: z.number().int().min(0),
  layer: ContextLayerSchema,
  trust: ContextTrustSchema,
  source: ContextSourceSchema,
  contentHash: Hex64Schema,
  contentBytes: z.number().int().min(1)
} as const;

export const FragmentManifestSchema = z.strictObject(FragmentManifestFields);
export type FragmentManifest = z.output<typeof FragmentManifestSchema>;

/** A fragment dropped by truncation: same identity, plus the recorded reason. */
export const OmittedFragmentSchema = z.strictObject({
  ...FragmentManifestFields,
  omittedReason: z.string().min(1).max(256)
});
export type OmittedFragment = z.output<typeof OmittedFragmentSchema>;

export const ContextBundleManifestSchema = z.strictObject({
  schemaVersion: z.literal(CONTEXT_MANIFEST_SCHEMA_VERSION),
  bundleId: IdSchema,
  projectId: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  /** The role this bundle was assembled for (the node's frozen role). */
  roleId: RoleIdSchema,
  budgetMethod: ContextBudgetMethodSchema,
  /** Configured byte budget; null = unlimited. */
  budgetBytes: z.number().int().min(1).nullable(),
  /**
   * True when the kept content still exceeds the budget AFTER truncation —
   * only possible when the project rules alone overflow it, because rules
   * are never dropped. Safety outweighs the budget; the excess is recorded,
   * not hidden.
   */
  budgetExceeded: z.boolean(),
  /** sha256 over the canonical serialization of the KEPT fragments. */
  contentHash: Hex64Schema,
  /** Total UTF-8 byte size of the kept content. */
  byteCount: z.number().int().min(0),
  fragments: z.array(FragmentManifestSchema),
  omitted: z.array(OmittedFragmentSchema),
  /** Distinct drop reasons, sorted — contracts' omittedReasons vocabulary. */
  omittedReasons: z.array(z.string().min(1).max(256))
});
export type ContextBundleManifest = z.output<typeof ContextBundleManifestSchema>;

/** One fragment of an assembled bundle: manifest identity + the raw content. */
export interface AssembledFragment {
  readonly sequence: number;
  readonly layer: z.output<typeof ContextLayerSchema>;
  readonly trust: z.output<typeof ContextTrustSchema>;
  readonly source: z.output<typeof ContextSourceSchema>;
  readonly content: string;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly included: boolean;
  readonly omittedReason: string | null;
}

/** A fully assembled bundle: the manifest plus every fragment (kept + dropped). */
export interface ContextBundle {
  readonly manifest: ContextBundleManifest;
  readonly fragments: readonly AssembledFragment[];
}

/** sha256 over UTF-8 bytes of one fragment's content. */
export function contentHashOf(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** The minimal shape canonical serialization needs from a kept fragment. */
export interface CanonicalFragmentInput {
  readonly sequence: number;
  readonly layer: string;
  readonly source: { readonly kind: string; readonly id: string };
  readonly contentHash: string;
  readonly content: string;
}

/** Canonical kept-fragment serialization: one header line + content each. */
export function canonicalBundleBytes(kept: readonly CanonicalFragmentInput[]): string {
  return kept
    .map(
      (fragment) =>
        `${String(fragment.sequence)}\u0000${fragment.layer}\u0000` +
        `${fragment.source.kind}\u0000${fragment.source.id}\u0000` +
        `${fragment.contentHash}\n${fragment.content}\n`
    )
    .join("");
}

/** The bundle's overall sha256 ("bundle 整体 sha256") over kept fragments. */
export function bundleContentHash(kept: readonly CanonicalFragmentInput[]): string {
  return createHash("sha256").update(canonicalBundleBytes(kept), "utf8").digest("hex");
}

/**
 * Canonical manifest JSON with EXPLICIT key order — JSON.stringify order
 * depends on insertion order, so the digest is only stable if the key order
 * is pinned here, not left to whatever built the object.
 */
export function canonicalManifestJson(manifest: ContextBundleManifest): string {
  return JSON.stringify({
    schemaVersion: manifest.schemaVersion,
    bundleId: manifest.bundleId,
    projectId: manifest.projectId,
    runId: manifest.runId,
    nodeId: manifest.nodeId,
    roleId: manifest.roleId,
    budgetMethod: manifest.budgetMethod,
    budgetBytes: manifest.budgetBytes,
    budgetExceeded: manifest.budgetExceeded,
    contentHash: manifest.contentHash,
    byteCount: manifest.byteCount,
    fragments: manifest.fragments.map((fragment) => ({
      sequence: fragment.sequence,
      layer: fragment.layer,
      trust: fragment.trust,
      source: {
        kind: fragment.source.kind,
        id: fragment.source.id,
        revision: fragment.source.revision,
        profileId: fragment.source.profileId,
        commitSha: fragment.source.commitSha,
        artifactId: fragment.source.artifactId
      },
      contentHash: fragment.contentHash,
      contentBytes: fragment.contentBytes
    })),
    omitted: manifest.omitted.map((fragment) => ({
      sequence: fragment.sequence,
      layer: fragment.layer,
      trust: fragment.trust,
      source: {
        kind: fragment.source.kind,
        id: fragment.source.id,
        revision: fragment.source.revision,
        profileId: fragment.source.profileId,
        commitSha: fragment.source.commitSha,
        artifactId: fragment.source.artifactId
      },
      contentHash: fragment.contentHash,
      contentBytes: fragment.contentBytes,
      omittedReason: fragment.omittedReason
    })),
    omittedReasons: manifest.omittedReasons
  });
}

/** sha256 over the canonical manifest JSON — the manifest's tamper anchor. */
export function manifestDigest(manifest: ContextBundleManifest): string {
  return createHash("sha256").update(canonicalManifestJson(manifest), "utf8").digest("hex");
}

/** Distinct, sorted omitted reasons for the manifest field. */
export function distinctOmittedReasons(
  omitted: readonly { readonly omittedReason: string | null }[]
): string[] {
  return [
    ...new Set(
      omitted
        .map((fragment) => fragment.omittedReason)
        .filter((reason): reason is string => reason !== null)
    )
  ].sort();
}
