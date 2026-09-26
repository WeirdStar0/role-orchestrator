/**
 * Secret minimal exposure (A42 discipline for the remote data path).
 *
 * The protocol carries secret REFERENCES only (`ref:<name>` into the remote
 * platform's secret store, resolved by the remote runtime at launch). Secret
 * VALUES are structurally inexpressible: every free-text field of every
 * protocol message goes through `secretFreeText`, which rejects (never
 * sanitizes) known token shapes. Structural defense first (closed schemas
 * have no field that could carry a credential), shape rejection second
 * (defense in depth against values smuggled through note/ref-like strings).
 */
import { z } from "zod";
import { SecretMaterialRejectedError } from "./errors.js";

/**
 * A secret reference: `ref:` + a lowercase name. Deliberately NARROWER than
 * a path or an env assignment — it names a slot in the REMOTE platform's
 * secret store; the orchestrator never learns or sends the value.
 */
export const SecretRefSchema = z
  .string()
  .regex(/^ref:[a-z][a-z0-9._-]{2,120}$/, {
    message: "secretRef must be `ref:` + a lowercase name (a remote secret-store slot), never a value"
  });
export type SecretRef = z.output<typeof SecretRefSchema>;

/**
 * Known credential SHAPES (the same families the release audit scans for,
 * minus repo-specific sentinels). A string matching any of these is rejected
 * where a reference is required — fail closed, no redaction theater.
 */
export const SECRET_SHAPE_RULES: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  { rule: "anthropic-key", pattern: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { rule: "openai-style-key", pattern: /sk-[A-Za-z0-9]{16,}/ },
  { rule: "github-pat", pattern: /ghp_[A-Za-z0-9]{20,}/ },
  { rule: "github-fine-grained-pat", pattern: /github_pat_[A-Za-z0-9_]{20,}/ },
  { rule: "gitlab-pat", pattern: /glpat-[A-Za-z0-9_-]{16,}/ },
  { rule: "aws-access-key", pattern: /AKIA[0-9A-Z]{16}/ },
  { rule: "slack-token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
  { rule: "private-key-block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { rule: "bearer-credential", pattern: /Bearer\s+[A-Za-z0-9._-]{16,}/i },
  {
    rule: "credential-assignment",
    // `password=`/`token:`-style assignments; the leading non-word guard keeps
    // ordinary camelCase field names (fencingToken:, secretRefs:) out.
    pattern: /(?:^|[^\w])(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*[^\s"']{6,}/i
  }
];

/** True when the text carries a known credential shape. */
export function matchesSecretShape(text: string): string | null {
  for (const { rule, pattern } of SECRET_SHAPE_RULES) {
    if (pattern.test(text)) return rule;
  }
  return null;
}

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const BIDI_OVERRIDES = /[\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/;

/**
 * Free text inside protocol messages: bounded, printable, no control
 * characters, no Trojan-Source bidi overrides, no credential shapes.
 */
export function secretFreeText(max: number) {
  return z
    .string()
    .min(1)
    .max(max)
    .check((ctx) => {
      if (CONTROL_CHARS.test(ctx.value)) {
        ctx.issues.push({ code: "custom", message: "protocol text must not contain control characters", input: ctx.value });
        return;
      }
      if (BIDI_OVERRIDES.test(ctx.value)) {
        ctx.issues.push({ code: "custom", message: "protocol text must not contain bidi/zero-width overrides", input: ctx.value });
        return;
      }
      const rule = matchesSecretShape(ctx.value);
      if (rule !== null) {
        ctx.issues.push({
          code: "custom",
          message: `protocol text must not contain credential-shaped material (matched rule "${rule}")`,
          input: ctx.value
        });
      }
    });
}

/**
 * Guard used by builders that compose messages by hand (not through Zod):
 * throws the typed error instead of letting shaped material pass.
 */
export function assertNoSecretMaterial(field: string, value: string): void {
  const rule = matchesSecretShape(value);
  if (rule !== null) {
    throw new SecretMaterialRejectedError(field, rule);
  }
}
