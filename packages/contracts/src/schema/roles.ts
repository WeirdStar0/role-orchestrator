import { z } from "zod";
import { IdSchema, SchemaVersionSchema } from "./shared.js";

/**
 * Exactly one profile per role (R03/R12): `profileId` is a plain string, so a
 * list of profiles fails validation, and there is no fallback field anywhere.
 */
export const RoleBindingSchema = z.strictObject({
  profileId: IdSchema,
  canCreateSubtasks: z.boolean()
});

/**
 * The fixed four-role binding table. The object is strict with all four roles
 * required: unknown roles (e.g. "tester") and missing roles are both rejected,
 * and user-defined roles do not exist (R04, ACCEPTANCE A03).
 */
export const RolesFileSchema = z.strictObject({
  schemaVersion: SchemaVersionSchema,
  roles: z.strictObject({
    coordinator: RoleBindingSchema,
    architect: RoleBindingSchema,
    developer: RoleBindingSchema,
    reviewer: RoleBindingSchema
  })
});

export type RoleBinding = z.infer<typeof RoleBindingSchema>;
export type RolesFile = z.infer<typeof RolesFileSchema>;
