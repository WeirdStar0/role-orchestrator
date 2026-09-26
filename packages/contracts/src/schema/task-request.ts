import { z } from "zod";
import { IdSchema, SchemaVersionSchema } from "./shared.js";

/**
 * Mirrors schemas/task-request.schema.json (example:
 * config/task-request.example.json).
 *
 * Deliberately has no Profile/model fields: the coordinator chooses roles,
 * the user's configuration decides the model mapping (R14). Any override key
 * is rejected because the object is strict.
 */
export const TaskRequestSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  goal: z.string().min(1).max(10000),
  acceptanceCriteria: z.array(z.string().min(1).max(10000)).min(1).max(20),
  workflowId: IdSchema
});

export type TaskRequest = z.infer<typeof TaskRequestSchema>;
