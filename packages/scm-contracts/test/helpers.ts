/**
 * Shared hermetic test plumbing for the M7-01 scm-contracts suite.
 *
 * Everything is in-memory or system-temp-directory local: SQLite approval
 * worlds via @role-orchestrator/store (the SAME real approval machinery the
 * production host would wire), recording fake transports, fixed clocks. No
 * git, no processes, no network — the "provider" is always a fake transport.
 */
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import {
  applyApprovalMigrations,
  approveApproval,
  consumeApproval,
  createApproval,
  type ActionDescriptor
} from "@role-orchestrator/approval";
import {
  appliedMigrationRecords,
  createProject,
  createTaskRun,
  openDatabase
} from "@role-orchestrator/store";
import {
  SCM_PROVIDER_COMPAT_MATRIX,
  createResolvedCredentialHandle,
  type ScmAuditEvent,
  type ScmApprovalRef,
  type ScmProviderCapability,
  type ScmVerificationLookup
} from "../src/index.js";

/** Fixed clock base so timestamps/expiry are deterministic. */
export const T0 = "2026-09-24T00:00:00.000Z";
export const T1 = "2026-09-24T00:00:01.000Z";
export const T_PLUS_2H = "2026-09-24T02:00:00.000Z";

export const SHA_BASE = "a".repeat(40);
export const SHA_HEAD = "b".repeat(40);
export const SHA_OTHER = "c".repeat(40);

export const GITHUB_TOKEN_ENV = "GITHUB_TOKEN";
export const EXECUTION_ID = "exec-1";

/** A verified lookup — the injected seam hermetic tests use to construct clients. */
export function verifiedVerification(): ScmVerificationLookup {
  return () => ({ status: "verified", evidence: "test-fixture: not a real verification" });
}

/** A capability declaration for github against a fake, never-contacted host. */
export function githubCapability(overrides: Partial<ScmProviderCapability> = {}): ScmProviderCapability {
  const github = SCM_PROVIDER_COMPAT_MATRIX.github;
  return {
    provider: "github",
    baseUrl: "https://github.example.invalid",
    apiFlavor: "github-rest-v3",
    reads: ["listIssues", "listPullRequests", "listChecks", "listStatuses"],
    writes: ["createIssueComment", "createPullRequest", "updatePullRequestText"],
    tokenScopes: {
      read: [...github.proposedMinimalScopes.read],
      write: [...github.proposedMinimalScopes.write]
    },
    ...overrides
  };
}

export function githubCredential() {
  return createResolvedCredentialHandle({ provider: "github", label: `env:${GITHUB_TOKEN_ENV}` });
}

// ---------------------------------------------------------------------------
// Real approval world (mirrors packages/approval/test/helpers.ts wiring)
// ---------------------------------------------------------------------------

export interface ApprovalWorld {
  readonly db: import("node:sqlite").DatabaseSync;
  readonly scratchDir: string;
  readonly runId: string;
  close(): void;
}

export function createApprovalWorld(label: string): ApprovalWorld {
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), `ro-scm-${label}-`));
  const db = openDatabase(path.join(scratchDir, "store.db"));
  applyApprovalMigrations(db, { now: T0 });
  const records = appliedMigrationRecords(db);
  if (records.length !== 11 || records[10]?.version !== 11) {
    db.close();
    throw new Error("test helper: migrations 001..011 were not applied");
  }
  createProject(db, {
    id: "proj-1",
    repoRoot: path.join(scratchDir, "repo"),
    executionTarget: "windows-native",
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  const runId = "run-1";
  createTaskRun(db, {
    id: runId,
    projectId: "proj-1",
    taskId: "task-1",
    graphRevision: 0,
    configSnapshotHash: "hash-config-1",
    baseSha: SHA_BASE,
    now: T0
  });
  return {
    db,
    scratchDir,
    runId,
    close: () => {
      db.close();
      rmSync(scratchDir, { recursive: true, force: true });
    }
  };
}

/**
 * Creates + approves one approval for the given action; returns the record id.
 * The action comes from scmWriteActionDescriptor — the production flow.
 */
export function createApprovedApproval(
  world: ApprovalWorld,
  action: ActionDescriptor,
  key: string
): string {
  const { approval } = createApproval(world.db, {
    idempotencyKey: key,
    action,
    ttlSeconds: 3600,
    now: T0
  });
  approveApproval(world.db, { approvalId: approval.id, approvedBy: "user-1", now: T0 });
  return approval.id;
}

/** The host-side consume callback wired to the REAL single-shot CAS consume. */
export function storeConsume(
  world: ApprovalWorld,
  clock: { readonly now: string }
): (input: { readonly action: ActionDescriptor; readonly approvalRef: ScmApprovalRef }) => Promise<unknown> {
  return async ({ action, approvalRef }) => {
    const record = consumeApproval(world.db, {
      approvalId: approvalRef.approvalId,
      action,
      consumedByExecutionId: EXECUTION_ID,
      now: clock.now
    });
    return {
      approvalId: record.id,
      actionDigest: record.actionDigest,
      consumedByExecutionId: record.consumedByExecutionId ?? EXECUTION_ID,
      consumedAt: record.consumedAt ?? clock.now
    };
  };
}

// ---------------------------------------------------------------------------
// Fake transports (the "provider" — hermetic by construction)
// ---------------------------------------------------------------------------

export function recordingReadTransport(page: unknown) {
  return {
    listIssues: vi.fn((_query: unknown, _credential: unknown) => Promise.resolve(page)),
    listPullRequests: vi.fn((_query: unknown, _credential: unknown) => Promise.resolve(page)),
    listChecks: vi.fn((_query: unknown, _credential: unknown) => Promise.resolve(page)),
    listStatuses: vi.fn((_query: unknown, _credential: unknown) => Promise.resolve(page))
  };
}

export function recordingWriteTransport(projection: unknown) {
  return {
    createIssueComment: vi.fn((_command: unknown, _credential: unknown) => Promise.resolve(projection)),
    createPullRequest: vi.fn((_command: unknown, _credential: unknown) => Promise.resolve(projection)),
    updatePullRequestText: vi.fn((_command: unknown, _credential: unknown) => Promise.resolve(projection))
  };
}

/** An audit sink that records emitted events with a fixed clock. */
export function recordingAuditSink(now: string = T1) {
  const events: ScmAuditEvent[] = [];
  return {
    events,
    now: () => now,
    emit: (event: ScmAuditEvent) => {
      events.push(event);
    }
  };
}

// ---------------------------------------------------------------------------
// Write command fixtures (raw records on purpose — the schema is the boundary)
// ---------------------------------------------------------------------------

export function bindingFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runtime: "codex",
    profileRevision: "rev-1",
    repoRoot: "h:/repos/example",
    worktreePath: "h:/worktrees/example-exec",
    baseSha: SHA_BASE,
    headSha: SHA_HEAD,
    grantedPermissions: ["repo.read"],
    ...overrides
  };
}

export function issueCommentCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: { owner: "example-org", name: "example-repo" },
    issueNumber: 42,
    body: "Integration candidate ready for review.",
    binding: bindingFixture(),
    ...overrides
  };
}

export function createPullRequestCommand(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: { owner: "example-org", name: "example-repo" },
    title: "Integrate node output",
    body: "Merges the accepted node output.",
    sourceBranch: "task/run-1/node-1",
    targetBranch: "integration/run-1",
    binding: bindingFixture(),
    ...overrides
  };
}
