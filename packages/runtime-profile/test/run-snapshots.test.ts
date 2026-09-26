import { describe, expect, it } from "vitest";
import { getTaskRun } from "@role-orchestrator/store";
import {
  computeRunConfigSnapshotHash,
  createProfileRevision,
  createTaskRunWithProfileSnapshot,
  DuplicateRunError,
  ExecutionTargetMismatchError,
  getRunBindingDrift,
  listRunProfileSnapshots,
  NodeOverrideRejectedError,
  readRunRoleProfile,
  RoleBindingsNotReadyError,
  setRoleBinding,
  sha256Hex,
  SnapshotIntegrityError,
  UnknownProjectError,
  UnknownRunSnapshotError,
  type CreateTaskRunWithProfileSnapshotInput
} from "../src/index.js";
import {
  createMigratedMemoryDb,
  expectError,
  seedBoundProject,
  seedReadyRun,
  T0
} from "./helpers.js";

function createDb() {
  return createMigratedMemoryDb();
}

describe("A34 (immutable half): run snapshots freeze the binding resolution", () => {
  it("creates the run, four snapshot rows and a deterministic configSnapshotHash in one go", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const result = createTaskRunWithProfileSnapshot(db, {
      runId: "run-a",
      projectId: seed.projectId,
      taskId: "task-1",
      graphRevision: 0,
      baseSha: "abc123",
      now: T0
    });
    expect(result.run.configSnapshotHash).toBe(
      computeRunConfigSnapshotHash("run-a", result.resolved)
    );
    expect(result.snapshots).toHaveLength(4);
    expect(result.snapshots.map((s) => s.roleId)).toEqual([
      "coordinator",
      "architect",
      "developer",
      "reviewer"
    ]);
    expect(listRunProfileSnapshots(db, "run-a")).toHaveLength(4);
    // Frozen snapshot hash = sha256 of the stored canonical JSON.
    for (const row of result.snapshots) {
      expect(row.snapshotHash).toBe(sha256Hex(row.snapshotJson));
    }
  });

  it("the frozen snapshot matches the contracts ProfileSnapshot field set (secret-free)", async () => {
    const db = createDb();
    const seed = await seedReadyRun(db, { runId: "run-shape" });
    const read = readRunRoleProfile(db, { runId: "run-shape", roleId: "coordinator" });
    expect(Object.keys(read.snapshot).sort()).toEqual(
      [
        "id",
        "revision",
        "hash",
        "runtime",
        "executable",
        "executionTarget",
        "configDir",
        "requestedModel",
        "credentialGroup",
        "externalConfigHash"
      ].sort()
    );
    expect(read.snapshot.id).toBe(seed.profileId);
    expect(read.snapshot.revision).toBe(1);
    expect(read.snapshot.hash).toBe(seed.revision.configHash);
  });

  it("A34 core: rebinding a role does NOT affect an existing run's reads", async () => {
    const db = createDb();
    const seed = await seedReadyRun(db, { runId: "run-frozen" });
    // New revision with a different model expectation, then rebind developer.
    const rev2 = await createProfileRevision(db, {
      profileId: seed.profileId,
      model: "glm-4.7",
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: T0
    });
    setRoleBinding(db, {
      projectId: seed.projectId,
      roleId: "developer",
      profileId: seed.profileId,
      profileRevision: rev2.revision,
      now: T0
    });
    // The service read path goes through the snapshot, not the binding:
    const read = readRunRoleProfile(db, { runId: "run-frozen", roleId: "developer" });
    expect(read.snapshot.revision).toBe(1);
    expect(read.snapshot.requestedModel).toBeNull();
    // While a NEW run picks up the new revision ("仅影响新 TaskRun"):
    const newRun = createTaskRunWithProfileSnapshot(db, {
      runId: "run-after-rebind",
      projectId: seed.projectId,
      taskId: "task-2",
      graphRevision: 0,
      baseSha: "abc123",
      now: T0
    });
    const newRead = readRunRoleProfile(db, {
      runId: newRun.run.id,
      roleId: "developer"
    });
    expect(newRead.profileRevision).toBe(2);
    expect(newRead.snapshot.requestedModel).toBe("glm-4.7");
  });

  it("any failure leaves NO run row and NO snapshot rows (single transaction)", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    // Unbind one role -> A01 pre-start rejection.
    db.prepare(
      "UPDATE role_bindings SET profile_id = NULL, profile_revision = NULL WHERE project_id = ? AND role_id = 'reviewer'"
    ).run(seed.projectId);
    expectError(
      () =>
        createTaskRunWithProfileSnapshot(db, {
          runId: "run-rolled-back",
          projectId: seed.projectId,
          taskId: "task-1",
          graphRevision: 0,
          baseSha: "abc123",
          now: T0
        }),
      RoleBindingsNotReadyError
    );
    expect(getTaskRun(db, "run-rolled-back")).toBeNull();
    expect(listRunProfileSnapshots(db, "run-rolled-back")).toHaveLength(0);
  });

  it("duplicate run id raises DuplicateRunError and leaves no partial snapshot set", async () => {
    const db = createDb();
    const seed = await seedReadyRun(db, { runId: "run-dup" });
    expectError(
      () =>
        createTaskRunWithProfileSnapshot(db, {
          runId: "run-dup",
          projectId: seed.projectId,
          taskId: "task-1",
          graphRevision: 0,
          baseSha: "abc123",
          now: T0
        }),
      DuplicateRunError
    );
    expect(listRunProfileSnapshots(db, "run-dup")).toHaveLength(4);
  });

  it("unknown project raises UnknownProjectError", () => {
    const db = createDb();
    expectError(
      () =>
        createTaskRunWithProfileSnapshot(db, {
          runId: "run-x",
          projectId: "nope",
          taskId: "task-1",
          graphRevision: 0,
          baseSha: "abc123",
          now: T0
        }),
      UnknownProjectError
    );
  });
});

describe("A02 at the run-creation entry: override fields are rejected", () => {
  it("a task-level 'model' key raises NodeOverrideRejectedError before anything runs", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const bad = {
      runId: "run-override",
      projectId: seed.projectId,
      taskId: "task-1",
      graphRevision: 0,
      baseSha: "abc123",
      now: T0,
      model: "glm-4.7"
    } as unknown as CreateTaskRunWithProfileSnapshotInput;
    expectError(() => createTaskRunWithProfileSnapshot(db, bad), NodeOverrideRejectedError);
  });

  it("a nested 'definitions[0].profileId' payload raises with the full path", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const bad = {
      runId: "run-override-2",
      projectId: seed.projectId,
      taskId: "task-1",
      graphRevision: 0,
      baseSha: "abc123",
      now: T0,
      definitions: [{ id: "n1", profileId: "claude-main" }]
    } as unknown as CreateTaskRunWithProfileSnapshotInput;
    const error = expectError(
      () => createTaskRunWithProfileSnapshot(db, bad),
      NodeOverrideRejectedError
    );
    expect(error.paths).toContain("$.definitions[0].profileId");
  });

  it("non-override unknown fields are rejected by the strict schema (ZodError)", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const bad = {
      runId: "run-unknown-field",
      projectId: seed.projectId,
      taskId: "task-1",
      graphRevision: 0,
      baseSha: "abc123",
      now: T0,
      hemisphere: "south"
    } as unknown as CreateTaskRunWithProfileSnapshotInput;
    try {
      createTaskRunWithProfileSnapshot(db, bad);
      expect.unreachable("expected a throw");
    } catch (error) {
      expect((error as Error).name).toBe("ZodError");
    }
  });
});

describe("A29 at run creation: request target mismatch is a pre-error", () => {
  it("requestedExecutionTarget differing from the project target aborts creation", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    expectError(
      () =>
        createTaskRunWithProfileSnapshot(db, {
          runId: "run-target",
          projectId: seed.projectId,
          taskId: "task-1",
          graphRevision: 0,
          baseSha: "abc123",
          requestedExecutionTarget: "wsl",
          now: T0
        }),
      ExecutionTargetMismatchError
    );
    expect(getTaskRun(db, "run-target")).toBeNull();
  });
});

describe("A34: binding drift query (snapshot vs current binding consistency)", () => {
  it("reports no drift for an untouched run", async () => {
    const db = createDb();
    await seedReadyRun(db, { runId: "run-steady" });
    const drift = getRunBindingDrift(db, "run-steady");
    expect(drift.drifted).toBe(false);
    expect(drift.entries.every((e) => e.kind === "none")).toBe(true);
  });

  it("detects rebinding including the model expectation change (frozen vs current model)", async () => {
    const db = createDb();
    const seed = await seedReadyRun(db, { runId: "run-drift" });
    const rev2 = await createProfileRevision(db, {
      profileId: seed.profileId,
      model: "glm-4.7",
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: T0
    });
    setRoleBinding(db, {
      projectId: seed.projectId,
      roleId: "developer",
      profileId: seed.profileId,
      profileRevision: rev2.revision,
      now: T0
    });
    const drift = getRunBindingDrift(db, "run-drift");
    expect(drift.drifted).toBe(true);
    const developer = drift.entries.find((e) => e.roleId === "developer");
    expect(developer?.kind).toBe("binding-changed");
    expect(developer?.frozen).toEqual({ profileId: seed.profileId, revision: 1, model: null });
    expect(developer?.current).toEqual({
      profileId: seed.profileId,
      revision: 2,
      model: "glm-4.7"
    });
    // Unchanged roles show the newer revision as information only:
    const reviewer = drift.entries.find((e) => e.roleId === "reviewer");
    expect(reviewer?.kind).toBe("none");
    expect(reviewer?.latestRevision).toBe(2);
  });

  it("reports unbound roles as drift, never as a silent pass", async () => {
    const db = createDb();
    const seed = await seedReadyRun(db, { runId: "run-unbound" });
    db.prepare(
      "UPDATE role_bindings SET profile_id = NULL, profile_revision = NULL WHERE project_id = ? AND role_id = 'architect'"
    ).run(seed.projectId);
    const drift = getRunBindingDrift(db, "run-unbound");
    expect(drift.drifted).toBe(true);
    expect(drift.entries.find((e) => e.roleId === "architect")?.kind).toBe("unbound");
  });

  it("unknown run raises UnknownRunSnapshotError", () => {
    const db = createDb();
    expectError(() => getRunBindingDrift(db, "run-nope"), UnknownRunSnapshotError);
  });
});

describe("A34: frozen reads fail closed", () => {
  it("a tampered snapshot_json fails its integrity check", async () => {
    const db = createDb();
    await seedReadyRun(db, { runId: "run-tamper" });
    db.prepare(
      "UPDATE run_profile_snapshots SET snapshot_json = replace(snapshot_json, 'claude', 'codex') WHERE run_id = 'run-tamper'"
    ).run();
    expectError(
      () => readRunRoleProfile(db, { runId: "run-tamper", roleId: "coordinator" }),
      SnapshotIntegrityError
    );
  });

  it("a missing snapshot row is UnknownRunSnapshotError, never a fallback to bindings", async () => {
    const db = createDb();
    await seedReadyRun(db, { runId: "run-gap" });
    db.prepare("DELETE FROM run_profile_snapshots WHERE role_id = 'developer'").run();
    expectError(
      () => readRunRoleProfile(db, { runId: "run-gap", roleId: "developer" }),
      UnknownRunSnapshotError
    );
  });
});
