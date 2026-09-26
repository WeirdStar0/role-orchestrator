/**
 * Typed error taxonomy for @role-orchestrator/context.
 *
 * Every error names the bundle/fragment/run it concerns and carries the raw
 * cause as `cause` where one exists. None of them ever guesses a successful
 * outcome; integrity failures are loud because a tampered or incomplete
 * bundle must never be presented as "what the agent saw" (docs/MEMORY_AND_CONTEXT.md
 * section 5: 保存 contextManifest 并可校验).
 */
export class ContextError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ContextError";
  }
}

/**
 * A15 (data-plane baseline): the caller asked for a bundle under a project
 * that does not own the run. Authorization-layer enforcement lands in M3-03;
 * the data layer already refuses to assemble or store a bundle whose run
 * belongs to a different project.
 */
export class CrossProjectSourceError extends ContextError {
  readonly projectId: string;
  readonly runId: string;
  readonly runProjectId: string;

  constructor(input: { readonly projectId: string; readonly runId: string; readonly runProjectId: string }) {
    super(
      `run "${input.runId}" belongs to project "${input.runProjectId}", not to "${input.projectId}"; ` +
        "assembling a context bundle across projects is refused at the data layer"
    );
    this.name = "CrossProjectSourceError";
    this.projectId = input.projectId;
    this.runId = input.runId;
    this.runProjectId = input.runProjectId;
  }
}

/**
 * A dependency fragment cannot be tied to this node's own frozen dependency
 * snapshot, or its commit SHA contradicts the accepted parent output recorded
 * by integration. This is the mechanism that keeps project A's dependency
 * artifacts out of project B's bundles: a foreign node id is by construction
 * absent from the local snapshot.
 */
export class ForeignDependencyError extends ContextError {
  readonly runId: string;
  readonly nodeId: string;
  readonly sourceNodeId: string;
  readonly detail: string;

  constructor(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly sourceNodeId: string;
    readonly detail: string;
  }) {
    super(
      `dependency "${input.sourceNodeId}" of node "${input.nodeId}" (run "${input.runId}") is not admissible: ${input.detail}`
    );
    this.name = "ForeignDependencyError";
    this.runId = input.runId;
    this.nodeId = input.nodeId;
    this.sourceNodeId = input.sourceNodeId;
    this.detail = input.detail;
  }
}

/** The run or node a bundle was requested for does not exist in the store. */
export class UnknownContextTargetError extends ContextError {
  readonly runId: string;
  readonly nodeId: string | null;

  constructor(input: { readonly runId: string; readonly nodeId?: string }) {
    super(
      input.nodeId === undefined
        ? `cannot assemble a context bundle: run "${input.runId}" does not exist`
        : `cannot assemble a context bundle: node "${input.nodeId}" does not exist in run "${input.runId}"`
    );
    this.name = "UnknownContextTargetError";
    this.runId = input.runId;
    this.nodeId = input.nodeId ?? null;
  }
}

/** The queried bundle id has no stored row. */
export class UnknownContextBundleError extends ContextError {
  readonly bundleId: string;

  constructor(bundleId: string) {
    super(`context bundle "${bundleId}" does not exist`);
    this.name = "UnknownContextBundleError";
    this.bundleId = bundleId;
  }
}

/** The queried fragment sequence does not exist inside the bundle. */
export class UnknownContextFragmentError extends ContextError {
  readonly bundleId: string;
  readonly sequence: number;

  constructor(input: { readonly bundleId: string; readonly sequence: number }) {
    super(
      `context bundle "${input.bundleId}" has no fragment with sequence ${String(input.sequence)}`
    );
    this.name = "UnknownContextFragmentError";
    this.bundleId = input.bundleId;
    this.sequence = input.sequence;
  }
}

/** The assembled node definition contradicts the store's frozen node row. */
export class NodeDefinitionMismatchError extends ContextError {
  readonly runId: string;
  readonly nodeId: string;
  readonly field: string;
  readonly detail: string;

  constructor(input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly field: string;
    readonly detail: string;
  }) {
    super(
      `node definition for "${input.nodeId}" (run "${input.runId}") contradicts the frozen task_nodes row in field "${input.field}": ${input.detail}`
    );
    this.name = "NodeDefinitionMismatchError";
    this.runId = input.runId;
    this.nodeId = input.nodeId;
    this.field = input.field;
    this.detail = input.detail;
  }
}

/**
 * M3-03: a memory entry flagged stale (its sourceSha no longer matches the
 * current baseline, or the source is gone) was offered for injection while
 * stale-memory admission was NOT explicitly enabled. Old evidence is never
 * reused silently: assembly excludes stale memories by default, and the
 * explicit opt-in labels every stale fragment in its content.
 */
export class StaleMemoryNotAdmittedError extends ContextError {
  readonly memoryId: string;

  constructor(input: { readonly memoryId: string }) {
    super(
      `memory "${input.memoryId}" is marked stale and was not admitted: bundle assembly ` +
        "excludes stale memories by default; pass includeStaleMemories to inject them " +
        "with an explicit stale marker in the fragment content"
    );
    this.name = "StaleMemoryNotAdmittedError";
    this.memoryId = input.memoryId;
  }
}

export type ContextIntegrityKind =
  | "fragment-hash"
  | "fragment-size"
  | "bundle-hash"
  | "manifest-hash"
  | "missing-fragment"
  | "count-mismatch"
  | "fragment-manifest-mismatch";

/**
 * Recomputation found a stored bundle/manifest that does not match its own
 * hashes — tampering, truncation by hand, or a partial write. The bundle is
 * treated as unreadable: callers must not render it, and must not derive any
 * decision from it.
 */
export class ContextManifestIntegrityError extends ContextError {
  readonly bundleId: string;
  readonly kind: ContextIntegrityKind;
  readonly detail: string;

  constructor(input: { readonly bundleId: string; readonly kind: ContextIntegrityKind; readonly detail: string }) {
    super(
      `context bundle "${input.bundleId}" failed integrity verification (${input.kind}): ${input.detail}`
    );
    this.name = "ContextManifestIntegrityError";
    this.bundleId = input.bundleId;
    this.kind = input.kind;
    this.detail = input.detail;
  }
}
