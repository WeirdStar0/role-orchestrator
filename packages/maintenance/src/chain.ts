import { createHash } from "node:crypto";
import type { MigrationDefinition } from "@role-orchestrator/store";
import { migrationChecksum } from "@role-orchestrator/store";
import { RUNTIME_PROFILE_MIGRATIONS } from "@role-orchestrator/runtime-profile";
import { GRAPH_EXPANSION_MIGRATIONS } from "@role-orchestrator/dag";
import { SCHEDULER_MIGRATIONS } from "@role-orchestrator/scheduler";
import { INTEGRATION_MIGRATIONS } from "@role-orchestrator/integration";
import { REVIEW_MIGRATIONS } from "@role-orchestrator/review";
import { CONTEXT_MIGRATIONS } from "@role-orchestrator/context";
import { MEMORY_MIGRATIONS } from "@role-orchestrator/memory";
import { MEMORY_SEARCH_MIGRATIONS } from "@role-orchestrator/memory-search";
import { APPROVAL_MIGRATIONS } from "@role-orchestrator/approval";
import { CHECKPOINT_MIGRATIONS } from "@role-orchestrator/checkpoint";
import { CONTROLLED_EXPANSION_MIGRATIONS } from "@role-orchestrator/expand";
import { BUDGET_MIGRATIONS } from "@role-orchestrator/budget";
import { MaintenanceError } from "./errors.js";

/**
 * The daemon migration chain (M6-02).
 *
 * Every feature package ships its OWN composed list (001..N), so no single
 * package exports the whole chain the daemon actually runs. Composing two of
 * those lists naively — e.g. `[...a, ...b]` — is a hard error: the migration
 * runner rejects duplicated versions. This module provides the composition
 * primitive with the safety property the merge needs: versions that appear
 * in more than one list are allowed ONLY when their `upSql` (and therefore
 * their recorded checksum) is byte-identical and their name matches; a
 * conflict is a fatal MaintenanceError, never a silent pick of one side.
 *
 * `DAEMON_MIGRATIONS` is the union of every shipped list: 001..018 (018 = task_runs.outcome, M10-04), where 014
 * (budget) fills the gap the controlled-expansion chain deliberately leaves
 * to the budget package. This is the chain the recovery drill applies and
 * the chain cleanup validates the database against.
 */

export interface ComposedChain {
  readonly migrations: readonly MigrationDefinition[];
  /** Versions of the composed chain, ascending — convenient for asserts. */
  readonly versions: readonly number[];
}

/**
 * Union of migration lists, deduplicated by version. Duplicate versions must
 * carry byte-identical `upSql` AND the same name (the recorded `name` must
 * not depend on which list happened to win the merge).
 */
export function composeMigrationUnion(
  lists: readonly (readonly MigrationDefinition[])[]
): ComposedChain {
  const byVersion = new Map<number, MigrationDefinition>();
  for (const list of lists) {
    for (const def of list) {
      const existing = byVersion.get(def.version);
      if (existing === undefined) {
        byVersion.set(def.version, def);
        continue;
      }
      if (existing.upSql !== def.upSql || existing.name !== def.name) {
        throw new MaintenanceError(
          `migration union conflict at version ${String(def.version)}: "${existing.name}" vs "${def.name}" ` +
            "define different SQL for the same version; this is a chain-consistency bug"
        );
      }
    }
  }
  const migrations = [...byVersion.values()].sort((a, b) => a.version - b.version);
  return { migrations, versions: migrations.map((def) => def.version) };
}

// -- the shipped lists (each package composes its own prefix) -----------------
// Imported through each package's public entry point, exactly like the daemon
// would. A package renaming its list breaks THIS import loudly at build time,
// which is the point.

/**
 * Every shipped migration list, contributed to the union. Adding a package
 * with a new migration means adding its list here — the version-conflict
 * check then keeps the daemon chain honest.
 */
export function shippedMigrationLists(): readonly (readonly MigrationDefinition[])[] {
  return [
    RUNTIME_PROFILE_MIGRATIONS,
    GRAPH_EXPANSION_MIGRATIONS,
    SCHEDULER_MIGRATIONS,
    INTEGRATION_MIGRATIONS,
    REVIEW_MIGRATIONS,
    CONTEXT_MIGRATIONS,
    MEMORY_MIGRATIONS,
    MEMORY_SEARCH_MIGRATIONS,
    APPROVAL_MIGRATIONS,
    CHECKPOINT_MIGRATIONS,
    CONTROLLED_EXPANSION_MIGRATIONS,
    BUDGET_MIGRATIONS
  ];
}

/** The full daemon chain: 001..018, ascending, checksum-consistent. */
export const DAEMON_MIGRATIONS: readonly MigrationDefinition[] =
  composeMigrationUnion(shippedMigrationLists()).migrations;

/**
 * Highest version in the daemon chain (018 as of M10-04). New migrations
 * continue from here + 1 (019 upwards).
 */
export const DAEMON_CHAIN_MAX_VERSION: number = DAEMON_MIGRATIONS.reduce(
  (max, def) => Math.max(max, def.version),
  0
);

/** Convenience for runbook output: version -> checksum of the shipped chain. */
export function daemonChainChecksums(): readonly {
  readonly version: number;
  readonly checksum: string;
}[] {
  return DAEMON_MIGRATIONS.map((def) => ({
    version: def.version,
    checksum: migrationChecksum(def)
  }));
}

/** Stable short id for a cleanup item: kind + hash of its identity string. */
export function cleanupItemId(kind: string, identity: string): string {
  const hash = createHash("sha256").update(`${kind}\u0000${identity}`, "utf8").digest("hex");
  return `${kind}#${hash.slice(0, 12)}`;
}
