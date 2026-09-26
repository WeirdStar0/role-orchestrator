import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  createProfile,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  initializeProjectRoleBindings,
  setRoleBinding,
  UnknownRunSnapshotError
} from "@role-orchestrator/runtime-profile";
import { createProject } from "@role-orchestrator/store";
import {
  createRunGraph,
  PlanRoleResolutionError,
  resolvePlanRolesFromBindings,
  resolvePlanRolesFromRunSnapshot,
  validateWorkflowPlan
} from "../src/index.js";
import {
  createMigratedMemoryDb,
  diamondWorkflow,
  expectError,
  FIXTURE_TARGET,
  fixtureRepoRoot,
  iso,
  makeFixtureConfigDir,
  T0
} from "./helpers.js";

describe("plan-time role resolution over CURRENT bindings (A01/A03 semantics)", () => {
  it("resolves every role the plan uses to its pinned profile revision", async () => {
    const db = createMigratedMemoryDb();
    try {
      const seeded = await seedProject(db);
      const plan = validateWorkflowPlan(diamondWorkflow());
      const resolved = resolvePlanRolesFromBindings(db, { projectId: seeded.projectId, plan });
      expect(resolved.map((entry) => entry.roleId)).toEqual([
        "coordinator",
        "developer",
        "reviewer"
      ]);
      for (const entry of resolved) {
        expect(entry.profileId).toBe(seeded.profileId);
        expect(entry.profileRevision).toBe(1);
        expect(entry.snapshot.revision).toBe(1);
      }
    } finally {
      db.close();
    }
  });

  it("an unbound role reports kind 'unbound' (wrapped runtime-profile semantics)", async () => {
    const db = createMigratedMemoryDb();
    try {
      const { projectId } = await seedProject(db, { bind: false });
      const plan = validateWorkflowPlan(diamondWorkflow());
      const error = expectError(
        () => resolvePlanRolesFromBindings(db, { projectId, plan }),
        PlanRoleResolutionError
      );
      expect(error.kind).toBe("unbound");
      expect(error.roleId).toBe("coordinator");
      expect((error.cause as Error).name).toBe("RoleBindingResolutionError");
    } finally {
      db.close();
    }
  });

  it("a project whose bindings were never initialized reports kind 'missing'", async () => {
    const db = createMigratedMemoryDb();
    try {
      createProject(db, {
        id: "proj-bare",
        repoRoot: fixtureRepoRoot("bare"),
        executionTarget: FIXTURE_TARGET,
        trustStatus: "requires-user-confirmation",
        now: T0
      });
      const plan = validateWorkflowPlan(diamondWorkflow());
      const error = expectError(
        () => resolvePlanRolesFromBindings(db, { projectId: "proj-bare", plan }),
        PlanRoleResolutionError
      );
      expect(error.kind).toBe("missing");
    } finally {
      db.close();
    }
  });

  it("a binding pointing at a deleted profile reports kind 'unknown-profile'", async () => {
    const db = createMigratedMemoryDb();
    try {
      const seeded = await seedProject(db);
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("DELETE FROM profiles WHERE id = ?").run(seeded.profileId);
      db.exec("PRAGMA foreign_keys = ON");
      const plan = validateWorkflowPlan(diamondWorkflow());
      const error = expectError(
        () => resolvePlanRolesFromBindings(db, { projectId: seeded.projectId, plan }),
        PlanRoleResolutionError
      );
      expect(error.kind).toBe("unknown-profile");
    } finally {
      db.close();
    }
  });

  it("a binding pointing at a deleted revision reports kind 'unknown-revision'", async () => {
    const db = createMigratedMemoryDb();
    try {
      const seeded = await seedProject(db);
      db.exec("PRAGMA foreign_keys = OFF");
      db.prepare("DELETE FROM profile_revisions WHERE profile_id = ?").run(seeded.profileId);
      db.exec("PRAGMA foreign_keys = ON");
      const plan = validateWorkflowPlan(diamondWorkflow());
      const error = expectError(
        () => resolvePlanRolesFromBindings(db, { projectId: seeded.projectId, plan }),
        PlanRoleResolutionError
      );
      expect(error.kind).toBe("unknown-revision");
    } finally {
      db.close();
    }
  });
});

describe("plan-time role resolution over FROZEN run snapshots (A34)", () => {
  it("reads the run's frozen snapshots; later binding changes cannot leak in", async () => {
    const db = createMigratedMemoryDb();
    try {
      const seeded = await seedProject(db, { runId: "run-frozen" });
      const plan = validateWorkflowPlan(diamondWorkflow());

      // Before: revision 1 everywhere.
      expect(
        resolvePlanRolesFromRunSnapshot(db, { runId: "run-frozen", plan }).map((entry) => entry.profileRevision)
      ).toEqual([1, 1, 1]);

      // Re-bind developer to a NEW revision after the run was created.
      await createProfileRevision(db, {
        profileId: seeded.profileId,
        model: "claude-sonnet-4-5",
        externalConfigFiles: ["settings.json", "mcp.json"],
        now: iso(1)
      });
      setRoleBinding(db, {
        projectId: seeded.projectId,
        roleId: "developer",
        profileId: seeded.profileId,
        profileRevision: 2,
        now: iso(2)
      });

      // The frozen read is unchanged (A34): the plan still resolves to rev 1.
      const frozen = resolvePlanRolesFromRunSnapshot(db, { runId: "run-frozen", plan });
      expect(frozen.map((entry) => entry.profileRevision)).toEqual([1, 1, 1]);
    } finally {
      db.close();
    }
  });

  it("a deleted snapshot row propagates the typed UnknownRunSnapshotError", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedProject(db, { runId: "run-frozen" });
      db.prepare("DELETE FROM run_profile_snapshots WHERE role_id = 'reviewer'").run();
      const plan = validateWorkflowPlan(diamondWorkflow());
      expectError(
        () => resolvePlanRolesFromRunSnapshot(db, { runId: "run-frozen", plan }),
        UnknownRunSnapshotError
      );
    } finally {
      db.close();
    }
  });

  it("createRunGraph resolves roles from the frozen snapshots and attaches them to the graph", async () => {
    const db = createMigratedMemoryDb();
    try {
      await seedProject(db, { runId: "run-frozen" });
      const graph = createRunGraph(db, { runId: "run-frozen", workflow: diamondWorkflow(), now: T0 });
      expect(graph.resolvedRoles.map((entry) => entry.roleId)).toEqual([
        "coordinator",
        "developer",
        "reviewer"
      ]);
      expect(graph.resolvedRoles.every((entry) => entry.profileRevision === 1)).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------

interface SeedResult {
  readonly projectId: string;
  readonly profileId: string;
}

async function seedProject(
  db: DatabaseSync,
  options: { readonly bind?: boolean; readonly runId?: string } = {}
): Promise<SeedResult> {
  const projectId = "proj-roles";
  const profileId = "claude-main";
  const bind = options.bind ?? true;
  const runId = options.runId;

  createProject(db, {
    id: projectId,
    repoRoot: fixtureRepoRoot(projectId),
    executionTarget: FIXTURE_TARGET,
    trustStatus: "requires-user-confirmation",
    now: T0
  });
  await createProfileWithRevision(db, profileId);
  initializeProjectRoleBindings(db, { projectId, now: T0 });
  if (bind) {
    for (const roleId of ["coordinator", "architect", "developer", "reviewer"] as const) {
      setRoleBinding(db, {
        projectId,
        roleId,
        profileId,
        canCreateSubtasks: roleId === "coordinator",
        now: T0
      });
    }
  }
  if (runId !== undefined) {
    createTaskRunWithProfileSnapshot(db, {
      runId,
      projectId,
      taskId: "task-1",
      graphRevision: 0,
      baseSha: "base-sha-1",
      now: T0
    });
  }
  return { projectId, profileId };
}

async function createProfileWithRevision(db: DatabaseSync, profileId: string): Promise<void> {
  await createProfile(db, {
    id: profileId,
    runtime: "claude",
    executable: "claude.cmd",
    executionTarget: FIXTURE_TARGET,
    configDir: makeFixtureConfigDir(),
    credentialGroup: "personal",
    maxConcurrency: 2,
    timeoutSeconds: 600,
    now: T0
  });
  await createProfileRevision(db, {
    profileId,
    model: null,
    externalConfigFiles: ["settings.json", "mcp.json"],
    now: T0
  });
}
