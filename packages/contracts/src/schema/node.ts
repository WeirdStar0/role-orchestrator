import { z } from "zod";
import type { TaskNodeDefinition } from "../runtime.js";
import type { Equal, Expect } from "./type-assertions.js";
import { CapabilityTagSchema, IdSchema, RoleIdSchema, withUniqueItems } from "./shared.js";

/**
 * Mirrors `$defs.node` in schemas/workflows.schema.json and
 * schemas/execution-result.schema.json (the two definitions are identical).
 *
 * Public node definitions intentionally have NO Profile/model fields: the
 * application resolves each role to exactly one profile from user configuration
 * (REQUIREMENTS_BASELINE R03/R12/R13). The object is strict, so any override
 * key is rejected at parse time, and the type-level assertions below fail the
 * build if such a field ever appears on either side.
 */
export const TaskNodeSchema = z
  .strictObject({
    id: IdSchema,
    role: RoleIdSchema,
    title: z.string().min(1).max(200),
    objective: z.string().min(1).max(10000),
    dependencies: withUniqueItems(z.array(IdSchema).max(63)).readonly(),
    capabilityTags: withUniqueItems(z.array(CapabilityTagSchema).max(8)).readonly(),
    acceptanceCriteria: z.array(z.string().min(1).max(10000)).min(1).max(20).readonly()
  })
  .readonly();

/** Field names that must never appear on a public task node definition. */
export type OverrideFieldName =
  | "model"
  | "modelId"
  | "profile"
  | "profileId"
  | "profiles"
  | "fallbackProfileId"
  | "fallbackProfileIds";

/** Fails to compile if TaskNodeDefinition ever gains an override field. */
export type TaskNodeDefinitionIsFreeOfOverrides = Expect<
  Equal<Extract<keyof TaskNodeDefinition, OverrideFieldName>, never>
>;

/** Fails to compile if the Zod node schema ever gains an override field. */
export type TaskNodeSchemaInferenceIsFreeOfOverrides = Expect<
  Equal<Extract<keyof z.infer<typeof TaskNodeSchema>, OverrideFieldName>, never>
>;

/**
 * The frozen runtime.ts interface types capabilityTags as `readonly string[]`
 * while the JSON Schema constrains it to the eight known tags, so full mutual
 * assignability does not hold (the interface is deliberately wider). What is
 * asserted instead:
 * - the Zod inference is assignable TO the contract, so the schema cannot gain
 *   fields or widen types beyond what the frozen interface promises; and
 * - neither side carries any override field name (the assertions above), which
 *   is exactly the R13-critical direction for the interface side.
 */
export type TaskNodeSchemaInferenceSatisfiesRuntimeContract = Expect<
  z.infer<typeof TaskNodeSchema> extends TaskNodeDefinition ? true : false
>;
