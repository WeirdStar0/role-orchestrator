import { z } from "zod";
import { IdSchema, SchemaVersionSchema } from "./shared.js";
import { TaskNodeSchema } from "./node.js";

export const ArtifactRefSchema = z.strictObject({
  id: IdSchema,
  kind: z.enum(["report", "design", "test-result", "patch", "context-manifest"])
});

/**
 * Mirrors the JSON Schema's if/then: fact/decision/project_rule memories must
 * carry at least one evidence reference; temporary/discovery may have none.
 */
export const MemoryProposalSchema = z
  .strictObject({
    type: z.enum(["temporary", "fact", "discovery", "decision", "project_rule"]),
    content: z.string().min(1).max(10000),
    evidenceRefs: z.array(IdSchema).max(32)
  })
  .check((ctx) => {
    const { type, evidenceRefs } = ctx.value;
    const requiresEvidence =
      type === "fact" || type === "decision" || type === "project_rule";
    if (requiresEvidence && evidenceRefs.length < 1) {
      ctx.issues.push({
        code: "custom",
        message: `memoryProposals of type "${type}" require at least one evidenceRef`,
        input: ctx.value,
        path: ["evidenceRefs"]
      });
    }
  });

export const ReviewSchema = z.strictObject({
  verdict: z.enum(["pass", "fail", "blocked"]),
  candidateSha: z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/),
  evidenceRefs: z.array(IdSchema).min(1).max(32),
  findings: z.array(z.string().min(1).max(10000)).max(100)
});

/**
 * Mirrors schemas/execution-result.schema.json plus the bundle-level rule that
 * scripts/validate_bundle.py enforces on top of the raw schema: a review
 * verdict may only cite artifacts this result actually reports. An execution
 * that claims success without locatable review evidence is rejected here
 * instead of being judged successful downstream (ACCEPTANCE A06 direction).
 */
export const ExecutionResultSchema = z
  .strictObject({
    schemaVersion: SchemaVersionSchema,
    outcome: z.enum(["completed", "blocked", "needs_approval"]),
    summary: z.string().min(1).max(10000),
    artifactRefs: z.array(ArtifactRefSchema).max(100),
    memoryProposals: z.array(MemoryProposalSchema).max(64),
    taskProposals: z.array(TaskNodeSchema).max(64),
    review: ReviewSchema.optional()
  })
  .check((ctx) => {
    const result = ctx.value;
    if (!result.review) {
      return;
    }
    const artifactIds = new Set(result.artifactRefs.map((artifact) => artifact.id));
    for (const ref of result.review.evidenceRefs) {
      if (!artifactIds.has(ref)) {
        ctx.issues.push({
          code: "custom",
          message: `review.evidenceRefs cites missing artifact: ${ref}`,
          input: result.review,
          path: ["review", "evidenceRefs"]
        });
      }
    }
  });

export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;
export type MemoryProposal = z.infer<typeof MemoryProposalSchema>;
export type Review = z.infer<typeof ReviewSchema>;
export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;
