/**
 * M10-04 task 1 — the READ-side Memory/Context collector behind the M6
 * execution-input seam (docs/MEMORY_AND_CONTEXT.md; the M10-03 batch report's
 * handoff pointed here).
 *
 * Scope red line (读侧接入): this module only READS through the existing
 * package public APIs — `openMemoryAccess(...).search` (memory-search) and
 * `listContextBundles` (context manifest rows). It never writes to the
 * memory/context stores and never changes their write-path semantics. Memory
 * content is DATA (A16): nothing read here feeds back into permissions,
 * bindings, profile selection or dispatch decisions — the ONLY consumer is
 * the node's stdin prompt, as labeled injection blocks.
 *
 * Fail-open (读侧 fail-open,与执行隔离): ANY read-side fault — a missing
 * table in an older store, a query that cannot tokenize, an unauthorized
 * scope — degrades to "no injection" plus ONE eprintln on stderr. It never
 * throws into the dispatch/continuation path: an execution must run even
 * when its shared memory is unreadable. An EMPTY library is not a fault
 * (normal case, no notice, no block).
 *
 * Injection budget (既有预算口径): the context package's conservative
 * estimated-bytes doctrine — whole entries are dropped at the byte budget
 * (never a partial memory), and the drop is RECORDED in the prompt (a
 * truncation note), never silent.
 *
 * Redaction: every injected text passes `redactText` (the shared A36
 * pipeline in cli-events) BEFORE byte accounting, so the budget measures
 * exactly what ships and no secret shape can enter the prompt through a
 * memory. Memory contents are additionally flattened to one line.
 */
import type { DatabaseSync } from "node:sqlite";
import type { RoleId } from "@role-orchestrator/contracts";
import { redactText } from "@role-orchestrator/cli-events";
import { listContextBundles } from "@role-orchestrator/context";
import { openMemoryAccess } from "@role-orchestrator/memory-search";

/** Top-N cap on injected memories (after the stale filter), package order. */
export const MEMORY_INJECTION_MAX_HITS = 5;

/**
 * Injection budget for the memory block, UTF-8 bytes of the redacted
 * single-line contents (estimated-bytes doctrine, conservative). Whole
 * entries that do not fit are dropped and counted in `memoryTruncatedCount`.
 */
export const MEMORY_INJECTION_BUDGET_BYTES = 4096;

/** Top-N cap on context-manifest entry REFERENCES (references only, never full text). */
export const CONTEXT_REFS_MAX_ENTRIES = 5;

/**
 * Objective tokens feeding the search query (the package tokenizer allows
 * at most 16 tokens of 64 chars; keeping the objective share at 6 leaves the
 * role token room while the joined query stays far under MAX_QUERY_LENGTH).
 */
export const MEMORY_QUERY_MAX_TOKENS = 6;

/** One injected memory: identity + status label + redacted single-line content. */
export interface MemoryInjectionEntry {
  readonly memoryId: string;
  readonly version: number;
  /** Only verified/active are retrievable by the package's default statuses. */
  readonly status: "verified" | "active";
  /** Redacted, newline-flattened content — the exact text entering the prompt. */
  readonly content: string;
}

/** One context-manifest entry REFERENCE (bundle identity, never its content). */
export interface ContextManifestRefEntry {
  readonly bundleId: string;
  readonly runId: string;
  readonly nodeId: string;
  readonly contentHash: string;
  readonly byteCount: number;
  readonly createdAt: string;
}

/** What the collector hands to the prompt builder. Empty fields = no block. */
export interface NodeMemoryInjection {
  readonly memories: readonly MemoryInjectionEntry[];
  readonly contextRefs: readonly ContextManifestRefEntry[];
  /**
   * Admissible hits (stale-filtered) NOT injected — by the top-N cap or the
   * byte budget. The prompt renders an explicit truncation note when > 0
   * (truncation is recorded, never silent — M3-01 doctrine).
   */
  readonly memoryTruncatedCount: number;
}

/** The empty injection (degraded or nothing relevant) — no blocks, ever. */
export const EMPTY_MEMORY_INJECTION: NodeMemoryInjection = Object.freeze({
  memories: Object.freeze([]),
  contextRefs: Object.freeze([]),
  memoryTruncatedCount: 0
});

/**
 * Collect the node's memory + context references for prompt injection.
 * NEVER throws: a read-side fault degrades to `EMPTY_MEMORY_INJECTION` plus
 * one stderr notice (fail-open; execution proceeds without injection).
 */
export function collectNodeMemoryInjection(
  db: DatabaseSync,
  input: {
    readonly projectId: string;
    readonly roleId: RoleId;
    /** The node's objective — the retrieval query text (plus the role token). */
    readonly objective: string;
    /** Test overrides of the frozen budget constants (production omits them). */
    readonly maxHits?: number;
    readonly budgetBytes?: number;
    readonly maxContextRefs?: number;
  }
): NodeMemoryInjection {
  try {
    const memories = collectMemories(db, {
      projectId: input.projectId,
      roleId: input.roleId,
      objective: input.objective,
      ...(input.maxHits === undefined ? {} : { maxHits: input.maxHits }),
      ...(input.budgetBytes === undefined ? {} : { budgetBytes: input.budgetBytes })
    });
    return {
      memories: memories.entries,
      memoryTruncatedCount: memories.truncatedCount,
      contextRefs: collectContextRefs(db, input.projectId, input.maxContextRefs)
    };
  } catch (error) {
    emitDegradedNotice(error);
    return EMPTY_MEMORY_INJECTION;
  }
}

// ---------------------------------------------------------------------------
// memory-search retrieval (package public API; default statuses verified+active)
// ---------------------------------------------------------------------------

function collectMemories(
  db: DatabaseSync,
  input: {
    readonly projectId: string;
    readonly roleId: RoleId;
    readonly objective: string;
    readonly maxHits?: number;
    readonly budgetBytes?: number;
  }
): { readonly entries: readonly MemoryInjectionEntry[]; readonly truncatedCount: number } {
  const maxHits = input.maxHits ?? MEMORY_INJECTION_MAX_HITS;
  const budgetBytes = input.budgetBytes ?? MEMORY_INJECTION_BUDGET_BYTES;

  const tokens = objectiveTokens(input.objective);
  if (tokens.length === 0) {
    // A punctuation-only objective has nothing searchable — the normal empty
    // case, not a fault (the package tokenizer would refuse it).
    return { entries: [], truncatedCount: 0 };
  }
  // 按节点 objective + 角色检索: the role id joins the query as one more AND
  // token (the package's documented retrieval semantics).
  const query = [...tokens, input.roleId].join(" ");

  // Fails closed for an unknown project (typed refusal); caught upstream as
  // a degradation — an execution never blocks on its memory read side.
  const access = openMemoryAccess(db, { projectId: input.projectId });
  const hits = access.search({ query });
  // Stale-flagged hits are EXCLUDED by default — the same 选型 as the M3-03
  // bundle glue (排除 over 标注): outdated evidence is not re-injected here.
  const admissible = hits.filter((hit) => !hit.stale);

  const entries: MemoryInjectionEntry[] = [];
  let keptBytes = 0;
  for (const hit of admissible) {
    if (entries.length >= maxHits) break;
    const content = flatten(hit.content);
    const entryBytes = Buffer.byteLength(content, "utf8");
    if (keptBytes + entryBytes > budgetBytes) break; // whole-entry drop at the budget
    keptBytes += entryBytes;
    entries.push({
      memoryId: hit.id,
      version: hit.version,
      status: hit.status === "active" ? "active" : "verified",
      // Redact BEFORE accounting: the budget measures exactly what ships.
      content: redactText(content).text
    });
  }
  return { entries, truncatedCount: admissible.length - entries.length };
}

// ---------------------------------------------------------------------------
// context manifest references (package public API; references, never content)
// ---------------------------------------------------------------------------

function collectContextRefs(
  db: DatabaseSync,
  projectId: string,
  maxContextRefs?: number
): readonly ContextManifestRefEntry[] {
  const max = maxContextRefs ?? CONTEXT_REFS_MAX_ENTRIES;
  // Project-scoped listing (the A15 data-plane baseline — the API REQUIRES
  // the project id). Rows arrive oldest first; the most recent N are the
  // relevant references. Summary fields only — no fragment content is read,
  // let alone inlined.
  const bundles = listContextBundles(db, { projectId });
  return bundles
    .slice(-max)
    .reverse()
    .map((bundle) => ({
      bundleId: bundle.id,
      runId: bundle.runId,
      nodeId: bundle.nodeId,
      contentHash: bundle.contentHash,
      byteCount: bundle.byteCount,
      createdAt: bundle.createdAt
    }));
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/**
 * The objective's leading tokens, bounded by construction to what the
 * package tokenizer accepts (≤ 6 tokens of ≤ 64 chars each).
 */
export function objectiveTokens(objective: string): readonly string[] {
  return objective
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .slice(0, MEMORY_QUERY_MAX_TOKENS)
    .map((token) => (token.length > 64 ? token.slice(0, 64) : token));
}

/** Multi-line memory content becomes one prompt line (deterministic flatten). */
function flatten(content: string): string {
  return content.replace(/\s*\r?\n\s*/g, " ").trim();
}

/** stderr notice for a degraded read (fail-open; never into the pump path). */
function emitDegradedNotice(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  eprintln(`[orchestrator] memory/context injection degraded (read-side fail-open): ${message}`);
}

/** eprintln — one line to stderr (never stdout: the event protocol owns it). */
export function eprintln(line: string): void {
  process.stderr.write(`${line}\n`);
}
