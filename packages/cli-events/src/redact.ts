/**
 * Secret redaction before text or events are persisted or emitted (A36,
 * "落盘前脱敏"): known secret shapes — `Bearer <token>`, `token=<value>`,
 * `api-key=<value>` and friends — are replaced with a fixed placeholder
 * before the text reaches a response body, a log line or any other sink.
 *
 * Design points:
 * - The pattern list is configurable; `DEFAULT_REDACTION_PATTERNS` is the
 *   shipped baseline. Callers may extend it, but every list is applied
 *   fail-closed: text is scanned by ALL patterns, and the placeholder
 *   itself never matches any pattern again, so redaction is idempotent.
 * - An OPTIONAL additional pass flags long high-entropy token candidates
 *   (`highEntropy: true`). It is off by default because entropy scoring is
 *   a heuristic and can false-positive on legitimate hashes; known-shape
 *   patterns above carry the default guarantee.
 * - `redactJsonValue` walks JSON payloads and redacts every string, so a
 *   secret smuggled inside an event payload field is replaced before the
 *   payload is served or persisted.
 */
import type { JsonValue } from "@role-orchestrator/contracts";

/** Fixed, secret-free placeholder substituted for redacted values. */
export const SECRET_PLACEHOLDER = "[REDACTED]";

/** One configured redaction rule. `regex` MUST have the `g` flag semantics; it is cloned per run. */
export interface RedactionPattern {
  /** Stable rule name, reported by `redactText` for auditability. */
  readonly name: string;
  /** Source regex; the value is cloned with the `g` flag for each application. */
  readonly regex: RegExp;
  /** Replacement expression (may use `$1`-style group references). */
  readonly replacement: string;
}

/**
 * Shipped baseline patterns (A36). The value character classes exclude
 * whitespace, quotes, brackets and braces, and therefore never re-match the
 * placeholder itself — applying redaction twice returns the same text.
 */
export const DEFAULT_REDACTION_PATTERNS: readonly RedactionPattern[] = [
  {
    // `Authorization: Bearer eyJ...`, `bearer abc123...`, `Basic ...`.
    name: "bearer-scheme",
    regex: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi,
    replacement: `$1 ${SECRET_PLACEHOLDER}`
  },
  {
    // `token=…`, `api-key: …`, `X-Api-Key "…"`, `access_token=…`, `password: "…"`
    // (group 2 keeps the original separator and a leading quote, so the
    // output keeps its shape; a trailing quote stays and reads naturally).
    // The key name must be secret-shaped; ordinary `mode=production` pairs
    // never match. Values need >= 8 secret-charset characters, so the
    // placeholder itself never re-matches (idempotent).
    name: "key-value-secret",
    regex:
      /\b(token|api[-_]?key|apikey|access[-_]?token|refresh[-_]?token|secret|password|passwd|authorization)\s*((?:[=:])\s*["']?)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: `$1$2${SECRET_PLACEHOLDER}`
  }
];

export interface RedactionOptions {
  /** Pattern list; defaults to `DEFAULT_REDACTION_PATTERNS`. */
  readonly patterns?: readonly RedactionPattern[];
  /** Enable the optional long high-entropy token pass. Default: false. */
  readonly highEntropy?: boolean;
}

export interface RedactionResult {
  /** Redacted text. */
  readonly text: string;
  /** Total number of substitutions applied, by rule name. */
  readonly redactions: Readonly<Record<string, number>>;
}

/** Minimum Shannon entropy (bits/char) for the optional high-entropy pass. */
const HIGH_ENTROPY_THRESHOLD = 4.2;

/**
 * Shannon entropy in bits per character over the exact string. Deterministic
 * helper so the optional pass is testable without randomness:
 * `entropyBitsPerChar("aaaa") === 0`, a perfectly uniform two-symbol string
 * yields 1.0, and random base64url tokens land far above the threshold.
 */
export function entropyBitsPerChar(text: string): number {
  if (text.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const char of text) {
    counts.set(char, (counts.get(char) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function hasMixedCharacterClasses(text: string): boolean {
  return (
    (/[a-z]/.test(text) ? 1 : 0) + (/[A-Z]/.test(text) ? 1 : 0) + (/[0-9]/.test(text) ? 1 : 0) >= 2
  );
}

function applyHighEntropyPass(text: string): { text: string; count: number } {
  // Long unseparated token-shaped runs: 40+ chars of [A-Za-z0-9_-]. The
  // placeholder contains brackets, so it can never be re-matched here.
  const candidateRegex = /[A-Za-z0-9_-]{40,}/g;
  let count = 0;
  const result = text.replace(candidateRegex, (candidate: string): string => {
    if (candidate.includes(SECRET_PLACEHOLDER)) return candidate;
    const entropy = entropyBitsPerChar(candidate);
    if (entropy >= HIGH_ENTROPY_THRESHOLD && hasMixedCharacterClasses(candidate)) {
      count += 1;
      return SECRET_PLACEHOLDER;
    }
    return candidate;
  });
  return { text: result, count };
}

/** Redact known secret shapes from one piece of text (A36, pre-sink). */
export function redactText(text: string, options: RedactionOptions = {}): RedactionResult {
  const patterns = options.patterns ?? DEFAULT_REDACTION_PATTERNS;
  const redactions: Record<string, number> = {};
  let current = text;
  for (const pattern of patterns) {
    const flags = pattern.regex.flags.includes("g")
      ? pattern.regex.flags
      : `${pattern.regex.flags}g`;
    const runner = new RegExp(pattern.regex.source, flags);
    const matches = current.match(runner);
    const count = matches === null ? 0 : matches.length;
    if (count > 0) {
      // Native `$1`-style replacement semantics; `g`-cloned regex, no state.
      current = current.replace(new RegExp(pattern.regex.source, flags), pattern.replacement);
      redactions[pattern.name] = count;
    }
  }
  if (options.highEntropy === true) {
    const pass = applyHighEntropyPass(current);
    current = pass.text;
    if (pass.count > 0) {
      redactions["high-entropy-token"] = pass.count;
    }
  }
  return { text: current, redactions };
}

/**
 * Deep-redact every string inside a JSON payload (A36: events carry free-form
 * payload text; a secret inside any field is replaced before the payload is
 * served or persisted). Numbers, booleans and null pass through untouched.
 */
export function redactJsonValue(
  value: JsonValue,
  options: RedactionOptions = {}
): { value: JsonValue; redactedCount: number } {
  if (typeof value === "string") {
    const result = redactText(value, options);
    return { value: result.text, redactedCount: countTotal(result.redactions) };
  }
  if (Array.isArray(value)) {
    let total = 0;
    const items: JsonValue[] = value.map((item) => {
      const result = redactJsonValue(item, options);
      total += result.redactedCount;
      return result.value;
    });
    return { value: items, redactedCount: total };
  }
  if (value !== null && typeof value === "object") {
    let total = 0;
    const entries: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      // A key name is metadata, not free text; its VALUE is what gets redacted.
      const result = redactJsonValue(item, options);
      total += result.redactedCount;
      entries[key] = result.value;
    }
    return { value: entries, redactedCount: total };
  }
  return { value, redactedCount: 0 };
}

function countTotal(redactions: Readonly<Record<string, number>>): number {
  return Object.values(redactions).reduce((sum, count) => sum + count, 0);
}
