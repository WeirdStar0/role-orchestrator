/**
 * Credential references and the credential handle (M7-01, A42).
 *
 * Ground rule (docs/SECURITY_MODEL.md; ACCEPTANCE A42: no auth/API keys in
 * events or deliverables): plaintext credential material NEVER exists inside
 * this package's data model. There are exactly two credential-shaped values:
 *
 * - `ScmCredentialRef` — a REFERENCE to where the host stores the secret
 *   (environment variable / OS keyring entry / protected file). Its fields are
 *   structural identifiers, and a fail-closed check rejects any value whose
 *   text matches a known token shape, so `{"source": "env", "envVar":
 *   "ghp_..."}`-style smuggling fails validation instead of silently becoming
 *   a "reference".
 * - `ResolvedCredentialHandle` — the OPAQUE, SECRET-FREE handle the host
 *   creates after resolving a ref out-of-band. It carries only the provider
 *   and a non-secret label; the real token lives in host memory/storage and is
 *   attached to the wire by the adapter BEYOND this package's seam (the
 *   transport implementations). Nothing in this package can produce or print
 *   the material.
 *
 * Free-text fields elsewhere (bodies, titles) do NOT reject token-shaped
 * content — a user comment may legitimately contain anything — but every
 * audit/event sink scrubs it (./events.js).
 */
import { z } from "zod";
import { ScmProviderSchema, type ScmProvider } from "./capability.js";
import { UNSAFE_TEXT_PATTERN } from "./input.js";
import { ScmCredentialShapeError } from "./errors.js";

/** The fixed placeholder substituted wherever credential-shaped text is scrubbed. */
export const SCM_CREDENTIAL_PLACEHOLDER = "[REDACTED]";

/** One known credential shape. Regexes are cloned with the `g` flag per scan. */
export interface ScmCredentialShapeRule {
  readonly name: string;
  readonly regex: RegExp;
}

/**
 * Known token shapes (A42). Provider PATs first, then generic header/key-value
 * forms and cross-product sentinels (the same families the release secret
 * scanner classifies). Value character classes exclude whitespace/brackets so
 * the placeholder itself never re-matches (scrubbing is idempotent).
 */
export const SCM_CREDENTIAL_SHAPE_RULES: readonly ScmCredentialShapeRule[] = [
  { name: "github-classic-pat", regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { name: "github-fine-grained-pat", regex: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g },
  { name: "gitlab-pat", regex: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { name: "anthropic-key", regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  { name: "openai-style-key", regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { name: "slack-token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "aws-access-key", regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: "bearer-header",
    regex: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi
  },
  {
    name: "key-value-secret",
    regex:
      /\b(token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|secret|password|passwd|authorization|private[-_]?key)\s*((?:[=:])\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi
  }
];

/** Names of every known credential shape contained in `text` (deduplicated). */
export function findCredentialMaterial(text: string): readonly string[] {
  const found = new Set<string>();
  for (const rule of SCM_CREDENTIAL_SHAPE_RULES) {
    const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
    if (new RegExp(rule.regex.source, flags).test(text)) {
      found.add(rule.name);
    }
  }
  return [...found].sort();
}

export function containsCredentialMaterial(text: string): boolean {
  return findCredentialMaterial(text).length > 0;
}

/**
 * Replace every credential-shaped substring with the fixed placeholder.
 * Deterministic and idempotent: scrubbing twice equals scrubbing once.
 */
export function scrubCredentialText(text: string): { readonly text: string; readonly rules: readonly string[] } {
  let current = text;
  const applied = new Set<string>();
  for (const rule of SCM_CREDENTIAL_SHAPE_RULES) {
    const flags = rule.regex.flags.includes("g") ? rule.regex.flags : `${rule.regex.flags}g`;
    const runner = new RegExp(rule.regex.source, flags);
    if (runner.test(current)) {
      applied.add(rule.name);
      current = current.replace(new RegExp(rule.regex.source, flags), SCM_CREDENTIAL_PLACEHOLDER);
    }
  }
  return { text: current, rules: [...applied].sort() };
}

// ---------------------------------------------------------------------------
// ScmCredentialRef — reference-only credential description
// ---------------------------------------------------------------------------

const KEYRING_LABEL_PATTERN = /^[A-Za-z0-9._:@/-]{1,128}$/;

const ScmEnvCredentialRefSchema = z.strictObject({
  source: z.literal("env"),
  /** Environment VARIABLE NAME — not the value. */
  envVar: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, {
    message: "env var name must match [A-Z][A-Z0-9_]{0,63}; a value is never accepted here"
  })
});

const ScmKeyringCredentialRefSchema = z.strictObject({
  source: z.literal("keyring"),
  service: z.string().regex(KEYRING_LABEL_PATTERN, {
    message: "keyring service must contain only [A-Za-z0-9._:@/-] (max 128)"
  }),
  account: z.string().regex(KEYRING_LABEL_PATTERN, {
    message: "keyring account must contain only [A-Za-z0-9._:@/-] (max 128)"
  })
});

const ScmFileCredentialRefSchema = z.strictObject({
  source: z.literal("file"),
  /** Path of the protected secret file; the adapter must read it out-of-band. */
  path: z
    .string()
    .min(1)
    .max(2048)
    .check((ctx) => {
      if (UNSAFE_TEXT_PATTERN.test(ctx.value)) {
        ctx.issues.push({
          code: "custom",
          message: "credential file path must not contain control or bidi override characters",
          input: ctx.value
        });
      }
    })
});

export const ScmCredentialRefSchema = z
  .discriminatedUnion("source", [
    ScmEnvCredentialRefSchema,
    ScmKeyringCredentialRefSchema,
    ScmFileCredentialRefSchema
  ])
  .check((ctx) => {
    for (const [field, value] of Object.entries(ctx.value)) {
      if (typeof value === "string" && containsCredentialMaterial(value)) {
        ctx.issues.push({
          code: "custom",
          message:
            `credentialRef field "${field}" contains plaintext credential material (A42): ` +
            "reference the secret (env var name / keyring entry / file path), never inline it",
          input: field
        });
      }
    }
  });

export type ScmCredentialRef = z.output<typeof ScmCredentialRefSchema>;

// ---------------------------------------------------------------------------
// ResolvedCredentialHandle — opaque, secret-free
// ---------------------------------------------------------------------------

/**
 * The handle passed to transports. It deliberately carries NO material: the
 * production adapter resolves the secret host-side, keyed by (provider,
 * label), AFTER this package's guards have passed. Constructing one is
 * harmless — possession of a handle grants nothing without the host-side
 * resolver and a passed approval/digest chain.
 */
export interface ResolvedCredentialHandle {
  readonly provider: ScmProvider;
  /** Non-secret audit label, e.g. "env:GITHUB_TOKEN" (never the value). */
  readonly label: string;
}

export function createResolvedCredentialHandle(input: {
  readonly provider: ScmProvider;
  readonly label: string;
}): ResolvedCredentialHandle {
  const provider = ScmProviderSchema.parse(input.provider);
  if (!KEYRING_LABEL_PATTERN.test(input.label)) {
    throw new ScmCredentialShapeError({
      detail:
        "credential handle label must contain only [A-Za-z0-9._:@/-] (max 128) — it is an audit label, not a value"
    });
  }
  const matchedRules = findCredentialMaterial(input.label);
  if (matchedRules.length > 0) {
    throw new ScmCredentialShapeError({
      detail:
        "credential handle label contains plaintext credential material (A42); pass the reference label only",
      matchedRules
    });
  }
  return Object.freeze({ provider, label: input.label });
}

/** Runtime check used before every transport call. */
export function assertResolvedCredentialHandle(
  value: unknown,
  provider: ScmProvider
): asserts value is ResolvedCredentialHandle {
  if (typeof value !== "object" || value === null) {
    throw new ScmCredentialShapeError({ detail: "credential handle must be an object" });
  }
  const candidate = value as Partial<ResolvedCredentialHandle>;
  if (
    typeof candidate.provider !== "string" ||
    typeof candidate.label !== "string" ||
    ScmProviderSchema.safeParse(candidate.provider).success === false
  ) {
    throw new ScmCredentialShapeError({
      detail: "credential handle must carry a valid provider and a string label"
    });
  }
  if (candidate.provider !== provider) {
    throw new ScmCredentialShapeError({
      detail: `credential handle is for provider "${candidate.provider}", not "${provider}"`
    });
  }
}
