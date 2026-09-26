import { z } from "zod";
import { ExecutionTargetSchema, IdSchema, RuntimeSchema, SchemaVersionSchema } from "./shared.js";

/**
 * Mirrors schemas/profiles.schema.json (example: config/profiles.example.yaml).
 *
 * A profile describes one CLI runtime environment; authentication stays with
 * the CLI (R11). `model: null` means "use the CLI default model"; an open model
 * ID being accepted by the schema never means a provider supports it.
 * `extraArgs` accepts only an empty array in v1: parameters that could override
 * model/approval/sandbox/resume must not enter through an arbitrary string
 * channel (config/README.md).
 */
export const ProfileConfigSchema = z.strictObject({
  id: IdSchema,
  runtime: RuntimeSchema,
  executable: z.string().min(1).max(2048),
  executionTarget: ExecutionTargetSchema,
  configDir: z.string().min(1).max(2048),
  model: z.nullable(z.string().min(1).max(200)),
  credentialGroup: IdSchema,
  maxConcurrency: z.number().int().min(1).max(32),
  timeoutSeconds: z.number().int().min(30).max(86400),
  // JSON Schema: { "type": "array", "maxItems": 0 } — `never` items reject any entry.
  extraArgs: z.array(z.never()).max(0)
});

export const ProfilesFileSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  profiles: z.array(ProfileConfigSchema).min(1).max(64)
});

export type ProfileConfig = z.infer<typeof ProfileConfigSchema>;
export type ProfilesFile = z.infer<typeof ProfilesFileSchema>;
