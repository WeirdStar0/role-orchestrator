import { describe, expect, it } from "vitest";
import type { Equal, Expect } from "@role-orchestrator/contracts";
import type {
  CheckExecutionTargetInput,
  CreateTaskRunWithProfileSnapshotInput,
  InitializeProjectRoleBindingsInput,
  ProfileSnapshotSchemaMatchesContract
} from "../src/index.js";
import {
  assertNoProfileModelOverride,
  createProfileRevision,
  FORBIDDEN_OVERRIDE_KEYS,
  NodeOverrideRejectedError,
  OVERRIDE_SCAN_MAX_DEPTH,
  ProfileSnapshotSchema
} from "../src/index.js";
import type { ProfileSnapshot } from "@role-orchestrator/contracts";
import { createMigratedMemoryDb, expectError, makeFixtureConfigDir, seedBoundProject, T0 } from "./helpers.js";

/* ------------------------------------------------------------------ */
/* Type layer: the input TYPES contain no override fields (A02)         */
/* ------------------------------------------------------------------ */

type HasKey<T, K extends PropertyKey> = K extends keyof T ? true : false;

export type RunInputFreeOfModel = Expect<Equal<HasKey<CreateTaskRunWithProfileSnapshotInput, "model">, false>>;
export type RunInputFreeOfProfileId = Expect<Equal<HasKey<CreateTaskRunWithProfileSnapshotInput, "profileId">, false>>;
export type RunInputFreeOfProfileRevision = Expect<
  Equal<HasKey<CreateTaskRunWithProfileSnapshotInput, "profileRevision">, false>
>;
export type RunInputFreeOfModelOverride = Expect<
  Equal<HasKey<CreateTaskRunWithProfileSnapshotInput, "modelOverride">, false>
>;
export type RunInputFreeOfRequestedModel = Expect<
  Equal<HasKey<CreateTaskRunWithProfileSnapshotInput, "requestedModel">, false>
>;
export type InitInputFreeOfProfileId = Expect<
  Equal<HasKey<InitializeProjectRoleBindingsInput, "profileId">, false>
>;
export type TargetCheckInputFreeOfModel = Expect<Equal<HasKey<CheckExecutionTargetInput, "model">, false>>;

// The runtime ProfileSnapshot schema body satisfies the frozen contracts type.
export type SnapshotSchemaSatisfiesContract = Expect<
  Equal<ProfileSnapshotSchemaMatchesContract, true>
>;

/* ------------------------------------------------------------------ */
/* Runtime layer: the guard deep-scans raw input                        */
/* ------------------------------------------------------------------ */

describe("A02 runtime guard: assertNoProfileModelOverride", () => {
  it("accepts payload without override fields", () => {
    expect(() =>
      assertNoProfileModelOverride({
        runId: "run-1",
        nested: { list: [{ ok: true }] }
      })
    ).not.toThrow();
  });

  it("accepts primitives", () => {
    expect(() => assertNoProfileModelOverride("model")).not.toThrow();
    expect(() => assertNoProfileModelOverride(42)).not.toThrow();
    expect(() => assertNoProfileModelOverride(null)).not.toThrow();
  });

  it("rejects forbidden keys at any depth, case-insensitively, reporting every path", () => {
    const error = expectError(
      () =>
        assertNoProfileModelOverride({
          a: {
            Model: "x",
            list: [{ PROFILEID: "p" }]
          },
          requested_model: null,
          profileRevision: 2
        }),
      NodeOverrideRejectedError
    );
    expect(error.paths).toContain("$.a.Model");
    expect(error.paths).toContain("$.a.list[0].PROFILEID");
    expect(error.paths).toContain("$.profileRevision");
    expect(error.paths).not.toContain("$.requested_model"); // snake_case not in list by design
  });

  it("rejects the full contracts override vocabulary plus revision-level aliases", () => {
    // Spot-check the pinned list contents.
    for (const key of ["model", "modelId", "profile", "profileId", "profiles", "fallbackProfileId", "fallbackProfileIds", "requestedModel", "profileRevision", "modelOverride"]) {
      expect(FORBIDDEN_OVERRIDE_KEYS).toContain(key);
    }
    expectError(() => assertNoProfileModelOverride({ fallbackProfileIds: ["a"] }), NodeOverrideRejectedError);
  });

  it("survives cyclic objects", () => {
    const cyclic: Record<string, unknown> = { a: {} };
    cyclic["self"] = cyclic;
    expect(() => assertNoProfileModelOverride(cyclic)).not.toThrow();
  });

  it("scans arrays and stops at the documented depth cap", () => {
    // Build a 40-level nesting with a forbidden key at level 35 (past the cap).
    let node: Record<string, unknown> = { model: "deep" };
    for (let i = 0; i < 34; i += 1) {
      node = { child: node };
    }
    expect(() => assertNoProfileModelOverride(node)).not.toThrow();
    expect(OVERRIDE_SCAN_MAX_DEPTH).toBe(32);
    // Within the cap it IS caught:
    let shallow: Record<string, unknown> = { model: "deep" };
    for (let i = 0; i < 10; i += 1) {
      shallow = { child: shallow };
    }
    expectError(() => assertNoProfileModelOverride(shallow), NodeOverrideRejectedError);
  });
});

describe("A02 surfaces: profile selection is allowed ONLY where bindings are configured", () => {
  it("createProfileRevision legitimately accepts `model` (no guard applied there)", async () => {
    const db = createMigratedMemoryDb();
    const seed = await seedBoundProject(db);
    const { dir } = makeFixtureConfigDir();
    const revision = await createProfileRevision(db, {
      profileId: seed.profileId,
      model: "glm-4.7",
      externalConfigFiles: ["settings.json"],
      now: T0
    });
    expect(revision.model).toBe("glm-4.7");
    expect(dir.length).toBeGreaterThan(0);
  });
});

describe("ProfileSnapshotSchema matches the frozen contracts type", () => {
  it("parses a valid snapshot", () => {
    const snapshot: ProfileSnapshot = {
      id: "claude-main",
      revision: 1,
      hash: "a".repeat(64),
      runtime: "claude",
      executable: "claude.cmd",
      executionTarget: "windows-native",
      configDir: "C:\\Users\\u\\.claude",
      requestedModel: null,
      credentialGroup: "personal",
      externalConfigHash: "b".repeat(64)
    };
    expect(ProfileSnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("rejects unknown or missing fields (strict)", () => {
    const base = {
      id: "claude-main",
      revision: 1,
      hash: "a".repeat(64),
      runtime: "claude",
      executable: "claude.cmd",
      executionTarget: "windows-native",
      configDir: "C:\\Users\\u\\.claude",
      requestedModel: null,
      credentialGroup: "personal",
      externalConfigHash: "b".repeat(64)
    };
    expect(ProfileSnapshotSchema.safeParse({ ...base, apiKey: "synthetic" }).success).toBe(false);
    expect(ProfileSnapshotSchema.safeParse({ ...base, externalConfigHash: undefined }).success).toBe(false);
  });
});
