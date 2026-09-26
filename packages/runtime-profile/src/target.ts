import { z } from "zod";
import { ExecutionTargetSchema, type ExecutionTarget } from "@role-orchestrator/contracts";
import { ExecutionTargetMismatchError } from "./errors.js";

/**
 * A29 — executionTarget consistency checks. Windows-native and WSL are
 * different process/path management worlds (REQUIREMENTS_BASELINE D07); a
 * mismatch is a typed PRE-execution error and is never implicitly converted.
 *
 * Path-form rules (fail-closed where worlds would mix):
 * - windows-native accepts win32 drive paths, non-WSL UNC paths and relative
 *   command names; a POSIX absolute path (/usr/bin/claude) is refused.
 * - wsl / linux-native / macos-native accept POSIX absolute paths and relative
 *   command names; a win32 drive path (C:\...) is refused.
 * - UNC paths into the WSL filesystem (\\wsl$..., \\wsl.localhost...) are a
 *   mixed-world view and are refused for EVERY target: windows-native must not
 *   reach into the WSL filesystem, and a wsl target expects in-WSL POSIX paths,
 *   not a Windows UNC view of them.
 * - Relative paths ("claude", "claude.cmd") are allowed for every target;
 *   PATH lookup happens inside the target's own world.
 */

export type PathForm = "win32-drive" | "unc" | "unc-wsl" | "posix-absolute" | "relative";

export function classifyPathForm(path: string): PathForm {
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    return "win32-drive";
  }
  if (/^\\\\/.test(path)) {
    return /^\\\\wsl(\$|\.localhost)/i.test(path) ? "unc-wsl" : "unc";
  }
  if (/^\//.test(path)) {
    return "posix-absolute";
  }
  return "relative";
}

const CheckExecutionTargetInputSchema = z.strictObject({
  /** The executionTarget the execution will run under (project / request). */
  projectTarget: ExecutionTargetSchema,
  /** The profile's own executionTarget. */
  profileTarget: ExecutionTargetSchema,
  /** Optional explicit request-side target (A29 "请求 target"). */
  requestTarget: ExecutionTargetSchema.optional(),
  /** Optional profile paths, checked for path-form mixing with the target. */
  executable: z.string().min(1).max(2048).optional(),
  configDir: z.string().min(1).max(2048).optional()
});

export interface CheckExecutionTargetInput {
  readonly projectTarget: ExecutionTarget;
  readonly profileTarget: ExecutionTarget;
  readonly requestTarget?: ExecutionTarget | undefined;
  readonly executable?: string | undefined;
  readonly configDir?: string | undefined;
}

const POSIX_ABSOLUTE_TARGETS: readonly ExecutionTarget[] = ["wsl", "linux-native", "macos-native"];

function checkPathForm(target: ExecutionTarget, field: string, path: string): void {
  const form = classifyPathForm(path);
  if (form === "unc-wsl") {
    throw new ExecutionTargetMismatchError(
      "path-form",
      target,
      form,
      field,
      `${field} "${path}" is a Windows UNC view of the WSL filesystem (\\\\wsl$...); ` +
        "mixed-world paths are refused for every execution target. Use the in-WSL POSIX path " +
        "for a wsl target, or a native path for a windows-native target."
    );
  }
  if (target === "windows-native" && form === "posix-absolute") {
    throw new ExecutionTargetMismatchError(
      "path-form",
      target,
      form,
      field,
      `${field} "${path}" is a POSIX absolute path but the execution target is windows-native; ` +
        "no implicit path conversion is performed (A29)"
    );
  }
  if (POSIX_ABSOLUTE_TARGETS.includes(target) && (form === "win32-drive" || form === "unc")) {
    throw new ExecutionTargetMismatchError(
      "path-form",
      target,
      form,
      field,
      `${field} "${path}" is a Windows ${form === "unc" ? "UNC" : "drive-letter"} path but the execution target is ${target}; ` +
        "no implicit path conversion is performed (A29)"
    );
  }
}

/**
 * Throws `ExecutionTargetMismatchError` when the profile target, the project
 * target or the optional explicit request target disagree, or when a provided
 * path's form does not belong to the target's world. Returns void on success.
 */
export function checkExecutionTarget(input: CheckExecutionTargetInput): void {
  const value = CheckExecutionTargetInputSchema.parse(input);

  if (value.requestTarget !== undefined && value.requestTarget !== value.projectTarget) {
    throw new ExecutionTargetMismatchError(
      "target-differ",
      value.projectTarget,
      value.requestTarget,
      "requestTarget",
      `request target "${value.requestTarget}" does not match project target "${value.projectTarget}"; ` +
        "no implicit target conversion is performed (A29)"
    );
  }
  if (value.profileTarget !== value.projectTarget) {
    throw new ExecutionTargetMismatchError(
      "target-differ",
      value.projectTarget,
      value.profileTarget,
      "profile.executionTarget",
      `profile executionTarget "${value.profileTarget}" does not match project executionTarget ` +
        `"${value.projectTarget}"; no implicit target conversion is performed (A29)`
    );
  }
  if (value.executable !== undefined) {
    checkPathForm(value.profileTarget, "executable", value.executable);
  }
  if (value.configDir !== undefined) {
    checkPathForm(value.profileTarget, "configDir", value.configDir);
  }
}
