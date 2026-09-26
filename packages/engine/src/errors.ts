/**
 * Typed error taxonomy for @role-orchestrator/engine.
 *
 * Errors here mean "the requested execution could not be prepared, launched
 * or accounted for" — never a guessed outcome. Preparation errors are thrown
 * BEFORE any database row exists (nothing durable to clean up); post-launch
 * failures are persisted to the store first (FAILED + lifecycle event +
 * outbox) and only then surfaced to the caller. Store-level failures keep
 * their own typed errors (`ActiveAttemptConflictError`, `NoRowUpdatedError`,
 * ...).
 */
export class EngineError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EngineError";
  }
}

/** Base for every failure detected while assembling a PreparedInvocation. */
export class LaunchPreparationError extends EngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LaunchPreparationError";
  }
}

/**
 * A29: the frozen snapshot's executionTarget is not supported by this
 * engine's launcher (currently windows-native only). Refused up front — no
 * implicit target or path conversion is ever attempted.
 */
export class UnsupportedExecutionTargetError extends LaunchPreparationError {
  readonly target: string;

  constructor(target: string) {
    super(
      `execution target "${target}" is not supported by the launcher; ` +
        "only windows-native is implemented — refusing instead of converting (A29)"
    );
    this.name = "UnsupportedExecutionTargetError";
    this.target = target;
  }
}

/**
 * The executable's file form cannot be launched on this platform (for
 * example a `.cmd` shim on POSIX, where cmd.exe does not exist).
 */
export class UnsupportedExecutableFormError extends LaunchPreparationError {
  readonly executable: string;
  readonly platform: string;

  constructor(executable: string, platform: string) {
    super(
      `executable "${executable}" is a Windows cmd shim and cannot be launched on platform "${platform}"`
    );
    this.name = "UnsupportedExecutableFormError";
    this.executable = executable;
    this.platform = platform;
  }
}

/**
 * The caller tried to smuggle a model-selection flag through the invocation
 * arguments. Model selection comes from the frozen profile snapshot alone —
 * this is the process-level cousin of the A02 guard.
 */
export class ModelOverrideArgError extends LaunchPreparationError {
  readonly arg: string;

  constructor(arg: string) {
    super(
      `invocation argument "${arg}" is a model-selection flag; the model comes from ` +
        "the frozen profile snapshot and cannot be overridden per invocation"
    );
    this.name = "ModelOverrideArgError";
    this.arg = arg;
  }
}

/** The `cwd` for the prepared invocation does not exist or is not a directory. */
export class WorkingDirectoryError extends LaunchPreparationError {
  readonly cwd: string;

  constructor(cwd: string) {
    super(`working directory "${cwd}" does not exist or is not a directory`);
    this.name = "WorkingDirectoryError";
    this.cwd = cwd;
  }
}

/**
 * A dispatch token was reused for a different attempt row. The unique index
 * on `executions.dispatch_token` backs this: a restarted dispatcher must find
 * the existing attempt via `getExecutionByDispatchToken` instead of launching
 * a second writer (A24).
 */
export class DispatchTokenReusedError extends EngineError {
  readonly dispatchToken: string;

  constructor(dispatchToken: string, options?: { cause?: unknown }) {
    super(
      `dispatch token "${dispatchToken}" is already recorded on another attempt; ` +
        "look the attempt up by dispatch token instead of launching again (A24)",
      options
    );
    this.name = "DispatchTokenReusedError";
    this.dispatchToken = dispatchToken;
  }
}

/**
 * The caller asked the engine to launch an ALREADY-CLAIMED attempt
 * (`claimedAttempt: true`, the scheduler-dispatch composition), but the
 * durable attempt row does not match the launch order: missing row, wrong
 * phase, or a dispatch token / slot identity that does not belong to this
 * execution. The launcher refuses instead of guessing — the dispatch token is
 * the dedup anchor (A24), so a mismatched claim never spawns a process.
 */
export class ClaimedAttemptInvalidError extends EngineError {
  readonly executionId: string;

  constructor(executionId: string, detail: string) {
    super(
      `claimed attempt "${executionId}" cannot be launched: ${detail}; ` +
        "the scheduler's claim row (phase STARTING) must match the launch order exactly",
    );
    this.name = "ClaimedAttemptInvalidError";
    this.executionId = executionId;
  }
}

/**
 * The spawned process failed to start (ENOENT, missing cwd, ...). This error
 * is only surfaced AFTER the attempt has been persisted as FAILED with a
 * lifecycle event, so the launch failure is always traceable.
 */
export class ExecutionLaunchError extends EngineError {
  readonly executionId: string;

  constructor(executionId: string, message: string, options?: { cause?: unknown }) {
    super(`execution "${executionId}" failed to launch: ${message}`, options);
    this.name = "ExecutionLaunchError";
    this.executionId = executionId;
  }
}
