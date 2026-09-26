/**
 * PreparedInvocation assembly (docs/CLI_ADAPTERS.md "统一接口" prepare step).
 *
 * Everything here resolves from the FROZEN run profile snapshot
 * (`readRunRoleProfile`) plus explicitly injected inputs — never from a node
 * or task level override. The child process is described entirely by an argv
 * ARRAY; there is no shell string anywhere in the launch path.
 *
 * Executable form resolution (M0-05 process-lab findings):
 * - `*.js` / `*.mjs`  -> [node, script] (how the fake-cli dist bin runs);
 * - `*.cmd` / `*.bat` -> [cmd.exe, /d, /c, shim] on Windows only (Node
 *   refuses to spawn .cmd directly since CVE-2024-27980; `/s` must NOT be
 *   used because cmd strips the outer quotes and breaks on spaces);
 * - anything else     -> spawned directly (a real .exe / PATH command).
 */
import { existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { CapabilityName, PreparedInvocation, ProfileSnapshot } from "@role-orchestrator/contracts";
import { IdSchema, RoleIdSchema } from "@role-orchestrator/contracts";
import type { Dialect } from "@role-orchestrator/cli-events";
import { canonicalJson, sha256Hex } from "@role-orchestrator/runtime-profile";
import { readRunRoleProfile } from "@role-orchestrator/runtime-profile";
import type { DatabaseSync } from "node:sqlite";
import {
  ModelOverrideArgError,
  UnsupportedExecutableFormError,
  UnsupportedExecutionTargetError,
  WorkingDirectoryError
} from "./errors.js";

export type { Dialect };

/** The only execution target this engine's launcher implements. */
export const SUPPORTED_EXECUTION_TARGETS = ["windows-native"] as const;

export interface ExecutionCommand {
  /** argv[0] of the spawned child. */
  readonly command: string;
  /** Fixed arguments inserted before the caller/protocol arguments. */
  readonly prefix: readonly string[];
  readonly form: "node-script" | "cmd-shim" | "direct";
}

export function resolveExecutionCommand(
  executable: string,
  platform: NodeJS.Platform
): ExecutionCommand {
  const lowered = executable.toLowerCase();
  if (lowered.endsWith(".js") || lowered.endsWith(".mjs")) {
    return { command: process.execPath, prefix: [executable], form: "node-script" };
  }
  if (lowered.endsWith(".cmd") || lowered.endsWith(".bat")) {
    if (platform !== "win32") {
      throw new UnsupportedExecutableFormError(executable, platform);
    }
    return { command: "cmd.exe", prefix: ["/d", "/c", executable], form: "cmd-shim" };
  }
  return { command: executable, prefix: [], form: "direct" };
}

/**
 * Protocol arguments injected by the adapter itself (docs/CLI_ADAPTERS.md:
 * the adapter injects the authorized model and permission parameters; the
 * prompt enters via stdin, never as a shell-joined string). `requestedModel
 * === null` means "use the CLI default model" — no model flag is emitted.
 */
export function dialectProtocolArgs(
  dialect: Dialect,
  requestedModel: string | null
): readonly string[] {
  if (dialect === "claude") {
    const base = ["-p", "--output-format", "stream-json", "--verbose"];
    return requestedModel === null ? base : [...base, "--model", requestedModel];
  }
  const base = ["exec", "--json"];
  return requestedModel === null ? base : [...base, "-m", requestedModel];
}

const MODEL_OVERRIDE_FLAGS: readonly string[] = ["-m", "--model"];

/**
 * The invocation arguments are the caller's ONLY injection channel (scenario
 * selection, prompt files, resume ids — never a model). A model flag here
 * would be a hidden per-invocation override of the frozen profile, so it is
 * rejected by name before anything is written or spawned.
 */
export function assertNoModelOverrideArgs(args: readonly string[]): void {
  for (const arg of args) {
    if (MODEL_OVERRIDE_FLAGS.includes(arg)) {
      throw new ModelOverrideArgError(arg);
    }
  }
}

const PrepareExecutionInvocationInputSchema = z.strictObject({
  executionId: IdSchema,
  runId: IdSchema,
  roleId: RoleIdSchema,
  nodeId: IdSchema,
  attempt: z.number().int().min(1),
  /** Must be an existing directory; the child runs here and the stdin file lands here. */
  cwd: z.string().min(1).max(2048),
  /** Controlled task input written to the stdin file (never shell-joined). */
  prompt: z.string().max(1_048_576),
  /** Caller-provided non-model invocation arguments (argv array elements). */
  invocationArgs: z.array(z.string().min(1).max(4096)).max(64),
  /** Engine-side kill budget in seconds. Distinct from the profile contract bound. */
  timeoutSeconds: z.number().int().min(1).max(86400),
  /** Explicit evidence policy; defaults to the dialect default. */
  evidencePolicy: z.enum(["cited-artifact-ids", "any-artifact-reported"]).optional(),
  /** Injectable for tests; defaults to the host platform. */
  platform: z.enum(["win32", "linux", "darwin"]).optional()
});

export type PrepareExecutionInvocationInput = z.input<typeof PrepareExecutionInvocationInputSchema>;

export interface PreparedExecution {
  readonly executionId: string;
  readonly dialect: Dialect;
  readonly snapshot: ProfileSnapshot;
  /** The resolved argv[0] (node, cmd.exe or the executable itself). */
  readonly command: string;
  /** Full child argument vector: prefix + protocol args + invocation args. */
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdinFile: string;
  readonly manifestHash: string;
  readonly timeoutSeconds: number;
  readonly evidencePolicy: "cited-artifact-ids" | "any-artifact-reported";
  /**
   * The contracts `PreparedInvocation` view (executable + args split, no
   * runtime secrets). Kept as a field so downstream consumers see the frozen
   * contract shape, not the engine's extended view.
   */
  readonly invocation: PreparedInvocation;
}

/**
 * Resolve a prepared invocation from the frozen snapshot of (run, role).
 * Reads the snapshot, validates the execution target (A29 — no conversion),
 * resolves the executable form, assembles the argv array, writes the stdin
 * file and hashes everything into `manifestHash`. No database rows are
 * written: preparation failures leave no durable trace.
 */
export function prepareExecutionInvocation(
  db: DatabaseSync,
  input: PrepareExecutionInvocationInput
): PreparedExecution {
  const value = PrepareExecutionInvocationInputSchema.parse(input);
  const frozen = readRunRoleProfile(db, { runId: value.runId, roleId: value.roleId });
  const snapshot = frozen.snapshot;
  const platform = value.platform ?? process.platform;

  if (!(SUPPORTED_EXECUTION_TARGETS as readonly string[]).includes(snapshot.executionTarget)) {
    throw new UnsupportedExecutionTargetError(snapshot.executionTarget);
  }
  assertNoModelOverrideArgs(value.invocationArgs);
  if (!existsSync(value.cwd) || !statSync(value.cwd).isDirectory()) {
    throw new WorkingDirectoryError(value.cwd);
  }

  const dialect: Dialect = snapshot.runtime;
  const command = resolveExecutionCommand(snapshot.executable, platform);
  const protocolArgs = dialectProtocolArgs(dialect, snapshot.requestedModel);
  const argv: readonly string[] = [...command.prefix, ...protocolArgs, ...value.invocationArgs];

  const stdinFile = join(value.cwd, `stdin-${value.executionId}.prompt.txt`);
  writeFileSync(stdinFile, value.prompt, "utf8");

  const manifestObject = {
    schemaVersion: 1,
    executionId: value.executionId,
    runId: value.runId,
    roleId: value.roleId,
    nodeId: value.nodeId,
    attempt: value.attempt,
    snapshot: {
      id: snapshot.id,
      revision: snapshot.revision,
      hash: snapshot.hash,
      runtime: snapshot.runtime,
      executionTarget: snapshot.executionTarget,
      configDir: snapshot.configDir,
      requestedModel: snapshot.requestedModel
    },
    executable: command.command,
    argv,
    cwd: value.cwd,
    promptSha256: sha256Hex(value.prompt),
    timeoutSeconds: value.timeoutSeconds,
    evidencePolicy: value.evidencePolicy ?? defaultEvidencePolicy(dialect)
  };
  const manifestHash = sha256Hex(canonicalJson(manifestObject));

  const invocation: PreparedInvocation = {
    executable: command.command,
    args: argv,
    cwd: value.cwd,
    stdinFile,
    runtimeSecretRefs: [],
    manifestHash,
    timeoutSeconds: value.timeoutSeconds,
    requiredCapabilities: ["streaming", "structuredOutput"] satisfies readonly CapabilityName[]
  };

  return {
    executionId: value.executionId,
    dialect,
    snapshot,
    command: command.command,
    argv,
    cwd: value.cwd,
    stdinFile,
    manifestHash,
    timeoutSeconds: value.timeoutSeconds,
    evidencePolicy: manifestObject.evidencePolicy,
    invocation
  };
}

export function defaultEvidencePolicy(dialect: Dialect): "cited-artifact-ids" | "any-artifact-reported" {
  return dialect === "claude" ? "cited-artifact-ids" : "any-artifact-reported";
}
