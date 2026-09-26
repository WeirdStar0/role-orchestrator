import { z } from "zod";

/**
 * Hierarchical resource keys for quota grants (ORCHESTRATION.md section 4:
 * "每次认领同时检查 Global、Project、Profile 的活动租约数" plus the
 * credentialGroup lock of the same section).
 *
 * The four dimensions share one grants table; the key encodes both the
 * dimension and its scope. Key FORMS are strict — a key that does not parse
 * can neither be granted nor counted, so a typo can never silently widen a
 * quota into an uncounted resource.
 *
 * - `global`               — the run-wide cap (`globalMax`)
 * - `project:<projectId>`  — per-project cap (`projectMax`)
 * - `profile:<profileId>`  — per-profile cap (`profiles.max_concurrency`)
 * - `credential:<groupId>` — credentialGroup lock (A33; max comes from
 *                            `unverifiedCredentialGroupMax` while isolation
 *                            is unverified)
 *
 * Project/profile/group components reuse the contracts `IdSchema` vocabulary,
 * so a component can never contain `:` and the dimension prefix stays
 * unambiguous.
 */
export const QUOTA_DIMENSIONS = ["global", "project", "profile", "credential"] as const;
export type QuotaDimension = (typeof QUOTA_DIMENSIONS)[number];

export const QuotaDimensionSchema = z.enum(QUOTA_DIMENSIONS);

const KEY_COMPONENT_SCHEMA = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

export const QuotaResourceKeySchema = z
  .string()
  .min(1)
  .max(256)
  .superRefine((value, ctx) => {
    if (value === "global") {
      return;
    }
    const separator = value.indexOf(":");
    if (separator === -1) {
      ctx.addIssue({
        code: "custom",
        message:
          `invalid quota resource key "${value}": expected "global", "project:<id>", ` +
          `"profile:<id>" or "credential:<id>"`
      });
      return;
    }
    const dimension = value.slice(0, separator);
    const component = value.slice(separator + 1);
    if (dimension !== "project" && dimension !== "profile" && dimension !== "credential") {
      ctx.addIssue({
        code: "custom",
        message: `unknown quota resource key dimension "${dimension}" in "${value}"`
      });
      return;
    }
    if (!KEY_COMPONENT_SCHEMA.safeParse(component).success) {
      ctx.addIssue({
        code: "custom",
        message: `invalid ${dimension} id component in quota resource key "${value}"`
      });
    }
  });

export type QuotaResourceKey = z.infer<typeof QuotaResourceKeySchema>;

/** The `global` dimension's single resource key. */
export const GLOBAL_RESOURCE_KEY = "global";

/** `project:<projectId>` */
export function projectResourceKey(projectId: string): string {
  return `project:${KEY_COMPONENT_SCHEMA.parse(projectId)}`;
}

/** `profile:<profileId>` */
export function profileResourceKey(profileId: string): string {
  return `profile:${KEY_COMPONENT_SCHEMA.parse(profileId)}`;
}

/** `credential:<groupId>` */
export function credentialResourceKey(credentialGroup: string): string {
  return `credential:${KEY_COMPONENT_SCHEMA.parse(credentialGroup)}`;
}

/**
 * Decompose a validated resource key into (dimension, component). `global`
 * has no component (`null`). Input is parsed first, so the returned dimension
 * is always one of the four and typed components are already schema-checked.
 */
export function decomposeResourceKey(
  key: string
): { readonly dimension: QuotaDimension; readonly component: string | null } {
  const value = QuotaResourceKeySchema.parse(key);
  if (value === GLOBAL_RESOURCE_KEY) {
    return { dimension: "global", component: null };
  }
  const separator = value.indexOf(":");
  return {
    dimension: QuotaDimensionSchema.parse(value.slice(0, separator)),
    component: value.slice(separator + 1)
  };
}
