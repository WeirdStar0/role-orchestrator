/**
 * A17-by-analogy binding for remote writes (M7-01).
 *
 * The approval package (M4-01) binds an approval to ONE exact action via a
 * canonical sha256 over the complete action essentials; changing ANY element
 * after approval yields a different digest, and the guarded CAS refuses
 * consumption (A17/A18). Remote SCM writes REUSE that machinery instead of
 * reimplementing it: every controlled write command maps deterministically to
 * a real `ActionDescriptor`, and its `actionDigest` is the approval binding.
 *
 * The mapping (all of it digest-relevant):
 * - argv[0..] — a canonical operation vector: ["scm", provider, operation,
 *   "--repo", owner/name, per-subject args, "--base-sha", "--head-sha",
 *   "--title-sha256"/"--body-sha256"]. Content enters as sha256 (canonical
 *   JSON of {title?, body}), so oversized bodies bind exactly without
 *   violating the descriptor's per-element length cap, and no content is
 *   stored in the approval row.
 * - cwd — the managed worktree the write was prepared in; repo.root — the
 *   canonical local repo root; repo.baseSha/targetSha — baseline + head.
 * - profileRevision — the frozen profile revision of the owning run.
 * - requiredPermissions — ["repo.write"] (the closed v1 vocabulary has no
 *   remote-write id; repo.write is the nearest fact); grantedPermissions —
 *   from the binding, so the derived permission increment is exact.
 * - dimensions — ["network", "external-side-effect", "write"] with
 *   writeScope "unscoped": a remote write is a network-reachable external
 *   side effect outside every controlled local scope.
 * - requiredCapabilities — ["scm.<provider>.remote-write"], ids UNKNOWN to
 *   the capability gate until a real integration lands → grade "high"
 *   (capability-not-verified) on top of the three dimension reasons.
 *
 * Consequence pinned by tests: EVERY valid remote write grades "high" and
 * requiresApproval — a remote SCM write can never be slid through as
 * low/medium risk, and the write client refuses if the grader ever says
 * otherwise (invariant).
 */
import {
  ActionDescriptorSchema,
  actionDigest,
  gradeRisk,
  type ActionDescriptor,
  type RiskAssessment
} from "@role-orchestrator/approval";
import { canonicalJson, sha256Hex } from "@role-orchestrator/runtime-profile";
import type { ScmProvider } from "./capability.js";
import type {
  ScmCreateIssueCommentCommand,
  ScmCreatePullRequestCommand,
  ScmUpdatePullRequestTextCommand
} from "./writes.js";

export type ScmWriteCommand =
  | { readonly operation: "createIssueComment"; readonly command: ScmCreateIssueCommentCommand }
  | { readonly operation: "createPullRequest"; readonly command: ScmCreatePullRequestCommand }
  | { readonly operation: "updatePullRequestText"; readonly command: ScmUpdatePullRequestTextCommand };

/** Stable kebab-case slug used as the argv operation element. */
export function scmOperationSlug(operation: ScmWriteCommand["operation"]): string {
  return operation.replaceAll(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/**
 * Canonical content digest over {title?, body}. Uses the repo's canonical
 * JSON (sorted keys) so key order can never change a digest.
 */
export function scmContentSha256(input: { readonly title?: string; readonly body: string }): string {
  const value: { body: string; title?: string } = { body: input.body };
  if (input.title !== undefined) {
    value.title = input.title;
  }
  return sha256Hex(canonicalJson(value));
}

/**
 * Map one controlled write command to its approval ActionDescriptor. The
 * input must already be schema-valid (the write client parses first); the
 * resulting descriptor is parsed through ActionDescriptorSchema so an invalid
 * mapping can never leave this function.
 */
export function scmWriteActionDescriptor(provider: ScmProvider, intent: ScmWriteCommand): ActionDescriptor {
  const binding = intent.command.binding;
  const argv: string[] = [
    "scm",
    provider,
    scmOperationSlug(intent.operation),
    "--repo",
    `${intent.command.repo.owner}/${intent.command.repo.name}`
  ];
  switch (intent.operation) {
    case "createIssueComment": {
      const command = intent.command;
      argv.push("--issue", String(command.issueNumber));
      argv.push("--body-sha256", scmContentSha256({ body: command.body }));
      break;
    }
    case "createPullRequest": {
      const command = intent.command;
      argv.push("--source-branch", command.sourceBranch);
      argv.push("--target-branch", command.targetBranch);
      argv.push("--title-sha256", scmContentSha256({ title: command.title, body: command.body }));
      break;
    }
    case "updatePullRequestText": {
      const command = intent.command;
      argv.push("--pull-request", String(command.pullRequestNumber));
      argv.push("--title-sha256", scmContentSha256({ title: command.title, body: command.body }));
      break;
    }
  }
  argv.push("--base-sha", binding.baseSha);
  argv.push("--head-sha", binding.headSha);

  return ActionDescriptorSchema.parse({
    runtime: binding.runtime,
    argv,
    cwd: binding.worktreePath,
    repo: {
      root: binding.repoRoot,
      baseSha: binding.baseSha,
      targetSha: binding.headSha
    },
    profileRevision: binding.profileRevision,
    requiredPermissions: ["repo.write"],
    grantedPermissions: [...binding.grantedPermissions],
    dimensions: ["network", "external-side-effect", "write"],
    writeScope: "unscoped",
    requiredCapabilities: [`scm.${provider}.remote-write`]
  });
}

/** The digest an ApprovalRef must carry for this exact command (pure, stable). */
export function scmWriteActionDigest(provider: ScmProvider, intent: ScmWriteCommand): string {
  return actionDigest(scmWriteActionDescriptor(provider, intent));
}

/** The risk assessment of the mapped descriptor (audit + invariant checks). */
export function scmWriteRiskAssessment(provider: ScmProvider, intent: ScmWriteCommand): RiskAssessment {
  return gradeRisk(scmWriteActionDescriptor(provider, intent));
}
