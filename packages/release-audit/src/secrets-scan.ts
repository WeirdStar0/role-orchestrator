/**
 * Repo-wide secret scan (M6-03, A42 "发布包不含 auth、API key、原始用户
 * transcript" + A36 半边「落盘前脱敏」的自证).
 *
 * Semantics:
 * - Walks the repository EXCLUDING generated directories (node_modules,
 *   dist, .turbo, ...). Text files are scanned line by line against
 *   known secret VALUE shapes; binary files only get filename rules.
 * - Credential-shaped FILENAMES (`.env`, `id_rsa`, `credentials.json`,
 *   `.pem`, ...) are findings by themselves; `.npmrc` is content-checked
 *   for auth entries instead of being flagged for existing.
 * - Every hit is CLASSIFIED. Hits inside documented known reservations
 *   (desensitized real-stream fixtures, E2E evidence screenshots, fake-cli
 *   synthetic fixtures), inside test files (deliberate sanitization
 *   sentinels), or matching a literal documented fake sentinel are NOT
 *   release findings. Everything else is `needs-judgment` and flips the
 *   scan verdict to `findings`.
 * - Previews are always MASKED (first characters + length). The scanner
 *   never emits a full secret-shaped value, and this repository is not
 *   allowed to contain real ones — a `needs-judgment` hit must be judged
 *   by a human before any release, never auto-dismissed.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AuditTargetMissingError } from "./errors.js";

/** Documented fake credential literals used by sanitization tests. A real credential would not equal these. */
export const KNOWN_FAKE_SENTINELS: readonly string[] = [
  // packages/engine/test/persistence.test.ts:58 plants this fake Bearer value
  // to prove pre-persistence redaction; it is copied verbatim into A36 work
  // notes (.zcode workflow drafts), so a scan hit carrying exactly this
  // literal is the sentinel, not a secret.
  "livecred1234567890"
];

export type ReservationKind =
  | "desensitized-fixture"
  | "evidence-screenshot"
  | "synthetic-fixture";

export interface KnownReservation {
  /** Repo-relative forward-slash directory prefix. */
  readonly prefix: string;
  readonly kind: ReservationKind;
  readonly reason: string;
}

/**
 * Known reservations documented in reports/M0-03, M0-04 and M5 (browser E2E):
 * sanitized real CLI captures (`synthetic:false`, redactions listed in their
 * manifests), binary E2E evidence screenshots, and fake-cli synthetic
 * fixtures. Contents under these prefixes are pre-judged, but the scanner
 * still RECORDS every rule hit inside them.
 */
export const KNOWN_RESERVATIONS: readonly KnownReservation[] = [
  {
    prefix: "packages/cli-events/fixtures-real/",
    kind: "desensitized-fixture",
    reason:
      "sanitized real-stream captures; session ids/usernames/paths replaced per the documented redactions in each manifest.json"
  },
  {
    prefix: "packages/browser-e2e/evidence/",
    kind: "evidence-screenshot",
    reason: "binary E2E evidence screenshots (flow captures); not text-scannable, reserved as acceptance evidence"
  },
  {
    prefix: "packages/fake-cli/fixtures/",
    kind: "synthetic-fixture",
    reason: "fake-cli synthetic fixtures (synthetic:true); fake session ids by construction"
  }
];

export type FindingClassification =
  | ReservationKind
  | "test-sentinel"
  | "known-fake-sentinel"
  | "needs-judgment";

export type FindingKind = "value-pattern" | "credential-filename" | "env-content" | "npmrc-auth";

export interface SecretFinding {
  /** Repo-relative forward-slash path. */
  readonly file: string;
  /** 1-based line number; 0 for filename rules. */
  readonly line: number;
  readonly rule: string;
  readonly kind: FindingKind;
  readonly classification: FindingClassification;
  /** Masked preview — never the raw matched value. */
  readonly preview: string;
}

export interface SecretScanResult {
  readonly repoRoot: string;
  readonly scannedFiles: number;
  readonly textFiles: number;
  readonly binaryFiles: number;
  readonly oversizedSkipped: number;
  readonly excludedDirNames: readonly string[];
  /** Reservation-prefix files that were seen during the walk. */
  readonly reservationFiles: readonly string[];
  readonly findings: readonly SecretFinding[];
  readonly verdict: "clean" | "known-reservations-only" | "findings";
}

export const SecretScanOptionsSchema = z.strictObject({
  repoRoot: z.string().min(1),
  excludeDirNames: z
    .array(z.string().min(1))
    .default(["node_modules", "dist", ".turbo", ".git", "coverage", ".vitest", "__pycache__", ".plan-venv"]),
  maxFileBytes: z.number().int().positive().default(4 * 1024 * 1024)
});

export type SecretScanInput = z.input<typeof SecretScanOptionsSchema>;

/**
 * Secret VALUE shapes (A42). Sources are plain strings and compiled here so
 * the literal text in this file cannot self-match the value rules. Each rule
 * is high-confidence: it requires credential-shaped entropy, not just the
 * word "token".
 */
export const VALUE_PATTERN_RULES: readonly { name: string; source: string }[] = [
  { name: "anthropic-key", source: String.raw`sk-ant-[A-Za-z0-9_-]{8,}` },
  { name: "openai-style-key", source: String.raw`sk-(?:proj-)?[A-Za-z0-9]{20,}` },
  { name: "github-token", source: String.raw`gh[posur]_[A-Za-z0-9]{20,}` },
  { name: "github-fine-grained-token", source: String.raw`github_pat_[A-Za-z0-9_]{20,}` },
  { name: "aws-access-key-id", source: String.raw`\bAKIA[0-9A-Z]{16}\b` },
  { name: "slack-token", source: String.raw`\bxox[bpars]-[A-Za-z0-9-]{10,}\b` },
  { name: "google-api-key", source: String.raw`\bAIza[0-9A-Za-z_-]{35}\b` },
  { name: "npm-token", source: String.raw`\bnpm_[A-Za-z0-9]{30,}\b` },
  { name: "private-key-block", source: String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----` },
  { name: "jwt", source: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b` },
  { name: "bearer-credential", source: String.raw`\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}` }
];

/**
 * Assignment-shaped rules are only applied to CONFIG file extensions where a
 * literal secret value is meaningful; in TypeScript source they would fire on
 * schema definitions and sanitization tests by design.
 */
export const CONFIG_EXTENSIONS = new Set([".yaml", ".yml", ".json", ".jsonl", ".ini", ".toml", ".conf", ".sh", ".ps1", ".cmd", ".bat"]);
export const ASSIGNMENT_RULE: { name: string; source: string } = {
  name: "assignment-secret-value",
  source: String.raw`\b(?:api[_-]?key|apikey|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b["']?\s*[:=]\s*["'][^"'\n]{8,}["']`
};

const COMPILED_VALUE_RULES = VALUE_PATTERN_RULES.map((rule) => ({
  name: rule.name,
  regex: new RegExp(rule.source, "g")
}));
const COMPILED_ASSIGNMENT_RULE = { name: ASSIGNMENT_RULE.name, regex: new RegExp(ASSIGNMENT_RULE.source, "gi") };

/** Basenames (lower-cased) that are credential stores by convention. */
const CREDENTIAL_BASENAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
  ".netrc", ".git-credentials", ".pypirc",
  "credentials.json", ".credentials.json", "auth.json", ".claude.json", "auth.ini"
]);
const CREDENTIAL_SUFFIXES = [".pem", ".p12", ".pfx", ".jks", ".keystore"];

const ENV_BASENAME = /^\.env(\..+)?$/;
const ENV_EXEMPT_BASENAME = /^\.env\.(example|sample|template)$/;
const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const ENV_PLACEHOLDER = /^(?:(["'])\s*\1|\.{3,}|<?(?:your|replace|change)[-_]?[a-z0-9-]*>?|changeme|placeholder|xxx+)$/i;
const SECRET_KEY_SHAPE = /(password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)/i;
const NPMRC_AUTH = /_(?:authToken|password|auth)\s*=/;

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function maskMatch(raw: string): string {
  const head = raw.slice(0, 6);
  return `${head}\u2026[masked:len=${raw.length}]`;
}

function isBinaryFile(filePath: string): boolean {
  const fd = readFileSync(filePath);
  const probe = fd.subarray(0, 8192);
  return probe.includes(0);
}

function classify(file: string, matchedText: string): FindingClassification {
  const posix = toPosix(file);
  for (const reservation of KNOWN_RESERVATIONS) {
    if (posix.startsWith(reservation.prefix)) return reservation.kind;
  }
  for (const sentinel of KNOWN_FAKE_SENTINELS) {
    if (matchedText.includes(sentinel)) return "known-fake-sentinel";
  }
  const segments = posix.split("/");
  if (segments.includes("test") || /\.test\.[a-z]+$/.test(posix) || segments.includes("__tests__")) {
    return "test-sentinel";
  }
  return "needs-judgment";
}

function listFilesRecursive(root: string, excludeDirNames: ReadonlySet<string>): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    const absDir = relDir === "" ? root : path.join(root, relDir);
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (excludeDirNames.has(entry.name)) continue;
        stack.push(relDir === "" ? entry.name : `${relDir}/${entry.name}`);
        continue;
      }
      if (!entry.isFile()) continue;
      out.push({ rel: relDir === "" ? entry.name : `${relDir}/${entry.name}`, abs: path.join(absDir, entry.name) });
    }
  }
  return out;
}

/**
 * Run the repo-wide secret scan. Throws {@link AuditTargetMissingError} when
 * `repoRoot` does not exist. The result is a full account: counts, every
 * finding with its classification, and a verdict that is only `clean` /
 * `known-reservations-only` when nothing needs human judgment.
 */
export function scanSecrets(input: SecretScanInput): SecretScanResult {
  const options = SecretScanOptionsSchema.parse(input);
  let rootStat;
  try {
    rootStat = statSync(options.repoRoot);
  } catch (cause) {
    throw new AuditTargetMissingError([options.repoRoot], { cause });
  }
  if (!rootStat.isDirectory()) {
    throw new AuditTargetMissingError([options.repoRoot]);
  }
  const excludeDirNames = new Set(options.excludeDirNames);
  const files = listFilesRecursive(options.repoRoot, excludeDirNames).sort((a, b) => a.rel.localeCompare(b.rel));

  const findings: SecretFinding[] = [];
  const reservationFiles: string[] = [];
  let textFiles = 0;
  let binaryFiles = 0;
  let oversizedSkipped = 0;

  for (const file of files) {
    const posix = toPosix(file.rel);
    const basename = path.posix.basename(posix);
    const lower = basename.toLowerCase();
    const reservation = KNOWN_RESERVATIONS.find((r) => posix.startsWith(r.prefix));
    if (reservation !== undefined) reservationFiles.push(posix);

    // 1. Credential-shaped filenames. Public-key material (`*.pub`,
    // `*.pub.pem`) is not a secret and is not flagged.
    const isPublicMaterial = lower.endsWith(".pub") || lower.endsWith(".pub.pem");
    const suffix = CREDENTIAL_SUFFIXES.find((s) => lower.endsWith(s));
    if (!isPublicMaterial && (CREDENTIAL_BASENAMES.has(lower) || suffix !== undefined)) {
      findings.push({
        file: posix,
        line: 0,
        rule: `credential-filename:${lower}`,
        kind: "credential-filename",
        classification: classify(posix, basename),
        preview: basename
      });
    }

    // 2. .env files: presence is structural; content judged per line.
    if (ENV_BASENAME.test(lower) && !ENV_EXEMPT_BASENAME.test(lower)) {
      findings.push({
        file: posix,
        line: 0,
        rule: "env-file-present",
        kind: "env-content",
        classification: classify(posix, basename),
        preview: basename
      });
      let content = "";
      try {
        content = readFileSync(file.abs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const match = ENV_LINE.exec(lines[i] ?? "");
        if (match === null) continue;
        const key = match[1] ?? "";
        const rawValue = match[2] ?? "";
        const unquoted = rawValue.replace(/^["']|["']$/g, "");
        if (unquoted.length === 0 || ENV_PLACEHOLDER.test(unquoted)) continue;
        findings.push({
          file: posix,
          line: i + 1,
          rule: SECRET_KEY_SHAPE.test(key) ? "env-secret-shaped-value" : "env-value-present",
          kind: "env-content",
          classification: classify(posix, unquoted),
          preview: `${key}=${maskMatch(unquoted)}`
        });
      }
      textFiles += 1;
      continue;
    }

    // 3. .npmrc content check (auth entries), not presence.
    if (lower === ".npmrc" || lower === "npmrc") {
      let content = "";
      try {
        content = readFileSync(file.abs, "utf8");
      } catch {
        continue;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (NPMRC_AUTH.test(lines[i] ?? "")) {
          findings.push({
            file: posix,
            line: i + 1,
            rule: "npmrc-auth-entry",
            kind: "npmrc-auth",
            classification: classify(posix, lines[i] ?? ""),
            preview: maskMatch(lines[i] ?? "")
          });
        }
      }
      textFiles += 1;
      continue;
    }

    // 4. Content scan.
    let size: number;
    try {
      size = statSync(file.abs).size;
    } catch {
      continue;
    }
    if (size > options.maxFileBytes) {
      oversizedSkipped += 1;
      continue;
    }
    let binary: boolean;
    try {
      binary = isBinaryFile(file.abs);
    } catch {
      continue;
    }
    if (binary) {
      binaryFiles += 1;
      continue;
    }
    let content: string;
    try {
      content = readFileSync(file.abs, "utf8");
    } catch {
      continue;
    }
    textFiles += 1;
    const lines = content.split(/\r?\n/);
    const extension = path.posix.extname(posix).toLowerCase();
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const rule of COMPILED_VALUE_RULES) {
        rule.regex.lastIndex = 0;
        let match = rule.regex.exec(line);
        while (match !== null) {
          findings.push({
            file: posix,
            line: i + 1,
            rule: rule.name,
            kind: "value-pattern",
            classification: classify(posix, match[0]),
            preview: maskMatch(match[0])
          });
          match = rule.regex.exec(line);
        }
      }
      if (CONFIG_EXTENSIONS.has(extension)) {
        COMPILED_ASSIGNMENT_RULE.regex.lastIndex = 0;
        let match = COMPILED_ASSIGNMENT_RULE.regex.exec(line);
        while (match !== null) {
          findings.push({
            file: posix,
            line: i + 1,
            rule: COMPILED_ASSIGNMENT_RULE.name,
            kind: "value-pattern",
            classification: classify(posix, match[0]),
            preview: maskMatch(match[0])
          });
          match = COMPILED_ASSIGNMENT_RULE.regex.exec(line);
        }
      }
    }
  }

  const needsJudgment = findings.filter((f) => f.classification === "needs-judgment");
  const verdict: SecretScanResult["verdict"] =
    needsJudgment.length > 0 ? "findings" : findings.length > 0 ? "known-reservations-only" : "clean";

  return {
    repoRoot: options.repoRoot,
    scannedFiles: files.length,
    textFiles,
    binaryFiles,
    oversizedSkipped,
    excludedDirNames: options.excludeDirNames,
    reservationFiles,
    findings,
    verdict
  };
}
