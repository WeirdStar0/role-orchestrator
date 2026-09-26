/**
 * Fragment vocabulary (M3-01 + M3-03) — the layer/source/trust words every
 * context bundle is built from, and the deep-freeze primitive that makes
 * assembled bundles read-only data (A16 data-plane baseline).
 *
 * Layering follows `docs/MEMORY_AND_CONTEXT.md` section 1: 安全与项目规则 ->
 * 角色职责 -> 当前任务目标/验收 -> 依赖产物 -> 相关项目事实与决策. The five
 * assembly layers are `project_rule` / `role` / `task` / `dependency` /
 * `memory`, in that (priority) order: truncation drops from the END of this
 * list first (memory retrieval hits are dropped BEFORE any M3-01 layer), and
 * project rules are never dropped (budget test pins this). The `memory`
 * layer carries M3-02/M3-03 retrieval results; its provenance cites
 * memoryId (source.id) + version (source.revision) + the fragment's own
 * contentHash, and its trust is always "untrusted-content" (memory content
 * is DATA, never policy).
 *
 * Vocabulary reuse over redefinition:
 * - `trust` reuses contracts' `ContextManifest.items[].trust` union verbatim
 *   ("policy" | "verified-evidence" | "untrusted-content") — a compile-time
 *   assertion below fails if the two ever drift;
 * - `contractScopeOf` maps each layer onto contracts'
 *   `ContextManifest.items[].scope` ("project" | "task" | "role" |
 *   "execution"), the shape an ExecutionRequest will carry once M3-02/03 wire
 *   memory entries into this bundle.
 *
 * A16 baseline: fragment content is DATA. The fields below are plain strings
 * with readonly types; there is deliberately no field, method or helper in
 * this package that converts bundle content into permissions, role bindings,
 * profile selection or capability decisions.
 */
import { z } from "zod";
import { IdSchema } from "@role-orchestrator/contracts";
import type { ContextManifest } from "@role-orchestrator/contracts";
import type { Equal, Expect } from "@role-orchestrator/contracts";
import { CommitShaSchema } from "@role-orchestrator/integration";

/** Assembly layers, index 0 = highest priority (kept until last). */
export const CONTEXT_LAYERS = ["project_rule", "role", "task", "dependency", "memory"] as const;
export type ContextLayer = (typeof CONTEXT_LAYERS)[number];
export const ContextLayerSchema = z.enum(CONTEXT_LAYERS);

/**
 * Finer source type behind each layer. One layer may cite exactly one kind:
 * project_rule -> project_rule, role -> role_binding, task -> task_node,
 * dependency -> dependency_output, memory -> memory_entry (a CHECK in
 * migration 007/010 enforces this per layer together with which provenance
 * columns must be non-null).
 */
export const CONTEXT_SOURCE_KINDS = [
  "project_rule",
  "role_binding",
  "task_node",
  "dependency_output",
  "memory_entry"
] as const;
export type ContextSourceKind = (typeof CONTEXT_SOURCE_KINDS)[number];
export const ContextSourceKindSchema = z.enum(CONTEXT_SOURCE_KINDS);

/**
 * Complete provenance carried by EVERY fragment ("类型、来源 id、
 * artifact/SHA/revision 引用"). Nullable columns are layer-specific; the
 * SQL CHECKs and `assertSourceFitsLayer` keep the two in lockstep:
 * - project_rule:  revision = promoted rule revision
 * - role_binding:  profileId + revision = pinned ProfileRevision (A01/A34)
 * - task_node:     revision = the workflow definition revision
 * - dependency_output: commitSha = the accepted parent output SHA
 * - memory_entry:  id = memoryId, revision = memory version (M3-03);
 *   commitSha optionally carries the memory's sourceSha so a memory
 *   fragment stays reverse-traceable to its source artifact/commit
 */
export const ContextSourceSchema = z.strictObject({
  kind: ContextSourceKindSchema,
  id: IdSchema,
  revision: z.string().min(1).max(128).nullable(),
  profileId: IdSchema.nullable(),
  commitSha: CommitShaSchema.nullable(),
  artifactId: IdSchema.nullable()
});
export type ContextSource = z.output<typeof ContextSourceSchema>;

/** Which provenance columns each layer's source must/must not set. */
export function assertSourceFitsLayer(layer: ContextLayer, source: ContextSource): void {
  const expectedKind: ContextSourceKind = LAYER_SOURCE_KIND[layer];
  if (source.kind !== expectedKind) {
    throw new Error(
      `source kind "${source.kind}" does not fit layer "${layer}" (expected "${expectedKind}")`
    );
  }
  const needs = LAYER_SOURCE_REQUIREMENTS[layer];
  for (const field of ["revision", "profileId", "commitSha", "artifactId"] as const) {
    const value = source[field];
    const required = needs.requires.includes(field);
    if (required && value === null) {
      throw new Error(`source of layer "${layer}" must set ${field}`);
    }
    if (!required && value !== null && !needs.maySet.includes(field)) {
      throw new Error(`source of layer "${layer}" must not set ${field}`);
    }
  }
}

const LAYER_SOURCE_KIND: Readonly<Record<ContextLayer, ContextSourceKind>> = Object.freeze({
  project_rule: "project_rule",
  role: "role_binding",
  task: "task_node",
  dependency: "dependency_output",
  memory: "memory_entry"
});

interface LayerSourceRequirements {
  readonly requires: readonly ("revision" | "profileId" | "commitSha" | "artifactId")[];
  readonly maySet: readonly ("revision" | "profileId" | "commitSha" | "artifactId")[];
}

const LAYER_SOURCE_REQUIREMENTS: Readonly<Record<ContextLayer, LayerSourceRequirements>> =
  Object.freeze({
    project_rule: { requires: ["revision"], maySet: ["revision", "artifactId"] },
    role: { requires: ["revision", "profileId"], maySet: ["revision", "profileId"] },
    task: { requires: ["revision"], maySet: ["revision", "artifactId"] },
    dependency: { requires: ["commitSha"], maySet: ["commitSha", "artifactId", "revision"] },
    memory: { requires: ["revision"], maySet: ["revision", "commitSha"] }
  });

/**
 * Trust classes — the exact union of contracts'
 * `ContextManifest["items"][number]["trust"]`, reused verbatim. M3-01 emits
 * "policy" (rules, role duties, task definitions from trusted
 * configuration) and "verified-evidence" (dependency outputs pinned by
 * accepted commit SHAs); the M3-03 `memory` layer emits "untrusted-content"
 * (memory content is DATA) and the A16 semantics hold for every class.
 */
export const CONTEXT_TRUST_LEVELS = ["policy", "verified-evidence", "untrusted-content"] as const;
export type ContextTrust = (typeof CONTEXT_TRUST_LEVELS)[number];
export const ContextTrustSchema = z.enum(CONTEXT_TRUST_LEVELS);

/** Fails to compile if the trust vocabulary drifts from contracts. */
export type ContextTrustMatchesContract = Expect<
  Equal<ContextTrust, ContextManifest["items"][number]["trust"]>
>;

/** The four scope words of contracts' ContextManifest items. */
export const CONTEXT_CONTRACT_SCOPES = ["project", "task", "role", "execution"] as const;
export type ContextContractScope = (typeof CONTEXT_CONTRACT_SCOPES)[number];

/** Fails to compile if the scope vocabulary drifts from contracts. */
export type ContextContractScopeMatchesContract = Expect<
  Equal<ContextContractScope, ContextManifest["items"][number]["scope"]>
>;

/**
 * Pure mapping from assembly layer to the contract scope an ExecutionRequest
 * manifest item would carry. Dependency artifacts are execution-scoped
 * (they exist for THIS node's execution); memory retrieval hits are
 * project-scoped (they are the project's facts/decisions); everything else
 * maps 1:1.
 */
export function contractScopeOf(layer: ContextLayer): ContextContractScope {
  switch (layer) {
    case "project_rule":
      return "project";
    case "role":
      return "role";
    case "task":
      return "task";
    case "dependency":
      return "execution";
    case "memory":
      return "project";
  }
}

/** sha256 hex digest (64 lowercase hex chars) — the shared content-hash form. */
export const Hex64Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** Upper bound for a single fragment's content (UTF-8 bytes). */
export const MAX_FRAGMENT_CONTENT_BYTES = 262_144;

/** The ContentSchema body: fragment content is always plain string data. */
export const FragmentContentSchema = z
  .string()
  .min(1)
  .max(MAX_FRAGMENT_CONTENT_BYTES)
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_FRAGMENT_CONTENT_BYTES,
    `fragment content exceeds ${String(MAX_FRAGMENT_CONTENT_BYTES)} UTF-8 bytes`
  );

/**
 * Recursively freeze a freshly assembled object graph. Bundle shapes are
 * trees (no cycles by construction), but the seen-set keeps a malicious or
 * accidental cycle from looping forever instead of trusting it.
 */
export function deepFreeze<T>(value: T, seen: Set<object> = new Set()): T {
  if (value === null || typeof value !== "object") {
    return value;
  }
  const target: object = value;
  if (seen.has(target)) {
    return value;
  }
  seen.add(target);
  for (const key of Object.getOwnPropertyNames(target)) {
    deepFreeze((target as Record<string, unknown>)[key], seen);
  }
  Object.freeze(target);
  return value;
}
