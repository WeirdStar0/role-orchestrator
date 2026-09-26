import { z } from "zod";
import type { ExecutionTarget, RoleId } from "../runtime.js";
import type { Equal, Expect } from "./type-assertions.js";

/** `schemaVersion` is pinned to 1 across every v1 contract file. */
export const SchemaVersionSchema = z.literal(1);

/** Shared identifier pattern `^[a-z][a-z0-9_-]{0,63}$` from the JSON Schemas. */
export const IdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** The four fixed built-in roles (REQUIREMENTS_BASELINE R04). */
export const ROLE_IDS = [
  "coordinator",
  "architect",
  "developer",
  "reviewer",
] as const satisfies readonly RoleId[];
export const RoleIdSchema = z.enum(ROLE_IDS);

/** Execution targets are distinct process/path management worlds (D07). */
export const EXECUTION_TARGETS = [
  "windows-native",
  "wsl",
  "linux-native",
  "macos-native",
] as const satisfies readonly ExecutionTarget[];
export const ExecutionTargetSchema = z.enum(EXECUTION_TARGETS);

/** capabilityTags are annotations for humans/scheduling, never extra roles. */
export const CAPABILITY_TAGS = [
  "planning",
  "architecture",
  "frontend",
  "backend",
  "fullstack",
  "testing",
  "security",
  "devops",
] as const;
export const CapabilityTagSchema = z.enum(CAPABILITY_TAGS);

/** The closed v1 permission vocabulary used by policies.rolePermissions. */
export const PERMISSION_IDS = [
  "repo.read",
  "repo.write",
  "git.read",
  "tests.run",
  "memory.propose",
  "dag.propose",
  "decision.propose",
] as const;
export const PermissionIdSchema = z.enum(PERMISSION_IDS);

/** The two bundled CLI runtimes (R02). */
export const RUNTIMES = ["claude", "codex"] as const;
export const RuntimeSchema = z.enum(RUNTIMES);

/** Attaches a `uniqueItems` check, mirroring `"uniqueItems": true` in JSON Schema. */
export function withUniqueItems<T extends z.ZodType>(schema: z.ZodArray<T>): z.ZodArray<T> {
  return schema.check((ctx) => {
    if (new Set(ctx.value).size !== ctx.value.length) {
      ctx.issues.push({
        code: "custom",
        message: "array items must be unique (uniqueItems)",
        input: ctx.value
      });
    }
  });
}

// The enums must stay identical to the RoleId / ExecutionTarget contracts in
// ../runtime.ts; these aliases fail to compile if either side drifts.
export type RoleIdSchemaMatchesContract = Expect<Equal<z.infer<typeof RoleIdSchema>, RoleId>>;
export type ExecutionTargetSchemaMatchesContract = Expect<
  Equal<z.infer<typeof ExecutionTargetSchema>, ExecutionTarget>
>;
