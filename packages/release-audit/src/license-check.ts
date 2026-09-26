/**
 * LICENSE candidate verification (M6-03).
 *
 * The repository has NO formal LICENSE file. `LICENSE.proposed.txt` is a
 * CANDIDATE; per `project/LICENSING.md` and `docs/BACKLOG.md` M6-03/M6-05 the
 * formalization (placing the file, filling copyright/NOTICE fields) is a
 * MAINTAINER decision. This module verifies the candidate's TEXT against the
 * canonical Apache-2.0 wording and reports the formalization status
 * honestly: it can never return "formalized" while `LICENSE` is absent, and
 * it never creates that file.
 *
 * Canonical text: the verbatim Apache License 2.0 as published at
 * http://www.apache.org/licenses/LICENSE-2.0.txt, checked into this package
 * as `fixtures/apache-2.0-canonical.txt`
 * (sha256 cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AuditTargetMissingError } from "./errors.js";

export const CANONICAL_APACHE_2_0_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

export const LicenseCheckOptionsSchema = z.strictObject({
  repoRoot: z.string().min(1),
  candidateFileName: z.string().min(1).default("LICENSE.proposed.txt"),
  formalLicenseFileName: z.string().min(1).default("LICENSE")
});

export type LicenseCheckInput = z.input<typeof LicenseCheckOptionsSchema>;

export interface LicenseCandidateCheck {
  readonly candidatePath: string;
  readonly candidateExists: boolean;
  readonly candidateSha256: string | null;
  readonly canonicalSha256: string;
  readonly canonicalFixtureSha256: string;
  /** Byte-for-byte equality (layout included). */
  readonly byteIdentical: boolean;
  /** Equality after whitespace normalization: wording-level identity. */
  readonly wordingIdentical: boolean;
  /** First normalized line pairs that diverge (only when wording differs). */
  readonly firstDivergences: readonly string[];
  readonly status: "candidate-matches-canonical" | "candidate-diverges" | "candidate-missing";
  /** License formalization is a maintainer decision, never an audit outcome. */
  readonly formalization: "pending-maintainer-confirmation" | "formalized";
  readonly formalLicensePath: string;
  readonly formalLicenseExists: boolean;
}

/** Path of the canonical-text fixture shipped with this package. */
export function canonicalApacheFixturePath(): string {
  // Both layouts resolve to packages/release-audit/fixtures/:
  // - src/license-check.ts   -> ../fixtures
  // - dist/license-check.js  -> ../fixtures (tsc keeps the flat dist layout)
  return fileURLToPath(new URL("../fixtures/apache-2.0-canonical.txt", import.meta.url));
}

export function sha256Of(filePath: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Whitespace-insensitive wording normalization: collapse every whitespace
 * run to a single space, trim each line, drop empty lines. Two texts with
 * identical WORDING but different indentation/reflow compare equal.
 */
export function normalizeWording(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function checkLicenseCandidate(input: LicenseCheckInput): LicenseCandidateCheck {
  const options = LicenseCheckOptionsSchema.parse(input);
  if (!existsSync(options.repoRoot)) throw new AuditTargetMissingError([options.repoRoot]);
  const candidatePath = path.join(options.repoRoot, options.candidateFileName);
  const formalLicensePath = path.join(options.repoRoot, options.formalLicenseFileName);
  const fixturePath = canonicalApacheFixturePath();
  const canonicalSha256 = sha256Of(fixturePath);
  if (canonicalSha256 === null) {
    throw new AuditTargetMissingError([fixturePath], { cause: "canonical Apache-2.0 fixture unreadable" });
  }

  const candidateExists = existsSync(candidatePath);
  const candidateSha256 = candidateExists ? sha256Of(candidatePath) : null;
  const formalLicenseExists = existsSync(formalLicensePath);

  let byteIdentical = false;
  let wordingIdentical = false;
  let firstDivergences: string[] = [];
  if (candidateExists && candidateSha256 !== null) {
    const canonicalText = readFileSync(fixturePath, "utf8");
    const candidateText = readFileSync(candidatePath, "utf8");
    byteIdentical = candidateSha256 === canonicalSha256;
    const canonicalNorm = normalizeWording(canonicalText).split("\n");
    const candidateNorm = normalizeWording(candidateText).split("\n");
    wordingIdentical = canonicalNorm.join("\n") === candidateNorm.join("\n");
    if (!wordingIdentical) {
      const max = Math.max(canonicalNorm.length, candidateNorm.length);
      for (let i = 0; i < max && firstDivergences.length < 5; i += 1) {
        const a = canonicalNorm[i];
        const b = candidateNorm[i];
        if (a !== b) {
          firstDivergences.push(`line ${i + 1}: canonical=${JSON.stringify(a ?? null)} candidate=${JSON.stringify(b ?? null)}`);
        }
      }
    }
  }

  const status: LicenseCandidateCheck["status"] =
    !candidateExists ? "candidate-missing" : wordingIdentical ? "candidate-matches-canonical" : "candidate-diverges";

  return {
    candidatePath,
    candidateExists,
    candidateSha256,
    canonicalSha256,
    canonicalFixtureSha256: canonicalSha256,
    byteIdentical,
    wordingIdentical,
    firstDivergences,
    status,
    formalization: formalLicenseExists ? "formalized" : "pending-maintainer-confirmation",
    formalLicensePath,
    formalLicenseExists
  };
}
