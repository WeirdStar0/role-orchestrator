import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  createProfile,
  createProfileRevision,
  DuplicateProfileError,
  ExternalConfigViolationError,
  getLatestProfileRevision,
  getProfile,
  getProfileRevision,
  hashExternalConfigFiles,
  listProfileRevisions,
  listProfiles,
  ProfileRevisionConflictError,
  profileRevisionToSnapshot,
  UnknownProfileError,
  type CreateProfileInput
} from "../src/index.js";
import {
  createMigratedMemoryDb,
  expectError,
  expectRejection,
  makeFixtureConfigDir,
  seedBoundProject,
  T0
} from "./helpers.js";

function createDb() {
  return createMigratedMemoryDb();
}

function validProfileInput(): CreateProfileInput {
  return {
    id: "claude-main",
    runtime: "claude",
    executable: "claude.cmd",
    executionTarget: "windows-native",
    configDir: makeFixtureConfigDir().dir,
    credentialGroup: "personal",
    maxConcurrency: 2,
    timeoutSeconds: 600,
    now: T0
  };
}

/** Intentionally untyped: these tests probe RUNTIME rejection of bad values. */
function profileInputWith(overrides: Record<string, unknown>): CreateProfileInput {
  return { ...validProfileInput(), ...overrides } as unknown as CreateProfileInput;
}

describe("profiles", () => {
  it("creates and reads back a profile", () => {
    const db = createDb();
    const profile = createProfile(db, validProfileInput());
    expect(profile).toEqual(getProfile(db, "claude-main"));
    expect(listProfiles(db)).toHaveLength(1);
  });

  it("rejects duplicate ids", () => {
    const db = createDb();
    createProfile(db, validProfileInput());
    expectError(() => createProfile(db, validProfileInput()), DuplicateProfileError);
  });

  it("rejects unknown fields and out-of-bound values via the strict schema", () => {
    const db = createDb();
    expectError(() => createProfile(db, profileInputWith({ extraArg: "nope" })), ZodError);
    expectError(() => createProfile(db, profileInputWith({ maxConcurrency: 64 })), ZodError);
    expectError(() => createProfile(db, profileInputWith({ timeoutSeconds: 1 })), ZodError);
    expectError(() => createProfile(db, profileInputWith({ runtime: "mock-cli" })), ZodError);
  });
});

describe("profile revisions (immutable)", () => {
  it("creates revision 1 by default and increments", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const rev2 = await createProfileRevision(db, {
      profileId: seed.profileId,
      model: "glm-4.7",
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: T0
    });
    expect(rev2.revision).toBe(2);
    expect(getLatestProfileRevision(db, seed.profileId)?.revision).toBe(2);
    expect(listProfileRevisions(db, seed.profileId)).toHaveLength(2);
  });

  it("stores the manifest normalized, deduped and sorted; model null survives a roundtrip", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db, {
      configDir: makeFixtureConfigDir({
        "sub/dir/b.toml": "b = 1\n"
      }).dir
    });
    const revision = await createProfileRevision(db, {
      profileId: seed.profileId,
      model: null,
      externalConfigFiles: ["mcp.json", "sub\\dir\\b.toml", "settings.json", "mcp.json"],
      now: T0
    });
    expect(revision.externalConfigFiles).toEqual(["mcp.json", "settings.json", "sub/dir/b.toml"]);
    const stored = getProfileRevision(db, seed.profileId, revision.revision);
    expect(stored?.externalConfigFiles).toEqual(revision.externalConfigFiles);
    expect(stored?.model).toBeNull();
  });

  it("an explicit duplicate revision raises ProfileRevisionConflictError (append-only)", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    await expectRejection(
      createProfileRevision(db, {
        profileId: seed.profileId,
        revision: 1,
        model: "other",
        externalConfigFiles: ["settings.json"],
        now: T0
      }),
      ProfileRevisionConflictError
    );
  });

  it("an unknown profile raises UnknownProfileError", async () => {
    const db = createDb();
    await expectRejection(
      createProfileRevision(db, {
        profileId: "ghost",
        model: null,
        externalConfigFiles: [],
        now: T0
      }),
      UnknownProfileError
    );
  });

  it("refuses credential files from the manifest at registration", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const error = await expectRejection(
      createProfileRevision(db, {
        profileId: seed.profileId,
        model: null,
        externalConfigFiles: ["settings.json", ".credentials.json"],
        now: T0
      }),
      ExternalConfigViolationError
    );
    expect(error.kind).toBe("credential-pattern");
    expect(error.path).toBe(".credentials.json");
  });

  it("refuses path escapes and absolute paths at registration", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    await expectRejection(
      createProfileRevision(db, {
        profileId: seed.profileId,
        model: null,
        externalConfigFiles: ["../outside.toml"],
        now: T0
      }),
      ExternalConfigViolationError
    );
    await expectRejection(
      createProfileRevision(db, {
        profileId: seed.profileId,
        model: null,
        externalConfigFiles: ["C:\\Windows\\system.ini"],
        now: T0
      }),
      ExternalConfigViolationError
    );
  });

  it("computes the external baseline from disk and matches the exported hasher", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const revision = await createProfileRevision(db, {
      profileId: seed.profileId,
      model: null,
      externalConfigFiles: ["settings.json", "mcp.json"],
      now: T0
    });
    const expected = (
      await hashExternalConfigFiles(seed.configDir, ["settings.json", "mcp.json"])
    ).manifestHash;
    expect(revision.externalConfigHash).toBe(expected);
  });

  it("accepts an explicit baseline hash for profiles registered before their configDir exists", async () => {
    const db = createDb();
    await seedBoundProject(db);
    createProfile(db, {
      id: "codex-main",
      runtime: "codex",
      executable: "codex.cmd",
      executionTarget: "windows-native",
      configDir: "C:\\Users\\nobody\\.codex-not-installed",
      credentialGroup: "personal",
      maxConcurrency: 2,
      timeoutSeconds: 600,
      now: T0
    });
    const revision = await createProfileRevision(db, {
      profileId: "codex-main",
      model: null,
      externalConfigFiles: ["config.toml"],
      externalConfigHash: "c".repeat(64),
      now: T0
    });
    expect(revision.externalConfigHash).toBe("c".repeat(64));
  });

  it("without an explicit hash and without the files on disk, baseline creation fails loudly", async () => {
    const db = createDb();
    await seedBoundProject(db);
    createProfile(db, {
      id: "codex-main",
      runtime: "codex",
      executable: "codex.cmd",
      executionTarget: "windows-native",
      configDir: "C:\\Users\\nobody\\.codex-not-installed",
      credentialGroup: "personal",
      maxConcurrency: 2,
      timeoutSeconds: 600,
      now: T0
    });
    await expectRejection(
      createProfileRevision(db, {
        profileId: "codex-main",
        model: null,
        externalConfigFiles: ["config.toml"],
        now: T0
      }),
      ExternalConfigViolationError
    );
  });

  it("snapshot conversion: ProfileSnapshot.hash equals the revision config hash; no secret fields", async () => {
    const db = createDb();
    const seed = await seedBoundProject(db);
    const profile = getProfile(db, seed.profileId);
    if (profile === null) {
      throw new Error("seed profile missing");
    }
    const snapshot = profileRevisionToSnapshot(profile, seed.revision);
    expect(snapshot.hash).toBe(seed.revision.configHash);
    expect(snapshot.id).toBe(seed.profileId);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.requestedModel).toBeNull();
    expect(snapshot.externalConfigHash).toBe(seed.revision.externalConfigHash);
    expect(Object.keys(snapshot)).not.toContain("apiKey");
  });
});
