/**
 * Migration discipline for M3-03's store delta:
 * - a fresh database applies 001..010 in order and verifies by checksum;
 * - migration 010 (the forward-only `bundle_fragments` rebuild) preserves
 *   every pre-existing M3-01 row byte-for-byte, then admits `memory`
 *   layer rows — rewriting the SHIPPED migration 007 was never an option
 *   (its checksum lives in schema_migrations), so this is the pattern;
 * - the staleness columns of 009 exist with their semantics enforced at
 *   the SQL layer where a CHECK exists and at the API layer elsewhere.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appliedMigrationRecords,
  applyMigrations,
  createProject,
  createTaskRun,
  openDatabase,
  verifyMigrations
} from "@role-orchestrator/store";
import { MEMORY_MIGRATIONS, memoryContentHash } from "@role-orchestrator/memory";
import { CONTEXT_MANIFEST_SCHEMA_VERSION, ContextBundleManifestSchema } from "@role-orchestrator/context";
import {
  MEMORY_SEARCH_MIGRATIONS,
  applyMemorySearchMigrations
} from "../src/index.js";
import { T0, removeTreeRobust } from "./helpers.js";

function scratch(): string {
  return mkdtempSync(path.join(os.tmpdir(), "ro-memory-search-mig-"));
}

describe("迁移链 001..010", () => {
  it("全新库按序应用十个迁移并通过校验和验证", async () => {
    const dir = scratch();
    const db = openDatabase(path.join(dir, "store.db"));
    try {
      const result = await applyMemorySearchMigrations(db, { now: T0 });
      expect(result.appliedVersions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      const records = appliedMigrationRecords(db);
      expect(records.map((record) => record.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(verifyMigrations(db, { migrations: MEMORY_SEARCH_MIGRATIONS }).ok).toBe(true);
      // Re-application is a no-op (idempotent), not a duplicate.
      const again = await applyMemorySearchMigrations(db, { now: T0 });
      expect(again.appliedVersions).toEqual([]);
    } finally {
      db.close();
      removeTreeRobust(dir);
    }
  });

  it("009 落下的列与审计表存在且语义正确", async () => {
    const dir = scratch();
    const db = openDatabase(path.join(dir, "store.db"));
    try {
      await applyMemorySearchMigrations(db, { now: T0 });
      createProject(db, {
        id: "proj-009",
        repoRoot: path.join(dir, "repo"),
        executionTarget: "windows-native",
        trustStatus: "untrusted",
        now: T0
      });
      const columns = (
        db.prepare("PRAGMA table_info(memories)").all() as { name: string }[]
      ).map((column) => column.name);
      for (const column of ["source_sha", "stale_since", "stale_reason"]) {
        expect(columns, column).toContain(column);
      }
      // The stale_reason CHECK holds at the SQL layer too.
      expect(() =>
        db
          .prepare(
            "INSERT INTO memories(id, project_id, scope, type, status, version, content, content_hash, evidence_refs, proposed_by, proposed_by_role, created_at, updated_at, stale_reason) " +
              "VALUES ('m1', 'proj-009', 'project', 'fact', 'proposed', 1, 'c', 'h', '[]', 'role:developer', 'developer', ?, ?, 'bogus-reason')"
          )
          .run(T0, T0)
      ).toThrow(/CHECK constraint failed/);
      const checkColumns = (
        db.prepare("PRAGMA table_info(memory_source_checks)").all() as { name: string }[]
      ).map((column) => column.name);
      expect(checkColumns).toEqual([
        "id",
        "project_id",
        "memory_id",
        "source_sha",
        "outcome",
        "observed_sha",
        "checked_at"
      ]);
    } finally {
      db.close();
      removeTreeRobust(dir);
    }
  });

  it("010 前向重建：既有 M3-01 片段行逐字节保留，memory 层随后可写", async () => {
    const dir = scratch();
    const db = openDatabase(path.join(dir, "store.db"));
    try {
      // Bring the database to 008 (the M3-02 world, migration 007's original
      // bundle_fragments intact), then store one M3-01-style bundle row.
      await applyMigrations(db, { migrations: MEMORY_MIGRATIONS, now: T0 });
      createProject(db, {
        id: "proj-mig",
        repoRoot: path.join(dir, "repo"),
        executionTarget: "windows-native",
        trustStatus: "untrusted",
        now: T0
      });
      createTaskRun(db, {
        id: "run-mig",
        projectId: "proj-mig",
        taskId: "task-mig",
        graphRevision: 0,
        configSnapshotHash: "snap",
        baseSha: "a".repeat(40),
        now: T0
      });
      const originalRow = {
        sequence: 0,
        layer: "dependency",
        sourceKind: "dependency_output",
        sourceId: "dep-node",
        sourceRevision: null as string | null,
        sourceProfileId: null as string | null,
        sourceCommitSha: "b".repeat(40),
        sourceArtifactId: null as string | null,
        included: 1,
        omittedReason: null as string | null,
        content: "body",
        contentHash: memoryContentHash("body"),
        contentBytes: 4
      };
      db.prepare(
        "INSERT INTO context_bundles(id, project_id, run_id, node_id, content_hash, manifest, manifest_hash, fragment_count, included_count, byte_count, budget_bytes, budget_exceeded, created_at) " +
          "VALUES ('ctx-mig', 'proj-mig', 'run-mig', 'node-mig', ?, ?, ?, 1, 1, 4, NULL, 0, ?)"
      ).run("0".repeat(64), JSON.stringify({ schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION }), "0".repeat(64), T0);
      db.prepare(
        "INSERT INTO bundle_fragments(bundle_id, sequence, layer, source_kind, source_id, source_revision, source_profile_id, source_commit_sha, source_artifact_id, included, omitted_reason, content, content_hash, content_bytes) " +
          "VALUES ('ctx-mig', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        originalRow.sequence,
        originalRow.layer,
        originalRow.sourceKind,
        originalRow.sourceId,
        originalRow.sourceRevision,
        originalRow.sourceProfileId,
        originalRow.sourceCommitSha,
        originalRow.sourceArtifactId,
        originalRow.included,
        originalRow.omittedReason,
        originalRow.content,
        originalRow.contentHash,
        originalRow.contentBytes
      );

      // Forward-only: apply 009+010 on top of the live 008 database.
      await applyMigrations(db, {
        migrations: MEMORY_SEARCH_MIGRATIONS,
        now: T0
      });

      const rows = db
        .prepare("SELECT * FROM bundle_fragments WHERE bundle_id = 'ctx-mig'")
        .all() as Record<string, unknown>[];
      expect(rows).toHaveLength(1);
      const row = rows[0] ?? {};
      expect(row["layer"]).toBe("dependency");
      expect(row["source_kind"]).toBe("dependency_output");
      expect(row["content"]).toBe("body");
      expect(row["content_hash"]).toBe(originalRow.contentHash);
      expect(row["source_commit_sha"]).toBe("b".repeat(40));

      // The widened table admits the memory layer with its provenance shape.
      db.prepare(
        "INSERT INTO bundle_fragments(bundle_id, sequence, layer, source_kind, source_id, source_revision, source_profile_id, source_commit_sha, source_artifact_id, included, omitted_reason, content, content_hash, content_bytes) " +
          "VALUES ('ctx-mig', 1, 'memory', 'memory_entry', 'fact-mig', '2', NULL, NULL, NULL, 1, NULL, 'memory body', ?, 11)"
      ).run(memoryContentHash("memory body"));
      // ...and still rejects a memory row with provenance that does not fit.
      expect(() =>
        db
          .prepare(
            "INSERT INTO bundle_fragments(bundle_id, sequence, layer, source_kind, source_id, source_revision, source_profile_id, source_commit_sha, source_artifact_id, included, omitted_reason, content, content_hash, content_bytes) " +
              "VALUES ('ctx-mig', 2, 'memory', 'memory_entry', 'fact-mig', '2', 'profile-should-not-exist', NULL, NULL, 1, NULL, 'x', ?, 1)"
          )
          .run(memoryContentHash("x"))
      ).toThrow(/CHECK constraint failed/);

      expect(verifyMigrations(db, { migrations: MEMORY_SEARCH_MIGRATIONS }).ok).toBe(true);
    } finally {
      db.close();
      removeTreeRobust(dir);
    }
  });

  it("manifest 的 memory 层条目解析回完整 provenance（往返）", () => {
    const fragment = {
      sequence: 4,
      layer: "memory" as const,
      trust: "untrusted-content" as const,
      source: {
        kind: "memory_entry" as const,
        id: "fact-1",
        revision: "2",
        profileId: null,
        commitSha: "c".repeat(40),
        artifactId: null
      },
      contentHash: "0".repeat(64),
      contentBytes: 12
    };
    const manifest = ContextBundleManifestSchema.parse({
      schemaVersion: CONTEXT_MANIFEST_SCHEMA_VERSION,
      bundleId: "ctx-rt",
      projectId: "proj-rt",
      runId: "run-rt",
      nodeId: "node-rt",
      roleId: "developer",
      budgetMethod: "estimated-bytes",
      budgetBytes: null,
      budgetExceeded: false,
      contentHash: "0".repeat(64),
      byteCount: 12,
      fragments: [fragment],
      omitted: [],
      omittedReasons: []
    });
    expect(manifest.fragments[0]?.layer).toBe("memory");
    expect(manifest.fragments[0]?.source.commitSha).toBe("c".repeat(40));
  });
});
