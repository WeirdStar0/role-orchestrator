import { z } from "zod";
import { PermissionIdSchema, SchemaVersionSchema, withUniqueItems } from "./shared.js";

/**
 * Mirrors schemas/policies.schema.json (example: config/policies.yaml).
 * The security section pins the governance posture: the schema treats any
 * deviation (e.g. unauthenticated local API, unknown capabilities allowed) as
 * invalid input, not as a configurable option.
 */
export const ConcurrencyPolicySchema = z.strictObject({
  globalMax: z.number().int().min(1).max(64),
  projectMax: z.number().int().min(1).max(64),
  // Unverified credential groups stay at 1 until credential isolation is
  // verified (ACCEPTANCE A33); this is a const, not a knob.
  unverifiedCredentialGroupMax: z.literal(1)
});

export const LimitsPolicySchema = z.strictObject({
  maxAttempts: z.number().int().min(1).max(10),
  maxReviewRounds: z.number().int().min(1).max(10),
  maxNodesPerRun: z.number().int().min(1).max(256),
  maxExecutionsPerRun: z.number().int().min(1).max(1024),
  maxDependencyDepth: z.number().int().min(1).max(64)
});

export const SecurityPolicySchema = z.strictObject({
  mode: z.enum(["local-trusted", "hardened"]),
  unknownRequiredCapability: z.literal("deny"),
  allowUnmanagedNativeDelegation: z.literal(false),
  projectRulePromotion: z.literal("human-only"),
  mainDelivery: z.literal("human-approval"),
  remoteWrites: z.literal("disabled"),
  requireLocalApiAuth: z.literal(true),
  networkPolicy: z.literal("explicit-approval")
});

/** One role's permission list: subset of the closed vocabulary, no duplicates. */
export const RolePermissionListSchema = withUniqueItems(z.array(PermissionIdSchema).max(7));

export const UsagePolicySchema = z.strictObject({
  missingUsage: z.literal("unavailable"),
  missingPrice: z.literal("unknown"),
  allowUnknownMonetaryCost: z.boolean()
});

export const PoliciesFileSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  concurrency: ConcurrencyPolicySchema,
  limits: LimitsPolicySchema,
  security: SecurityPolicySchema,
  rolePermissions: z.strictObject({
    coordinator: RolePermissionListSchema,
    architect: RolePermissionListSchema,
    developer: RolePermissionListSchema,
    reviewer: RolePermissionListSchema
  }),
  usage: UsagePolicySchema
});

export type ConcurrencyPolicy = z.infer<typeof ConcurrencyPolicySchema>;
export type LimitsPolicy = z.infer<typeof LimitsPolicySchema>;
export type SecurityPolicy = z.infer<typeof SecurityPolicySchema>;
export type UsagePolicy = z.infer<typeof UsagePolicySchema>;
export type PoliciesFile = z.infer<typeof PoliciesFileSchema>;
