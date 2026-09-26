/**
 * Provider capability declaration + compatibility matrix skeleton (M7-01).
 *
 * The capability declaration is what a future adapter CONFIGURES (which base
 * URL, which API flavor, which operations it implements, which token scopes it
 * needs). The compatibility matrix is what this package SHIPS as fact — and it
 * ships with every verification cell pinned to `status: z.literal("unverified")`:
 * the shipped schema CANNOT express "verified", so claiming a verified
 * GitHub/GitLab integration requires a deliberate schema change in review, not
 * a data edit. This is the same posture as the capability gate's
 * unknown-deny/A31 "do not claim unverified capabilities" discipline.
 *
 * Consequence pinned by tests: with the default (matrix) verification lookup,
 * neither a read client nor a write client can even be CONSTRUCTED — the
 * remote-SCM surface is fail-closed OFF. The verification lookup is an
 * injection seam: the future integration task flips cells WITH EVIDENCE via a
 * code change, and hermetic tests inject a verified lookup to exercise flows.
 */
import { z } from "zod";
import { withUniqueItems } from "@role-orchestrator/contracts";
import { ScmProviderNotVerifiedError } from "./errors.js";

export const SCM_PROVIDERS = ["github", "gitlab"] as const;
export const ScmProviderSchema = z.enum(SCM_PROVIDERS);
export type ScmProvider = (typeof SCM_PROVIDERS)[number];

/** Read-only operations (no approval required — 低风险只读分析). */
export const READ_OPERATIONS = ["listIssues", "listPullRequests", "listChecks", "listStatuses"] as const;
export const ScmReadOperationSchema = z.enum(READ_OPERATIONS);
export type ScmReadOperation = (typeof READ_OPERATIONS)[number];

/**
 * Controlled write operations (v1 design). Deliberately EXCLUDES merge/close/
 * delete: merging into a default branch needs a main-branch-delivery risk
 * dimension mapping and deletion needs a delete dimension — both are future
 * work with their own approval semantics, not silently expressible today
 * (the enum is closed; adding an operation is a schema change).
 */
export const WRITE_OPERATIONS = ["createIssueComment", "createPullRequest", "updatePullRequestText"] as const;
export const ScmWriteOperationSchema = z.enum(WRITE_OPERATIONS);
export type ScmWriteOperation = (typeof WRITE_OPERATIONS)[number];

export const ScmOperationSchema = z.enum([...READ_OPERATIONS, ...WRITE_OPERATIONS] as const);
export type ScmOperation = ScmReadOperation | ScmWriteOperation;

export const SCM_SURFACE_KINDS = ["read", "controlledWrite"] as const;
export const ScmSurfaceKindSchema = z.enum(SCM_SURFACE_KINDS);
export type ScmSurfaceKind = (typeof SCM_SURFACE_KINDS)[number];

export const SCM_API_FLAVORS = ["github-rest-v3", "github-graphql-v4", "gitlab-rest-v4"] as const;
export const ScmApiFlavorSchema = z.enum(SCM_API_FLAVORS);
export type ScmApiFlavor = (typeof SCM_API_FLAVORS)[number];

/**
 * Base URL: https only, no userinfo, no path/query/fragment, host of DNS
 * labels. This blocks the obvious SSRF-style injections (http downgrade,
 * `https://user:pass@host`, `https://host/../../..`, query-smuggled
 * credentials). Host ALLOWLISTING (exact-match, no suffix tricks) is enforced
 * by `assertBaseUrlAllowed` at adapter wiring time; DNS-rebinding remains a
 * residual risk owned by the real adapter (see the M7-01 design document).
 */
export const ScmBaseUrlSchema = z
  .string()
  .min(11)
  .max(512)
  .regex(/^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]{0,251}[A-Za-z0-9](?::\d{1,5})?$/, {
    message:
      "base URL must be https://<dns-host>[:port] with no userinfo, path, query or fragment (SSRF guard)"
  });

/** Exact-host allowlist check (no subdomain suffix tricks — hosts must match exactly). */
export function assertBaseUrlAllowed(baseUrl: string, allowedHosts: readonly string[]): void {
  const match = /^https:\/\/([^/:?#@]+)(?::\d{1,5})?$/.exec(baseUrl);
  if (match === null || match[1] === undefined) {
    throw new ScmProviderNotVerifiedError({
      provider: baseUrl,
      surface: "base-url",
      status: "invalid-base-url"
    });
  }
  const host = match[1].toLowerCase();
  if (!allowedHosts.some((allowed) => allowed.toLowerCase() === host)) {
    throw new ScmProviderNotVerifiedError({
      provider: host,
      surface: "base-url",
      status: "host-not-allowlisted"
    });
  }
}

/** A proposed token scope label (verification status lives on the matrix cell, not here). */
export const ScmTokenScopeSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/);

function scopes(min: number) {
  return withUniqueItems(z.array(ScmTokenScopeSchema).min(min).max(16));
}

// ---------------------------------------------------------------------------
// Compatibility matrix skeleton — shipped facts, all unverified
// ---------------------------------------------------------------------------

/**
 * The verification status of one shipped matrix cell. `z.literal("unverified")`
 * is deliberate: the SHIPPED matrix cannot claim verification. The broader
 * `"verified" | "unverified"` union exists only on the injected lookup type
 * ({@link ScmSurfaceVerification}), which is the seam a future, evidence-backed
 * integration task uses.
 */
export const ScmShippedVerificationSchema = z.strictObject({
  status: z.literal("unverified"),
  evidence: z.null()
});

export const ScmCompatCellSchema = z.strictObject({
  provider: ScmProviderSchema,
  apiFlavor: ScmApiFlavorSchema,
  /** How the adapter authenticates (GitHub PAT: "token <pat>"; GitLab: PRIVATE-TOKEN header). */
  authHeaderForm: z.enum(["bearer", "token", "private-token"]),
  /**
   * PROPOSED minimal scopes. These are best-effort from public provider docs
   * and explicitly UNVERIFIED: the real integration task must re-derive them
   * against the live provider before any cell is flipped. Scope sets are
   * pinned exactly by tests so they cannot silently grow.
   */
  proposedMinimalScopes: z.strictObject({ read: scopes(1), write: scopes(1) }),
  verification: ScmShippedVerificationSchema
});

export type ScmCompatCell = z.output<typeof ScmCompatCellSchema>;

function matrixCell(cell: ScmCompatCell): ScmCompatCell {
  return Object.freeze(ScmCompatCellSchema.parse(cell));
}

export const SCM_PROVIDER_COMPAT_MATRIX: Readonly<Record<ScmProvider, ScmCompatCell>> = Object.freeze({
  github: matrixCell({
    provider: "github",
    apiFlavor: "github-rest-v3",
    authHeaderForm: "token",
    proposedMinimalScopes: {
      read: ["metadata:read", "contents:read", "issues:read", "pull-requests:read"],
      write: ["metadata:read", "contents:read", "issues:write", "pull-requests:write"]
    },
    verification: { status: "unverified", evidence: null }
  }),
  gitlab: matrixCell({
    provider: "gitlab",
    apiFlavor: "gitlab-rest-v4",
    authHeaderForm: "private-token",
    proposedMinimalScopes: {
      read: ["read_api"],
      write: ["api"]
    },
    verification: { status: "unverified", evidence: null }
  })
});

// ---------------------------------------------------------------------------
// Verification lookup — the injection seam
// ---------------------------------------------------------------------------

export interface ScmSurfaceVerification {
  readonly status: "verified" | "unverified";
  readonly evidence: string | null;
}

/**
 * Answers "may this provider surface be used?". The default implementation
 * reads the shipped matrix (always unverified). Hosts and tests may inject a
 * lookup returning `verified` — doing so in production code is a governance
 * decision that must be backed by evidence recorded next to the injection.
 */
export type ScmVerificationLookup = (input: {
  readonly provider: ScmProvider;
  readonly surface: ScmSurfaceKind;
}) => ScmSurfaceVerification;

export function matrixVerificationLookup(input: {
  readonly provider: ScmProvider;
  readonly surface: ScmSurfaceKind;
}): ScmSurfaceVerification {
  const cell = SCM_PROVIDER_COMPAT_MATRIX[input.provider];
  return { status: cell.verification.status, evidence: cell.verification.evidence };
}

/** The single choke point every client constructor and method funnels through. */
export function assertSurfaceVerified(
  lookup: ScmVerificationLookup,
  provider: ScmProvider,
  surface: ScmSurfaceKind
): void {
  const status = lookup({ provider, surface });
  if (status.status !== "verified") {
    throw new ScmProviderNotVerifiedError({
      provider,
      surface,
      status: status.status
    });
  }
}

// ---------------------------------------------------------------------------
// Capability declaration — what an adapter configures
// ---------------------------------------------------------------------------

export const ScmProviderCapabilitySchema = z
  .strictObject({
    provider: ScmProviderSchema,
    baseUrl: ScmBaseUrlSchema,
    apiFlavor: ScmApiFlavorSchema,
    /** Read operations this adapter implements (must match the transport). */
    reads: withUniqueItems(z.array(ScmReadOperationSchema).max(READ_OPERATIONS.length)),
    /** Controlled write operations this adapter implements. */
    writes: withUniqueItems(z.array(ScmWriteOperationSchema).max(WRITE_OPERATIONS.length)),
    /** Scopes the configured credential is expected to carry (minimization input). */
    tokenScopes: z.strictObject({ read: scopes(1), write: scopes(1) })
  })
  .check((ctx) => {
    const expected: readonly ScmApiFlavor[] =
      ctx.value.provider === "github" ? ["github-rest-v3", "github-graphql-v4"] : ["gitlab-rest-v4"];
    if (!expected.includes(ctx.value.apiFlavor)) {
      ctx.issues.push({
        code: "custom",
        message: `apiFlavor "${ctx.value.apiFlavor}" does not belong to provider "${ctx.value.provider}"`,
        input: ctx.value.apiFlavor,
        path: ["apiFlavor"]
      });
    }
  });

export type ScmProviderCapability = z.output<typeof ScmProviderCapabilitySchema>;
