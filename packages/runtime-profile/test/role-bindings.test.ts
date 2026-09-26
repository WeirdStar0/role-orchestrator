import { describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { ROLE_IDS } from "@role-orchestrator/contracts";
import { openDatabase } from "@role-orchestrator/store";
import {
  ExecutionTargetMismatchError,
  initializeProjectRoleBindings,
  listRoleBindings,
  resolveRoleBinding,
  RoleBindingResolutionError,
  RoleBindingsNotReadyError,
  setRoleBinding,
  UnknownProfileError,
  UnknownProfileRevisionError,
  UnknownProjectError,
  UnknownRoleError,
  validateRoleBindingsReady,
  type RoleBindingRow
} from "../src/index.js";
import {
  createMigratedMemoryDb,
  expectError,
  seedBoundProject,
  T0
} from "./helpers.js";

describe("A03: only the four fixed roles are accepted", () => {
  it("setRoleBinding rejects unknown roles with UnknownRoleError", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "tester", // intentional: probing the runtime guard
          profileId: seed.profileId,
          now: T0
        }),
      UnknownRoleError
    );
  });

  it("role ids are case-sensitive: 'Coordinator' is not a role (A03)", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "Coordinator", // intentional: probing the runtime guard
          profileId: seed.profileId,
          now: T0
        }),
      UnknownRoleError
    );
  });

  it("resolveRoleBinding and read paths reject unknown roles too", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    expectError(
      () => resolveRoleBinding(db, { projectId: seed.projectId, roleId: "techlead" }),
      UnknownRoleError
    );
  });

  it("the constraint vocabulary is exactly the four built-in roles", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    const bindings = listRoleBindings(db, seed.projectId);
    expect(bindings.map((b) => b.roleId).sort()).toEqual([...ROLE_IDS].sort());
  });
});

describe("A01: bindings resolve to exactly one existing profile revision", () => {
  it("a profile with no revision cannot be bound (binding must point at a revision)", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    const { createProfile } = await import("../src/index.js");
    createProfile(db, {
      id: "codex-main",
      runtime: "codex",
      executable: "codex.cmd",
      executionTarget: "windows-native",
      configDir: "C:/Users/u/.codex",
      credentialGroup: "personal",
      maxConcurrency: 2,
      timeoutSeconds: 600,
      now: T0
    });
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "developer",
          profileId: "codex-main",
          now: T0
        }),
      UnknownProfileRevisionError
    );
  });

  it("an explicit non-existent revision is rejected", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "developer",
          profileId: seed.profileId,
          profileRevision: 99,
          now: T0
        }),
      UnknownProfileRevisionError
    );
  });

  it("an unknown profile id is rejected before any write", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "developer",
          profileId: "ghost-profile",
          now: T0
        }),
      UnknownProfileError
    );
  });

  it("an unknown project is rejected", () => {
    const db = createMigratedMemoryDb();
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: "no-such-project",
          roleId: "developer",
          profileId: "any-profile",
          now: T0
        }),
      UnknownProjectError
    );
  });

  it("a role never initialized reports kind 'missing'", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    // Remove one binding row directly: simulates a project whose four rows
    // were never fully initialized.
    db.prepare("DELETE FROM role_bindings WHERE project_id = ? AND role_id = 'reviewer'").run(seed.projectId);
    const error = expectError(
      () => resolveRoleBinding(db, { projectId: seed.projectId, roleId: "reviewer" }),
      RoleBindingResolutionError
    );
    expect(error.kind).toBe("missing");
  });

  it("an initialized but unbound role reports kind 'unbound'", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    db.prepare(
      "UPDATE role_bindings SET profile_id = NULL, profile_revision = NULL WHERE project_id = ? AND role_id = 'architect'"
    ).run(seed.projectId);
    const error = expectError(
      () => resolveRoleBinding(db, { projectId: seed.projectId, roleId: "architect" }),
      RoleBindingResolutionError
    );
    expect(error.kind).toBe("unbound");
  });

  it("an unknown-profile binding (constraint bypassed) reports kind 'unknown-profile'", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    tamperBindingToGhostProfile(db, seed.projectId, "developer");
    const error = expectError(
      () => resolveRoleBinding(db, { projectId: seed.projectId, roleId: "developer" }),
      RoleBindingResolutionError
    );
    expect(error.kind).toBe("unknown-profile");
  });

  it("duplicate rows for one role (constraint removed) report kind 'multiple'", () => {
    const db = createTamperedDuplicateRowsDb();
    const error = expectError(
      () => resolveRoleBinding(db, { projectId: "proj-t", roleId: "coordinator" }),
      RoleBindingResolutionError
    );
    expect(error.kind).toBe("multiple");
  });

  it("a binding whose revision disappeared reports kind 'unknown-revision'", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    // Constraint bypass: point the binding at a revision that does not exist.
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare(
      "UPDATE role_bindings SET profile_revision = 42 WHERE project_id = ? AND role_id = 'reviewer'"
    ).run(seed.projectId);
    db.exec("PRAGMA foreign_keys = ON");
    const error = expectError(
      () => resolveRoleBinding(db, { projectId: seed.projectId, roleId: "reviewer" }),
      RoleBindingResolutionError
    );
    expect(error.kind).toBe("unknown-revision");
  });
});

describe("validateRoleBindingsReady (A01 pre-start gate)", () => {
  it("passes with all four roles resolved, in ROLE_IDS order", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    const ready = validateRoleBindingsReady(db, { projectId: seed.projectId });
    expect(ready.resolved.map((r) => r.roleId)).toEqual([...ROLE_IDS]);
    expect(ready.resolved.every((r) => r.snapshot.id === seed.profileId)).toBe(true);
  });

  it("aggregates every failing role into RoleBindingsNotReadyError", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    db.prepare(
      "UPDATE role_bindings SET profile_id = NULL, profile_revision = NULL WHERE project_id = ? AND role_id IN ('coordinator', 'developer')"
    ).run(seed.projectId);
    const error = expectError(
      () => validateRoleBindingsReady(db, { projectId: seed.projectId }),
      RoleBindingsNotReadyError
    );
    expect(error.failures).toEqual([
      { roleId: "coordinator", kind: "unbound" },
      { roleId: "developer", kind: "unbound" }
    ]);
  });
});

describe("binding mechanics", () => {
  it("initializeProjectRoleBindings is idempotent and preserves existing bindings", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    initializeProjectRoleBindings(db, { projectId: seed.projectId, now: T0 });
    const bindings = listRoleBindings(db, seed.projectId);
    expect(bindings).toHaveLength(4);
    expect(bindings.every((b) => b.profileId === seed.profileId)).toBe(true);
  });

  it("setRoleBinding stores permissionsRevision and canCreateSubtasks", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    setRoleBinding(db, {
      projectId: seed.projectId,
      roleId: "developer",
      profileId: seed.profileId,
      canCreateSubtasks: true,
      permissionsRevision: "policies-7",
      now: T0
    });
    const bindings = listRoleBindings(db, seed.projectId);
    const developer = bindings.find((b) => b.roleId === "developer") as RoleBindingRow;
    expect(developer.canCreateSubtasks).toBe(true);
    expect(developer.permissionsRevision).toBe("policies-7");
    const reviewer = bindings.find((b) => b.roleId === "reviewer") as RoleBindingRow;
    expect(reviewer.canCreateSubtasks).toBe(false);
  });

  it("binding without initialize fails with kind 'missing' and NoRowUpdatedError is never invented", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    db.prepare("DELETE FROM role_bindings WHERE project_id = ?").run(seed.projectId);
    const error = expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "coordinator",
          profileId: seed.profileId,
          now: T0
        }),
      RoleBindingResolutionError
    );
    expect(error.kind).toBe("missing");
  });

  it("rebinding updates updated_at and pins the given revision", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    const { createProfileRevision } = await import("../src/index.js");
    const rev2 = await createProfileRevision(db, {
      profileId: seed.profileId,
      model: "glm-4.7",
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: T0
    });
    const result = setRoleBinding(db, {
      projectId: seed.projectId,
      roleId: "developer",
      profileId: seed.profileId,
      profileRevision: rev2.revision,
      now: "2026-09-22T01:00:00.000Z"
    });
    expect(result.binding.profileRevision).toBe(2);
    expect(result.binding.updatedAt).toBe("2026-09-22T01:00:00.000Z");
    expect(result.snapshot.requestedModel).toBe("glm-4.7");
  });

  it("setRoleBinding on an uninitialized role fails loudly (not a silent success)", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    db.prepare("DELETE FROM role_bindings WHERE project_id = ? AND role_id = 'architect'").run(seed.projectId);
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "architect",
          profileId: seed.profileId,
          now: T0
        }),
      RoleBindingResolutionError
    );
  });
});

describe("A29 at bind time: target mismatch is a pre-error", () => {
  it("binding a wsl profile to a native (non-WSL) project of a different world is rejected", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    const { createProfile, createProfileRevision } = await import("../src/index.js");
    createProfile(db, {
      id: "codex-wsl",
      runtime: "codex",
      executable: "/usr/local/bin/codex",
      executionTarget: "wsl",
      configDir: "/home/u/.codex",
      credentialGroup: "personal",
      maxConcurrency: 2,
      timeoutSeconds: 600,
      now: T0
    });
    await createProfileRevision(db, {
      profileId: "codex-wsl",
      model: null,
      externalConfigFiles: ["config.toml"],
      externalConfigHash: "c".repeat(64), // configDir does not exist on this host
      now: T0
    });
    expectError(
      () =>
        setRoleBinding(db, {
          projectId: seed.projectId,
          roleId: "reviewer",
          profileId: "codex-wsl",
          now: T0
        }),
      ExecutionTargetMismatchError
    );
  });
});

/**
 * Build a minimal database whose role_bindings table LACKS the UNIQUE
 * constraint, to reach the defensive 'multiple' branch that the real schema
 * makes unreachable. Documented as a tamper simulation.
 */
function createTamperedDuplicateRowsDb(): DatabaseSync {
  const db = openDatabase(":memory:");
  db.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, repo_root TEXT NOT NULL, execution_target TEXT NOT NULL, trust_status TEXT NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE profiles (id TEXT PRIMARY KEY, runtime TEXT NOT NULL, executable TEXT NOT NULL, execution_target TEXT NOT NULL, config_dir TEXT NOT NULL, credential_group TEXT NOT NULL, max_concurrency INTEGER NOT NULL, timeout_seconds INTEGER NOT NULL, created_at TEXT NOT NULL) STRICT;
    CREATE TABLE profile_revisions (profile_id TEXT NOT NULL REFERENCES profiles(id), revision INTEGER NOT NULL, model TEXT, external_config_hash TEXT NOT NULL, external_config_files TEXT NOT NULL, config_hash TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE (profile_id, revision)) STRICT;
    CREATE TABLE role_bindings (project_id TEXT NOT NULL, role_id TEXT NOT NULL, profile_id TEXT, profile_revision INTEGER, permissions_revision TEXT NOT NULL, can_create_subtasks INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
  `);
  db.prepare(
    "INSERT INTO projects(id, repo_root, execution_target, trust_status, created_at) VALUES ('proj-t', 'h:/repos/t', 'windows-native', 'requires-user-confirmation', ?)"
  ).run(T0);
  db.prepare(
    "INSERT INTO profiles(id, runtime, executable, execution_target, config_dir, credential_group, max_concurrency, timeout_seconds, created_at) " +
      "VALUES ('claude-main', 'claude', 'claude.cmd', 'windows-native', 'C:/cfg', 'personal', 2, 600, ?)"
  ).run(T0);
  db.prepare(
    "INSERT INTO profile_revisions(profile_id, revision, model, external_config_hash, external_config_files, config_hash, created_at) " +
      "VALUES ('claude-main', 1, NULL, ?, '[]', ?, ?)"
  ).run("a".repeat(64), "b".repeat(64), T0);
  const insert = db.prepare(
    "INSERT INTO role_bindings(project_id, role_id, profile_id, profile_revision, permissions_revision, can_create_subtasks, created_at, updated_at) " +
      "VALUES ('proj-t', 'coordinator', 'claude-main', 1, '0', 0, ?, ?)"
  );
  insert.run(T0, T0);
  insert.run(T0, T0);
  return db;
}

function tamperBindingToGhostProfile(db: DatabaseSync, projectId: string, roleId: string): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare(
    "UPDATE role_bindings SET profile_id = 'ghost' WHERE project_id = ? AND role_id = ?"
  ).run(projectId, roleId);
  db.exec("PRAGMA foreign_keys = ON");
}
