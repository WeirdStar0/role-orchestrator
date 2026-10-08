/**
 * M11-03 — the Agent timeline's pure layer: everything the detail page
 * derives from the run's graph + execution rows, unit-test pinned.
 *
 * - `timelineWaves`: the 轮内并行 presentation. A wave is one topological
 *   generation of the DECLARED dependency graph (Kahn leveling): wave 1 =
 *   the roots, wave N+1 = every node whose dependencies all landed in
 *   earlier waves. Nodes of one wave render on ONE row — the honest face of
 *   "多 developer 同排" (the scheduler's actual parallelism is its own
 *   decision; the declared generation is what the data supports). A
 *   dependency cycle (refused at creation by the dag gate, so never a stored
 *   shape) cannot level: the survivors land in a FINAL CATCH-ALL wave rather
 *   than being dropped or spinning forever. That wave renders like any other
 *   「第 N 波」 row — there is deliberately no special cycle label, because a
 *   leveled-out cycle is not a distinct state the data carries (M11-04
 *   review handover ⑪: an earlier header wording claimed a 「依赖成环」
 *   label no component renders; this wording states what exists).
 * - `nodeAttemptSpans`: per-node attempt summaries joined from the run
 *   detail's execution rows (attempt number, phase, a duration ONLY when
 *   both stamps parse — never a fabricated 0).
 */
import { formatDuration } from "./runStatus";

export interface TimelineNodeInput {
  readonly nodeId: string;
  readonly dependencies: readonly string[];
}

export interface TimelineWave {
  readonly index: number;
  /** One row's worth of nodes (same declared generation). */
  readonly nodeIds: readonly string[];
}

export function timelineWaves(nodes: readonly TimelineNodeInput[]): readonly TimelineWave[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const placed = new Set<string>();
  const waves: TimelineWave[] = [];
  let remaining = nodes.map((node) => node.nodeId);
  let index = 1;
  while (remaining.length > 0) {
    const ready = remaining.filter((nodeId) => {
      const node = byId.get(nodeId);
      if (node === undefined) return true; // tolerate a dangling id honestly
      return node.dependencies.every((dependency) => dependency === nodeId || placed.has(dependency));
    });
    if (ready.length === 0) {
      // Cycle (or dangling-only remainder): an honest terminal wave, never
      // an infinite loop and never silently dropped nodes.
      waves.push({ index, nodeIds: [...remaining].sort() });
      break;
    }
    waves.push({ index, nodeIds: [...ready].sort() });
    for (const nodeId of ready) placed.add(nodeId);
    remaining = remaining.filter((nodeId) => !placed.has(nodeId));
    index += 1;
  }
  return waves;
}

export interface AttemptSpan {
  readonly attempt: number;
  readonly phase: string;
  readonly executionId: string;
  /** Human duration when computable; null otherwise (never "0 秒" invented). */
  readonly duration: string | null;
}

export interface NodeAttemptSummary {
  readonly nodeId: string;
  readonly attempts: readonly AttemptSpan[];
}

interface ExecutionRowInput {
  readonly id: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly phase: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function nodeAttemptSpans(executions: readonly ExecutionRowInput[]): readonly NodeAttemptSummary[] {
  const byNode = new Map<string, AttemptSpan[]>();
  for (const execution of executions) {
    const list = byNode.get(execution.nodeId) ?? [];
    list.push({
      attempt: execution.attempt,
      phase: execution.phase,
      executionId: execution.id,
      duration: formatDuration(execution.createdAt, execution.updatedAt)
    });
    byNode.set(execution.nodeId, list);
  }
  return [...byNode.entries()]
    .map(([nodeId, attempts]) => ({
      nodeId,
      attempts: attempts.sort((a, b) => a.attempt - b.attempt)
    }))
    .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0));
}

/** One log line's rendering inputs: the raw type stays verbatim (unknown
 * types are never invented into a wrong 人话), the summary/text payload
 * field is preferred when the event carries one as a string. */
export interface EventLine {
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
  readonly occurredAt: string;
  /** The event's human text: payload.summary / payload.text when string. */
  readonly text: string | null;
}

export function eventLines(events: readonly {
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}[]): readonly EventLine[] {
  return events.map((event) => {
    const summary = event.payload["summary"];
    const text = event.payload["text"];
    return {
      eventId: event.eventId,
      seq: event.seq,
      type: event.type,
      occurredAt: event.occurredAt,
      text: typeof summary === "string" ? summary : typeof text === "string" ? text : null
    };
  });
}
