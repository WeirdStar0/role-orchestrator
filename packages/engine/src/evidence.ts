/**
 * Evidence check — the last, fail-closed gate of the success formula (A06):
 * "要求的 evidence 存在".
 *
 * A successful final result must cite artifacts that the PROTOCOL actually
 * reported. Two policies exist because the two dialects report artifacts
 * differently:
 * - `cited-artifact-ids` (claude): every `artifactRefs[].id` cited by the
 *   business result must appear as the `artifactId` of an
 *   `artifact_reported` event. Strongest form.
 * - `any-artifact-reported` (codex): the codex protocol reports file changes
 *   as `artifact_reported` with `paths` only — per-id equality is not
 *   expressible — so at least one artifact report must exist when the result
 *   cites any artifact. Still fail-closed: zero artifact reports never
 *   satisfies a citing result.
 *
 * The check runs ONLY when every earlier gate passed (exit 0, no protocol
 * errors, final result present and error-free, business schema valid) — a
 * result that cannot be parsed can never satisfy evidence, but it has
 * already failed the schema gate anyway.
 */
import { ExecutionResultSchema } from "@role-orchestrator/contracts";
import type { NormalizedEvent } from "@role-orchestrator/contracts";

export type EvidencePolicyMode = "cited-artifact-ids" | "any-artifact-reported";

export interface EvidenceEvaluation {
  readonly satisfied: boolean;
  readonly citedIds: readonly string[];
  readonly reportedIds: readonly string[];
  readonly missingIds: readonly string[];
}

export function evaluateEvidence(
  policy: EvidencePolicyMode,
  events: readonly NormalizedEvent[]
): EvidenceEvaluation {
  const artifactReports = events.filter((event) => event.type === "artifact_reported");
  // Only the claude-style reports carry a per-artifact id; codex file-change
  // reports carry `paths` instead. Id matching is therefore only meaningful
  // for the cited-ids policy; the any-reported policy counts every report.
  const reportedIds: string[] = [];
  for (const event of artifactReports) {
    const id = event.payload["artifactId"];
    if (typeof id === "string" && id.length > 0) {
      reportedIds.push(id);
    }
  }

  const finalResult = [...events].reverse().find((event) => event.type === "result_reported");
  let citedIds: string[] = [];
  if (finalResult !== undefined) {
    const parsed = ExecutionResultSchema.safeParse(finalResult.payload["businessResult"]);
    if (parsed.success) {
      citedIds = parsed.data.artifactRefs.map((artifact) => artifact.id);
    }
  }

  if (citedIds.length === 0) {
    return { satisfied: true, citedIds, reportedIds, missingIds: [] };
  }
  if (policy === "any-artifact-reported") {
    const satisfied = artifactReports.length > 0;
    return { satisfied, citedIds, reportedIds, missingIds: satisfied ? [] : citedIds };
  }
  const missingIds = citedIds.filter((id) => !reportedIds.includes(id));
  return { satisfied: missingIds.length === 0, citedIds, reportedIds, missingIds };
}
