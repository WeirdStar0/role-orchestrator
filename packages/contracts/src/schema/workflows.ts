import { z } from "zod";
import { IdSchema, SchemaVersionSchema } from "./shared.js";
import { TaskNodeSchema } from "./node.js";

/**
 * A workflow is a static graph of task nodes only. The container is strict:
 * workflows may not carry profileId/model overrides any more than nodes may
 * (R13 — configuration precedence is Project RoleBinding -> ProfileRevision,
 * with no Workflow/Task/Node level).
 */
export const WorkflowDefinitionSchema = z.strictObject({
  id: IdSchema,
  name: z.string().min(1).max(200),
  nodes: z.array(TaskNodeSchema).min(1).max(256)
});

export const WorkflowsFileSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  workflows: z.array(WorkflowDefinitionSchema).min(1).max(32)
});

export type WorkflowDefinition = z.infer<typeof WorkflowDefinitionSchema>;
export type WorkflowsFile = z.infer<typeof WorkflowsFileSchema>;
