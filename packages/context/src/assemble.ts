/**
 * Layered context assembly (M3-01).
 *
 * Assembles ONE execution's context bundle from the store and trusted
 * configuration, in the layer order of docs/MEMORY_AND_CONTEXT.md section 1:
 *
 *   project_rule (安全与项目规则) -> role (角色职责) -> task (目标/验收)
 *     -> dependency (依赖产物) -> memory (相关项目事实与决策, M3-03)
 *
 * The store is authoritative for IDENTITY, the caller for CONTENT:
 * - the run must exist and belong to the requested project (A15 data-plane
 *   baseline: a bundle is assembled UNDER its own project, or not at all);
 * - the node definition (contracts' TaskNodeSchema — reused, not redefined)
 *   must match the frozen task_nodes row: id, role and the dependency
 *   snapshot, exactly (a foreign node can never pass: it is by construction
 *   absent from the local snapshot);
 * - the role layer's provenance is the pinned ProfileRevision resolved from
 *   role_bindings (A01/A34) — unbound roles fail closed;
 * - when an integration record exists for the node, every dependency commit
 *   SHA must equal the accepted parent output SHA (integration is the sole
 *   authority on what a parent produced).
 *
 * Truncation (docs/MEMORY_AND_CONTEXT.md section 5: 不能为了缩短上下文丢掉
 * 安全限制): when a byte budget is configured and the total exceeds it,
 * whole fragments are dropped from the LOWEST priority layer first
 * (memory -> dependency -> task -> role), later sequences before earlier
 * ones inside a layer. project_rule fragments are NEVER dropped — a budget
 * smaller than the rules alone produces a bundle that exceeds its budget
 * and says so (manifest.budgetExceeded), never one without its rules.
 */
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { IdSchema, TaskNodeSchema, withUniqueItems } from "@role-orchestrator/contracts";
import { getTaskRun } from "@role-orchestrator/store";
import { listRunNodes } from "@role-orchestrator/dag";
import { CommitShaSchema, getIntegrationRecord } from "@role-orchestrator/integration";
import { resolveRoleBinding } from "@role-orchestrator/runtime-profile";
import { derivedId } from "@role-orchestrator/scheduler";
import {
  CONTEXT_LAYERS,
  ContextLayerSchema,
  ContextSourceSchema,
  ContextTrustSchema,
  FragmentContentSchema,
  assertSourceFitsLayer,
  deepFreeze
} from "./fragments.js";
import type { ContextLayer, ContextSource, ContextTrust } from "./fragments.js";
import {
  BUDGET_OMITTED_REASON,
  ContextBundleManifestSchema,
  type AssembledFragment,
  type ContextBundle,
  type ContextBundleManifest,
  type FragmentManifest,
  type OmittedFragment,
  bundleContentHash,
  contentHashOf,
  distinctOmittedReasons,
  manifestDigest
} from "./manifest.js";
import {
  CrossProjectSourceError,
  ForeignDependencyError,
  NodeDefinitionMismatchError,
  StaleMemoryNotAdmittedError,
  UnknownContextTargetError
} from "./errors.js";

/**
 * One user-promoted project rule. Only ACTIVE rules reach the assembler;
 * the promotion gate itself is M3-02 (project_rule 仅用户提升为 active).
 */
const ProjectRuleInputSchema = z.strictObject({
  ruleId: IdSchema,
  revision: z.number().int().min(1).max(9_999_999),
  content: FragmentContentSchema
});

const DependencyInputSchema = z.strictObject({
  sourceNodeId: IdSchema,
  /** The accepted output commit SHA of the dependency node. */
  commitSha: CommitShaSchema,
  /** Optional artifact reference inside that output. */
  artifactId: IdSchema.optional(),
  content: FragmentContentSchema
});

/**
 * ONE memory retrieval result offered for injection (M3-03). Plain data on
 * purpose: this package does not import the memory package (which depends on
 * this one); the memory-search glue maps its hits onto this shape. Provenance
 * is memoryId (source.id) + version (source.revision); the fragment's own
 * contentHash completes the memoryId+version+contentHash citation.
 */
const MemoryFragmentInputSchema = z.strictObject({
  memoryId: IdSchema,
  version: z.number().int().min(1).max(9_999_999),
  content: FragmentContentSchema,
  /** The memory's source artifact/commit SHA, when it carries one. */
  sourceSha: CommitShaSchema.nullable().default(null),
  /** True when the memory's sourceSha reference check flagged it stale. */
  stale: z.boolean().default(false),
  staleReason: z.enum(["missing", "superseded"]).nullable().default(null)
});

export const AssembleContextBundleInputSchema = z.strictObject({
  projectId: IdSchema,
  runId: IdSchema,
  nodeId: IdSchema,
  /** The FULL contract node definition; cross-checked against the store row. */
  node: TaskNodeSchema,
  /** The role's duty text (trusted configuration channel, trust "policy"). */
  roleResponsibility: FragmentContentSchema,
  projectRules: withUniqueItems(z.array(ProjectRuleInputSchema).max(64)),
  dependencies: withUniqueItems(z.array(DependencyInputSchema).max(63)),
  /**
   * Memory retrieval results (M3-03) injected after the dependency layer,
   * truncation-dropped FIRST (lowest priority above project rules). Stale
   * entries are refused unless `includeStaleMemories` is set, and then only
   * with an explicit stale marker prefixed to the fragment content — old
   * evidence is never reused silently.
   */
  memoryEntries: z
    .array(MemoryFragmentInputSchema)
    .max(63)
    .check((ctx) => {
      const ids = ctx.value.map((entry) => entry.memoryId);
      if (new Set(ids).size !== ids.length) {
        ctx.issues.push({
          code: "custom",
          message: "memoryEntries must reference each memory at most once (unique memoryId)",
          input: ctx.value
        });
      }
    })
    .default([]),
  /** Explicit opt-in to inject stale-flagged memories (labeled, never silent). */
  includeStaleMemories: z.boolean().default(false),
  /** UTF-8 byte budget; null = unlimited (default). */
  budgetBytes: z.number().int().min(1).nullable().default(null)
});

export type AssembleContextBundleInput = z.input<typeof AssembleContextBundleInputSchema>;

function sourceTrust(layer: ContextLayer): ContextTrust {
  if (layer === "dependency") {
    return "verified-evidence";
  }
  // Memory content is DATA (A16): it arrives as untrusted-content, never as
  // policy — the trust class is fixed by the layer, not by the content.
  return layer === "memory" ? "untrusted-content" : "policy";
}

/**
 * Internal, mutable fragment accumulator — the truncation pass flips
 * `included`/`omittedReason` before the whole graph is frozen into the
 * public readonly `AssembledFragment` shape.
 */
interface MutableFragment {
  sequence: number;
  layer: ContextLayer;
  trust: ContextTrust;
  source: ContextSource;
  content: string;
  contentHash: string;
  contentBytes: number;
  included: boolean;
  omittedReason: string | null;
}

/**
 * Assemble the context bundle for one node execution. Pure reads: nothing is
 * written; persistence is `persistContextBundle`'s job. The returned object
 * graph is deeply frozen — bundle content is read-only data (A16).
 */
export function assembleContextBundle(
  db: DatabaseSync,
  input: AssembleContextBundleInput
): ContextBundle {
  const value = AssembleContextBundleInputSchema.parse(input);

  // --- store-authoritative identity --------------------------------------
  const run = getTaskRun(db, value.runId);
  if (run === null) {
    throw new UnknownContextTargetError({ runId: value.runId });
  }
  if (run.projectId !== value.projectId) {
    throw new CrossProjectSourceError({
      projectId: value.projectId,
      runId: value.runId,
      runProjectId: run.projectId
    });
  }
  const nodeRow = listRunNodes(db, value.runId).find((node) => node.nodeId === value.nodeId);
  if (nodeRow === undefined) {
    throw new UnknownContextTargetError({ runId: value.runId, nodeId: value.nodeId });
  }
  if (nodeRow.nodeId !== value.node.id) {
    throw new NodeDefinitionMismatchError({
      runId: value.runId,
      nodeId: value.nodeId,
      field: "id",
      detail: `store row is "${nodeRow.nodeId}", definition says "${value.node.id}"`
    });
  }
  if (nodeRow.roleId !== value.node.role) {
    throw new NodeDefinitionMismatchError({
      runId: value.runId,
      nodeId: value.nodeId,
      field: "role",
      detail: `store row is "${nodeRow.roleId}", definition says "${value.node.role}"`
    });
  }
  const snapshot = JSON.stringify(nodeRow.dependencies);
  const definition = JSON.stringify(value.node.dependencies);
  if (snapshot !== definition) {
    throw new NodeDefinitionMismatchError({
      runId: value.runId,
      nodeId: value.nodeId,
      field: "dependencies",
      detail: `frozen snapshot ${snapshot} does not equal the definition ${definition} (order is part of the identity)`
    });
  }

  // Role layer provenance: the pinned ProfileRevision from role_bindings.
  const binding = resolveRoleBinding(db, { projectId: value.projectId, roleId: nodeRow.roleId });

  // Dependency SHA cross-check against the accepted parent outputs.
  const integration = getIntegrationRecord(db, { runId: value.runId, nodeId: value.nodeId });
  const dependencyByNode = new Map(value.dependencies.map((dep) => [dep.sourceNodeId, dep]));
  if (integration !== null) {
    const parents = new Map(integration.manifest.parents.map((parent) => [parent.nodeId, parent]));
    for (const dep of value.dependencies) {
      const parent = parents.get(dep.sourceNodeId);
      if (parent === undefined) {
        throw new ForeignDependencyError({
          runId: value.runId,
          nodeId: value.nodeId,
          sourceNodeId: dep.sourceNodeId,
          detail:
            "the node's integration record lists parents " +
            `[${[...parents.keys()].join(", ") || "none"}], which does not include this dependency`
        });
      }
      if (parent.headSha !== dep.commitSha) {
        throw new ForeignDependencyError({
          runId: value.runId,
          nodeId: value.nodeId,
          sourceNodeId: dep.sourceNodeId,
          detail: `requested SHA ${dep.commitSha} is not the accepted parent output ${parent.headSha}`
        });
      }
    }
  }

  // --- fragment assembly in layer priority order --------------------------
  const fragments: MutableFragment[] = [];
  let sequence = 0;
  const push = (layer: ContextLayer, source: ContextSource, content: string): void => {
    assertSourceFitsLayer(layer, source);
    fragments.push({
      sequence,
      layer,
      trust: sourceTrust(layer),
      source,
      content,
      contentHash: contentHashOf(content),
      contentBytes: Buffer.byteLength(content, "utf8"),
      included: true,
      omittedReason: null
    });
    sequence += 1;
  };

  for (const rule of value.projectRules) {
    push(
      "project_rule",
      ContextSourceSchema.parse({
        kind: "project_rule",
        id: rule.ruleId,
        revision: String(rule.revision),
        profileId: null,
        commitSha: null,
        artifactId: null
      }),
      rule.content
    );
  }

  push(
    "role",
    ContextSourceSchema.parse({
      kind: "role_binding",
      id: nodeRow.roleId,
      revision: String(binding.binding.profileRevision),
      profileId: binding.binding.profileId,
      commitSha: null,
      artifactId: null
    }),
    value.roleResponsibility
  );

  const taskContent = [
    `task: ${value.node.title}`,
    `objective: ${value.node.objective}`,
    "acceptance:",
    ...value.node.acceptanceCriteria.map((criterion) => `- ${criterion}`)
  ].join("\n");
  push(
    "task",
    ContextSourceSchema.parse({
      kind: "task_node",
      id: nodeRow.nodeId,
      revision: nodeRow.definitionRevision,
      profileId: null,
      commitSha: null,
      artifactId: null
    }),
    taskContent
  );

  // Dependency fragments follow the FROZEN snapshot order, not the caller's
  // array order — the snapshot is the canonical sequence.
  for (const depNodeId of nodeRow.dependencies) {
    const dep = dependencyByNode.get(depNodeId);
    if (dep === undefined) {
      throw new ForeignDependencyError({
        runId: value.runId,
        nodeId: value.nodeId,
        sourceNodeId: depNodeId,
        detail: "the frozen dependency snapshot contains this node but no dependency content was provided"
      });
    }
    push(
      "dependency",
      ContextSourceSchema.parse({
        kind: "dependency_output",
        id: dep.sourceNodeId,
        revision: null,
        profileId: null,
        commitSha: dep.commitSha,
        artifactId: dep.artifactId ?? null
      }),
      dep.content
    );
  }

  // --- memory layer (M3-03): retrieval hits, stale-gated ------------------
  // Stale memories are EXCLUDED by default; the explicit opt-in labels each
  // one in its content. Old evidence is therefore never reused silently.
  for (const entry of value.memoryEntries) {
    if (entry.stale && !value.includeStaleMemories) {
      throw new StaleMemoryNotAdmittedError({ memoryId: entry.memoryId });
    }
    const content =
      entry.stale === false
        ? entry.content
        : `[STALE MEMORY ${entry.memoryId} v${String(entry.version)}` +
          `${entry.staleReason === null ? "" : ` reason=${entry.staleReason}`}] ` +
          "this memory's source no longer matches the current baseline; " +
          "re-verify before relying on it.\n" +
          entry.content;
    push(
      "memory",
      ContextSourceSchema.parse({
        kind: "memory_entry",
        id: entry.memoryId,
        revision: String(entry.version),
        profileId: null,
        commitSha: entry.sourceSha,
        artifactId: null
      }),
      content
    );
  }

  // --- budget truncation: dependency -> task -> role, rules never ---------
  const totalBytes = fragments.reduce((sum, fragment) => sum + fragment.contentBytes, 0);
  let keptBytes = totalBytes;
  if (value.budgetBytes !== null && keptBytes > value.budgetBytes) {
    const dropOrder = [...fragments]
      .filter((fragment) => fragment.layer !== "project_rule")
      .sort((a, b) => {
        const layerDelta = CONTEXT_LAYERS.indexOf(b.layer) - CONTEXT_LAYERS.indexOf(a.layer);
        return layerDelta !== 0 ? layerDelta : b.sequence - a.sequence;
      });
    for (const candidate of dropOrder) {
      if (keptBytes <= value.budgetBytes) {
        break;
      }
      candidate.included = false;
      candidate.omittedReason = BUDGET_OMITTED_REASON;
      keptBytes -= candidate.contentBytes;
    }
  }
  const budgetExceeded = value.budgetBytes !== null && keptBytes > value.budgetBytes;

  const readonlyFragments: readonly AssembledFragment[] = fragments;
  const kept = readonlyFragments.filter((fragment) => fragment.included);
  const omitted = readonlyFragments.filter((fragment) => !fragment.included);
  const contentHash = bundleContentHash(kept);

  // --- manifest (bundleId derived from the manifest's own identity) -------
  const coreManifest = {
    schemaVersion: 1,
    bundleId: "bundle-id-pending",
    projectId: value.projectId,
    runId: value.runId,
    nodeId: value.nodeId,
    roleId: nodeRow.roleId,
    budgetMethod: "estimated-bytes",
    budgetBytes: value.budgetBytes,
    budgetExceeded,
    contentHash,
    byteCount: keptBytes,
    fragments: kept.map(toFragmentManifest),
    omitted: omitted.map(toOmittedFragmentManifest),
    omittedReasons: distinctOmittedReasons(omitted)
  };
  const bundleId = derivedId(
    "ctx",
    value.projectId,
    value.runId,
    value.nodeId,
    manifestDigest(ContextBundleManifestSchema.parse(coreManifest))
  );
  const manifest: ContextBundleManifest = ContextBundleManifestSchema.parse({
    ...coreManifest,
    bundleId
  });

  return deepFreeze({ manifest, fragments });
}

function toFragmentManifest(fragment: AssembledFragment): FragmentManifest {
  return {
    sequence: fragment.sequence,
    layer: ContextLayerSchema.parse(fragment.layer),
    trust: ContextTrustSchema.parse(fragment.trust),
    source: fragment.source,
    contentHash: fragment.contentHash,
    contentBytes: fragment.contentBytes
  };
}

function toOmittedFragmentManifest(fragment: AssembledFragment): OmittedFragment {
  return {
    ...toFragmentManifest(fragment),
    omittedReason: fragment.omittedReason ?? BUDGET_OMITTED_REASON
  };
}
