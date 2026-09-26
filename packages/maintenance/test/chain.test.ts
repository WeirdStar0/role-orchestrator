import { describe, expect, it } from "vitest";
import {
  DAEMON_CHAIN_MAX_VERSION,
  DAEMON_MIGRATIONS,
  composeMigrationUnion,
  daemonChainChecksums
} from "../src/index.js";
import { MaintenanceError } from "../src/index.js";

describe("daemon migration chain (M6-02)", () => {
  it("composes 001..017 exactly, ascending, no gaps", () => {
    expect(DAEMON_CHAIN_MAX_VERSION).toBe(17);
    expect(DAEMON_MIGRATIONS.map((def) => def.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17
    ]);
    // Every composed entry must keep the package name discipline.
    for (const def of DAEMON_MIGRATIONS) {
      expect(def.name).toMatch(/^\d{3}-/);
      expect(def.upSql.length).toBeGreaterThan(0);
    }
  });

  it("deduplicates identical versions across package lists (checksum-stable union)", () => {
    const combined = composeMigrationUnion([DAEMON_MIGRATIONS, DAEMON_MIGRATIONS]);
    expect(combined.versions).toEqual(DAEMON_MIGRATIONS.map((def) => def.version));
  });

  it("REFUSES a union where the same version carries different SQL", () => {
    expect(() =>
      composeMigrationUnion([
        [{ version: 18, name: "018-a", upSql: "CREATE TABLE a (id TEXT) STRICT;" }],
        [{ version: 18, name: "018-a", upSql: "CREATE TABLE b (id TEXT) STRICT;" }]
      ])
    ).toThrowError(MaintenanceError);
  });

  it("REFUSES a union where the same version carries a different name", () => {
    expect(() =>
      composeMigrationUnion([
        [{ version: 18, name: "018-a", upSql: "CREATE TABLE a (id TEXT) STRICT;" }],
        [{ version: 18, name: "018-aliased", upSql: "CREATE TABLE a (id TEXT) STRICT;" }]
      ])
    ).toThrowError(MaintenanceError);
  });

  it("checksums are deterministic across calls (the recorded schema_migrations contract)", () => {
    const first = daemonChainChecksums();
    const second = daemonChainChecksums();
    expect(first).toEqual(second);
    expect(first.filter((entry) => entry.version === 17)).toHaveLength(1);
  });
});
