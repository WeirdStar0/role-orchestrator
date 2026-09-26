import { z } from "zod";
import { ExecutionTargetSchema, IdSchema, SchemaVersionSchema } from "./shared.js";

/**
 * Mirrors schemas/project.schema.json (example: config/project.example.yaml).
 * The referenced file names are pinned by `const`, and trust state starts at
 * "requires-user-confirmation": a project directory is never trusted silently.
 */
export const ProjectConfigSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  id: IdSchema,
  repositoryRoot: z.string().min(1).max(2048),
  executionTarget: ExecutionTargetSchema,
  workflowId: IdSchema,
  roleBindingsFile: z.literal("roles.yaml"),
  policiesFile: z.literal("policies.yaml"),
  profileCatalogFile: z.literal("profiles.example.yaml"),
  trustState: z.literal("requires-user-confirmation")
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;
