/**
 * Typed error taxonomy for @role-orchestrator/maintenance (M6-02).
 *
 * Mirrors the repo convention (types errors + `cause`): every refusal names
 * the object, the policy that refused it, and never guesses a successful
 * outcome. Cleanup refusals are RESULTS (receipt rows), not exceptions —
 * exceptions here are for preconditions the API cannot proceed under.
 */
export class MaintenanceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MaintenanceError";
  }
}

/**
 * The database does not have the schema the maintenance operation requires.
 * `missingMigrations` names the versions whose tables are absent; the fix is
 * to run the composed migration chain — never to drop the checks.
 */
export class DatabaseSchemaError extends MaintenanceError {
  readonly missingMigrations: readonly number[];

  constructor(missingMigrations: readonly number[], options?: { cause?: unknown }) {
    super(
      `database schema is missing required migrations (${missingMigrations.map(String).join(", ")}); ` +
        "apply the composed daemon migration chain before running maintenance",
      options
    );
    this.name = "DatabaseSchemaError";
    this.missingMigrations = missingMigrations;
  }
}

/**
 * executeCleanup was called with require-confirm items but the matching
 * explicit confirmation ids were not passed. This is the A40 gate: nothing
 * runs, and the error lists exactly which item ids need a human decision.
 */
export class CleanupConfirmationRequiredError extends MaintenanceError {
  readonly itemIds: readonly string[];

  constructor(itemIds: readonly string[]) {
    super(
      `cleanup plan ${String(itemIds.length)} item(s) require explicit confirmation; ` +
        `pass their item ids via confirmations: ${itemIds.join(", ")}`
    );
    this.name = "CleanupConfirmationRequiredError";
    this.itemIds = itemIds;
  }
}

/** A confirmation id in executeCleanup does not exist in the plan. */
export class UnknownCleanupItemError extends MaintenanceError {
  readonly itemId: string;

  constructor(itemId: string) {
    super(`confirmation references unknown cleanup item id "${itemId}"`);
    this.name = "UnknownCleanupItemError";
    this.itemId = itemId;
  }
}

/**
 * The object changed between planCleanup and executeCleanup (deleted
 * elsewhere, state transitioned, new uncommitted changes appeared). The item
 * is skipped and must be re-planned — never cleaned on stale information.
 */
export class CleanupTargetChangedError extends MaintenanceError {
  readonly itemId: string;
  readonly target: string;

  constructor(itemId: string, target: string, detail: string, options?: { cause?: unknown }) {
    super(
      `cleanup target changed since the plan was built ("${target}"): ${detail}; re-plan before cleaning`,
      options
    );
    this.name = "CleanupTargetChangedError";
    this.itemId = itemId;
    this.target = target;
  }
}

/** The recovery drill's own invariants failed — a drill bug, not an ops event. */
export class RecoveryDrillError extends MaintenanceError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`upgrade-recovery drill invariant violated: ${message}`, options);
    this.name = "RecoveryDrillError";
  }
}
