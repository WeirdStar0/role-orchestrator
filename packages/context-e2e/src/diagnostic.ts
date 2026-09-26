/**
 * The A36 diagnostic export (M3-04) — a project-scoped diagnostic package
 * (graph state + execution events + what the agent saw + memory references)
 * that goes through the redact pipeline BEFORE it touches the local file it
 * is exported to ("落盘前脱敏").
 *
 * Pipeline, in order:
 *  1. COLLECT from the store via public, project-scoped surfaces only:
 *     run nodes (`dag.listRunNodes`), executions + events
 *     (`store.listExecutionsForRun` / `listEventsForExecution`), persisted
 *     bundles (`context.getContextBundle`, fragments included — the user may
 *     audit "这个 Agent 看到了什么") and memory references through the
 *     AUTHORIZED `MemoryAccess` session (never a raw unscoped query).
 *  2. REDACT the structured document: `cli-events.redactJsonValue` deep-
 *     redacts every string (the DEFAULT_REDACTION_PATTERNS baseline:
 *     Bearer/token/api-key shapes), so a secret smuggled inside any event
 *     payload, bundle fragment or memory content is replaced before
 *     serialization.
 *  3. REDACT AGAIN before the sink: the serialized JSON text passes
 *     `redactText` (idempotent by pattern construction) immediately before
 *     `writeFileSync` — the file never sees an unredacted byte.
 *  4. VERIFY the result: the caller gets the file's sha256/byte count and
 *     redaction counts; the tests read the file back and grep for the
 *     planted secret values.
 *
 * This is the dogfood half of A36: the engine already redacts event payloads
 * at persistence time; the export must not trust that — a hostile payload
 * that reaches the store out-of-band (a legacy row, a future writer bug)
 * still cannot leak through a diagnostic export.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue } from "@role-orchestrator/contracts";
import { redactJsonValue, redactText } from "@role-orchestrator/cli-events";
import { listRunNodes } from "@role-orchestrator/dag";
import { listEventsForExecution, listExecutionsForRun, getTaskRun } from "@role-orchestrator/store";
import { getContextBundle, verifyContextBundle, type ContextBundleRecord } from "@role-orchestrator/context";
import type { MemoryAccess } from "@role-orchestrator/memory-search";
import { ContextE2eUsageError } from "./errors.js";

export interface DiagnosticExportInput {
  /** The authorized session whose project the export belongs to. */
  readonly access: MemoryAccess;
  readonly runId: string;
  /** Executions whose persisted events are included (same run). */
  readonly executionIds: readonly string[];
  /** Persisted bundle ids included with their full fragment content. */
  readonly bundleIds: readonly string[];
  /** Destination file (inside the test's scratch tree). */
  readonly outPath: string;
}

export interface DiagnosticExportResult {
  readonly outPath: string;
  readonly byteCount: number;
  readonly sha256: string;
  /** String substitutions applied to the structured document (pass 1). */
  readonly documentRedactedCount: number;
  /** Substitutions applied to the serialized text before the sink (pass 2). */
  readonly textRedactions: Readonly<Record<string, number>>;
  /** Verified bundle ids (integrity re-checked at export time). */
  readonly verifiedBundleIds: readonly string[];
}

interface DiagnosticDocument {
  readonly schemaVersion: 1;
  readonly kind: "role-orchestrator-diagnostic-export";
  readonly projectId: string;
  readonly runId: string;
  readonly graph: {
    readonly nodes: readonly {
      readonly nodeId: string;
      readonly roleId: string;
      readonly state: string;
      readonly dependencies: readonly string[];
    }[];
    readonly executions: readonly {
      readonly id: string;
      readonly nodeId: string;
      readonly attempt: number;
      readonly phase: string;
    }[];
  };
  readonly events: readonly {
    readonly executionId: string;
    readonly seq: number;
    readonly type: string;
    readonly payload: JsonValue;
  }[];
  readonly bundles: readonly {
    readonly bundleId: string;
    readonly contentHash: string;
    readonly fragments: readonly {
      readonly sequence: number;
      readonly layer: string;
      readonly trust: string;
      readonly source: ContextBundleRecord["manifest"]["fragments"][number]["source"];
      readonly content: string;
    }[];
  }[];
  readonly memoryReferences: readonly {
    readonly memoryId: string;
    readonly version: number;
    readonly type: string;
    readonly status: string;
    readonly contentHash: string;
    readonly content: string;
  }[];
}

/**
 * Build, redact and write ONE diagnostic export. Every memory reference
 * flows through the authorized session; the run must belong to the
 * session's project or the export is refused before anything is read.
 */
export function exportDiagnosticPackage(db: DatabaseSync, input: DiagnosticExportInput): DiagnosticExportResult {
  const { access, runId, executionIds, bundleIds, outPath } = input;

  const run = getTaskRun(db, runId);
  if (run === null) {
    throw new ContextE2eUsageError(`diagnostic export: unknown run "${runId}"`);
  }
  if (run.projectId !== access.projectId) {
    throw new ContextE2eUsageError(
      `diagnostic export: run "${runId}" belongs to project "${run.projectId}", ` +
        `not the authorized scope "${access.projectId}" — project-scoped exports only`
    );
  }

  const document: DiagnosticDocument = {
    schemaVersion: 1,
    kind: "role-orchestrator-diagnostic-export",
    projectId: access.projectId,
    runId,
    graph: {
      nodes: listRunNodes(db, runId).map((node) => ({
        nodeId: node.nodeId,
        roleId: node.roleId,
        state: node.state,
        dependencies: [...node.dependencies]
      })),
      executions: listExecutionsForRun(db, runId)
        .filter((execution) => executionIds.includes(execution.id))
        .map((execution) => ({
          id: execution.id,
          nodeId: execution.nodeId,
          attempt: execution.attempt,
          phase: execution.phase
        }))
    },
    events: executionIds.flatMap((executionId) =>
      listEventsForExecution(db, executionId).map((event) => ({
        executionId,
        seq: event.seq,
        type: event.type,
        payload: JSON.parse(event.payload) as JsonValue
      }))
    ),
    bundles: bundleIds.flatMap((bundleId) => {
      const bundle = getContextBundle(db, bundleId);
      if (bundle === null) {
        throw new ContextE2eUsageError(`diagnostic export: unknown bundle "${bundleId}"`);
      }
      verifyContextBundle(db, bundleId);
      // Iterate the MANIFEST's kept fragments (they carry the trust class)
      // and join the content from the persisted fragment rows by sequence.
      const contentBySequence = new Map(
        bundle.fragments.map((fragment) => [fragment.sequence, fragment])
      );
      return [
        {
          bundleId: bundle.id,
          contentHash: bundle.contentHash,
          fragments: bundle.manifest.fragments.map((entry) => {
            const persisted = contentBySequence.get(entry.sequence);
            return {
              sequence: entry.sequence,
              layer: entry.layer,
              trust: entry.trust,
              source: entry.source,
              content: persisted?.content ?? ""
            };
          })
        }
      ];
    }),
    memoryReferences: access.list().map((memory) => ({
      memoryId: memory.id,
      version: memory.version,
      type: memory.type,
      status: memory.status,
      contentHash: memory.contentHash,
      content: memory.content
    }))
  };

  // Pass 1: deep-redact the structured document (pre-serialization).
  const documentPass = redactJsonValue(document as unknown as JsonValue);
  // Pass 2: redact the serialized text immediately before the sink (A36).
  const serialized = JSON.stringify(documentPass.value, null, 2);
  const textPass = redactText(serialized);
  writeFileSync(outPath, textPass.text, "utf8");

  return {
    outPath,
    byteCount: Buffer.byteLength(textPass.text, "utf8"),
    sha256: createHash("sha256").update(textPass.text, "utf8").digest("hex"),
    documentRedactedCount: documentPass.redactedCount,
    textRedactions: textPass.redactions,
    verifiedBundleIds: [...bundleIds]
  };
}
