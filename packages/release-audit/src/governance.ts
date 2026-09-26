/**
 * Governance inventory (M6-03): Codeowners, private security reporting
 * channel, LICENSE formalization and release approval.
 *
 * M6 DISCIPLINE: these are MAINTAINER-ONLY decisions (docs/BACKLOG.md M6-03
 * completion standard, MAINTAINERS.md). This module can only report their
 * CURRENT STATE from repository evidence. It has no code path that marks a
 * maintainer item "confirmed", and its statuses are designed so that a
 * missing file/configuration can only ever produce a pending/not-configured
 * verdict.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AuditTargetMissingError } from "./errors.js";

export const GovernanceOptionsSchema = z.strictObject({
  repoRoot: z.string().min(1),
  codeownersPath: z.string().min(1).default(path.join(".github", "CODEOWNERS")),
  securityDocPath: z.string().min(1).default("SECURITY.md"),
  maintainersDocPath: z.string().min(1).default("MAINTAINERS.md")
});

export type GovernanceInput = z.input<typeof GovernanceOptionsSchema>;

export interface CodeownersInventory {
  readonly path: string;
  readonly exists: boolean;
  /** Non-comment, non-empty lines: rules GitHub would actually enforce. */
  readonly activeRules: readonly string[];
  /** Comment lines describing the template state. */
  readonly placeholderLines: number;
  /** The file still carries the "replace me" template marker text. */
  readonly templateMarkerPresent: boolean;
  readonly status: "placeholder-only" | "rules-present" | "missing";
}

export interface PrivateChannelInventory {
  readonly documentedIn: string;
  readonly exists: boolean;
  /** The doc itself states the channel is not set up yet. */
  readonly statesChannelNotConfigured: boolean;
  /** Any concrete contact point (mailto:, bare email) found in the doc. */
  readonly contactPointsFound: readonly string[];
  readonly status: "not-configured-documented" | "contact-points-present" | "missing";
}

export interface GovernanceInventory {
  readonly codeowners: CodeownersInventory;
  readonly privateChannel: PrivateChannelInventory;
  readonly licenseDecision: {
    readonly formalLicensePath: string;
    readonly exists: boolean;
    readonly status: "pending-maintainer-confirmation" | "formalized";
  };
  readonly releaseApproval: {
    /** Structural fact: no release-approval record exists in the repo. */
    readonly status: "pending-maintainer";
    readonly note: string;
  };
  readonly maintainerIdentityRecorded: boolean;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const CODEOWNERS_MARKER = /Replace with verified GitHub handles/i;
const CHANNEL_NOT_CONFIGURED_MARKER = /private vulnerability reporting/i;
const CHANNEL_PENDING_MARKER = /当前文档不虚构邮箱|渠道未配置前不要公开发布/;

export function inventoryGovernance(input: GovernanceInput): GovernanceInventory {
  const options = GovernanceOptionsSchema.parse(input);
  if (!existsSync(options.repoRoot)) throw new AuditTargetMissingError([options.repoRoot]);

  // Codeowners.
  const codeownersAbs = path.join(options.repoRoot, options.codeownersPath);
  const codeownersExists = existsSync(codeownersAbs);
  const activeRules: string[] = [];
  let placeholderLines = 0;
  let templateMarkerPresent = false;
  if (codeownersExists) {
    const text = readFileSync(codeownersAbs, "utf8");
    templateMarkerPresent = CODEOWNERS_MARKER.test(text);
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "") continue;
      if (line.startsWith("#")) {
        placeholderLines += 1;
        continue;
      }
      activeRules.push(line);
    }
  }
  const codeowners: CodeownersInventory = {
    path: options.codeownersPath,
    exists: codeownersExists,
    activeRules,
    placeholderLines,
    templateMarkerPresent,
    status: !codeownersExists ? "missing" : activeRules.length > 0 ? "rules-present" : "placeholder-only"
  };

  // Private security reporting channel.
  const securityAbs = path.join(options.repoRoot, options.securityDocPath);
  const securityExists = existsSync(securityAbs);
  let statesChannelNotConfigured = false;
  const contactPointsFound: string[] = [];
  if (securityExists) {
    const text = readFileSync(securityAbs, "utf8");
    statesChannelNotConfigured =
      CHANNEL_NOT_CONFIGURED_MARKER.test(text) && CHANNEL_PENDING_MARKER.test(text);
    for (const match of text.matchAll(EMAIL_PATTERN)) {
      const contact = match[0];
      if (contact !== undefined) contactPointsFound.push(contact);
    }
  }
  const privateChannel: PrivateChannelInventory = {
    documentedIn: options.securityDocPath,
    exists: securityExists,
    statesChannelNotConfigured,
    contactPointsFound,
    status: !securityExists
      ? "missing"
      : contactPointsFound.length > 0
        ? "contact-points-present"
        : statesChannelNotConfigured
          ? "not-configured-documented"
          : "not-configured-documented"
  };

  // License formalization.
  const formalLicensePath = path.join(options.repoRoot, "LICENSE");
  const formalLicenseExists = existsSync(formalLicensePath);

  // Maintainer identity: MAINTAINERS.md explicitly states handles are not filled.
  // "recorded" flips to true only when that explicit not-filled statement is gone.
  const maintainersAbs = path.join(options.repoRoot, options.maintainersDocPath);
  let maintainerIdentityRecorded = false;
  if (existsSync(maintainersAbs)) {
    const text = readFileSync(maintainersAbs, "utf8");
    maintainerIdentityRecorded = !/尚未填写|not\s+yet\s+been\s+filled/i.test(text);
  }

  return {
    codeowners,
    privateChannel,
    licenseDecision: {
      formalLicensePath,
      exists: formalLicenseExists,
      status: formalLicenseExists ? "formalized" : "pending-maintainer-confirmation"
    },
    releaseApproval: {
      status: "pending-maintainer",
      note:
        "no human release approval exists; per MAINTAINERS.md and project/RELEASE_PROCESS.md only a maintainer can approve a release, and this audit never substitutes for that approval"
    },
    maintainerIdentityRecorded
  };
}
