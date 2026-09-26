/**
 * M5-03 — the context view: the context bundle's fragment inventory and the
 * per-fragment "why is this here" trace (the A16 data face rendered).
 *
 * Everything shown is projected from the context package's OWN reads:
 * - `listContextBundles` (project-scoped listing, filtered to the run);
 * - `getContextBundle` (re-verifies the manifest hash on every read — a
 *   tampered bundle fails closed instead of rendering);
 * - `traceFragment` (the reverse trace from one sequence to its artifact/
 *   SHA/revision reference — the 为什么入选 provenance the UI explains).
 *
 * The inventory carries, per fragment: the layer (project_rule > role > task
 * > dependency > memory priority), the trust class (policy /
 * verified-evidence / untrusted-content — memory content is DATA, never
 * policy), the full source provenance, the byte size + content hash, the
 * included flag and the truncation marker (`omittedReason`, e.g.
 * budget-bytes-exceeded). Truncation is recorded, never silent.
 *
 * Fragment CONTENT is deliberately not served: the view is a manifest/
 * provenance view (the agent's actual input is pinned by the bundle content
 * hash), keeping secrets-in-content exposure minimal.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  CONTEXT_LAYERS,
  getContextBundle,
  listContextBundles,
  traceFragment,
  type ContextSource
} from "@role-orchestrator/context";
import { getTaskRun } from "@role-orchestrator/store";

/** One fragment of the inventory with its explicit trace. */
export interface ContextFragmentItemView {
  readonly sequence: number;
  readonly layer: string;
  /** Index in the priority order project_rule(0) > role > task > dependency > memory(4). */
  readonly layerPriority: number;
  readonly trust: string;
  readonly source: ContextSource;
  readonly contentHash: string;
  readonly contentBytes: number;
  readonly included: boolean;
  /** The truncation marker (e.g. budget-bytes-exceeded); null when kept. */
  readonly omittedReason: string | null;
  /**
   * The reverse trace (traceFragment): bundle/run/node identity plus the
   * same provenance — the "why is this fragment in my context" record.
   */
  readonly trace: {
    readonly bundleId: string;
    readonly projectId: string;
    readonly runId: string;
    readonly nodeId: string;
    readonly sequence: number;
    readonly layer: string;
    readonly source: ContextSource;
    readonly contentHash: string;
    readonly contentBytes: number;
    readonly included: boolean;
    readonly omittedReason: string | null;
  };
}

export interface ContextBundleItemView {
  readonly bundleId: string;
  readonly nodeId: string;
  readonly roleId: string;
  readonly budgetMethod: string;
  readonly budgetBytes: number | null;
  readonly budgetExceeded: boolean;
  readonly contentHash: string;
  readonly manifestHash: string;
  readonly byteCount: number;
  readonly fragmentCount: number;
  readonly includedCount: number;
  readonly omittedReasons: readonly string[];
  readonly createdAt: string;
  readonly fragments: readonly ContextFragmentItemView[];
}

export interface RunContextView {
  readonly runId: string;
  readonly projectId: string;
  readonly bundles: readonly ContextBundleItemView[];
}

/**
 * The run's context-bundle view, or `null` when the run id is unknown
 * (served 404). Bundles are listed oldest-first (the context package's
 * project-scoped order, filtered to this run — listings never leave the
 * project scope, A15 data-plane discipline).
 */
export function getRunContextView(db: DatabaseSync, runId: string): RunContextView | null {
  const run = getTaskRun(db, runId);
  if (run === null) return null;
  const runBundles = listContextBundles(db, { projectId: run.projectId }).filter(
    (bundle) => bundle.runId === run.id
  );
  const bundles = runBundles.map((summary) => {
    const record = getContextBundle(db, summary.id);
    if (record === null) {
      // listContextBundles just saw this row; a vanishing read is durable
      // corruption, not an empty render.
      throw new Error(`context bundle "${summary.id}" vanished between listing and read`);
    }
    // Trust lives on the manifest entries (kept + omitted), keyed by sequence.
    const trustBySequence = new Map<number, string>();
    for (const entry of [...record.manifest.fragments, ...record.manifest.omitted]) {
      trustBySequence.set(entry.sequence, entry.trust);
    }
    const fragments = record.fragments.map((fragment) => {
      const trace = traceFragment(db, { bundleId: record.id, sequence: fragment.sequence });
      const trust = trustBySequence.get(fragment.sequence);
      if (trust === undefined) {
        // getContextBundle already verified manifest/row agreement; a missing
        // entry here would mean the verify logic was bypassed — fail loudly.
        throw new Error(
          `context bundle "${record.id}" fragment ${String(fragment.sequence)} has no manifest entry`
        );
      }
      return {
        sequence: fragment.sequence,
        layer: fragment.layer,
        layerPriority: CONTEXT_LAYERS.indexOf(fragment.layer),
        trust,
        source: fragment.source,
        contentHash: fragment.contentHash,
        contentBytes: fragment.contentBytes,
        included: fragment.included,
        omittedReason: fragment.omittedReason,
        trace: {
          bundleId: trace.bundleId,
          projectId: trace.projectId,
          runId: trace.runId,
          nodeId: trace.nodeId,
          sequence: trace.sequence,
          layer: trace.layer,
          source: trace.source,
          contentHash: trace.contentHash,
          contentBytes: trace.contentBytes,
          included: trace.included,
          omittedReason: trace.omittedReason
        }
      };
    });
    return {
      bundleId: record.id,
      nodeId: record.nodeId,
      roleId: record.manifest.roleId,
      budgetMethod: record.manifest.budgetMethod,
      budgetBytes: record.manifest.budgetBytes,
      budgetExceeded: record.manifest.budgetExceeded,
      contentHash: record.contentHash,
      manifestHash: record.manifestHash,
      byteCount: record.byteCount,
      fragmentCount: record.fragmentCount,
      includedCount: record.includedCount,
      omittedReasons: [...record.manifest.omittedReasons],
      createdAt: summary.createdAt,
      fragments
    };
  });
  return { runId: run.id, projectId: run.projectId, bundles };
}
