/**
 * Experiment 2 — Unicode + space paths and path-length limits (A28).
 *
 * - The full launcher chain (dist copy + `.cmd` shim + `call node`) runs from
 *   a scratch directory whose name contains CJK characters and spaces, with
 *   `cwd` set to that directory.
 * - Event-stream completeness: every stdout line parses as JSON, the stderr
 *   banner declares SYNTHETIC, and the final `result` line carries
 *   `is_error:false` plus a `structured_output` business payload.
 * - Argument passing through the shim: an unknown argument must be rejected
 *   by the fake CLI with exit code 2 (strict argv pass-through evidence).
 * - Path length: a deep directory chain pushing the target script path past
 *   the classic 260-char MAX_PATH limit — creation/copy/spawn behavior is
 *   recorded as observed (this part is observational, not a pass/fail gate).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fakeCliDistSource, installFakeCli } from "../fakecli.js";
import { findJsonValue } from "../lines.js";
import { driveOf, makeUnicodeScratchDir, removeScratch, type LabResult } from "../scratch.js";
import { writeCmdShim } from "../shim.js";
import { spawnCmdProcess } from "../spawnproc.js";

const DEEP_SEGMENTS = 7;
const DEEP_SEGMENT_NAME = "deep-path-segment-012345678901234567890123456789";

interface JsonLineCheck {
  readonly totalLines: number;
  readonly allJson: boolean;
  readonly bannerSynthetic: boolean;
  readonly finalResult: { readonly is_error: boolean; readonly hasStructuredOutput: boolean } | null;
}

function checkEventStream(stdoutLines: readonly string[], stderrLines: readonly string[]): JsonLineCheck {
  let allJson = true;
  let finalResult: JsonLineCheck["finalResult"] = null;
  for (const line of stdoutLines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        (parsed as Record<string, unknown>)["type"] === "result"
      ) {
        const record = parsed as Record<string, unknown>;
        finalResult = {
          is_error: record["is_error"] === true,
          hasStructuredOutput: findJsonValue(parsed, "structured_output") !== undefined
        };
      }
    } catch {
      allJson = false;
    }
  }
  return {
    totalLines: stdoutLines.length,
    allJson,
    bannerSynthetic: stderrLines.some((line) => line.includes("SYNTHETIC EVENT STREAM")),
    finalResult
  };
}

export async function runUnicodePathExperiment(): Promise<LabResult> {
  const repoDrive = driveOf(fakeCliDistSource());
  const tmpDrive = driveOf(os.tmpdir());
  const scratch = makeUnicodeScratchDir();
  let longPath: Record<string, unknown>;
  try {
    installFakeCli(scratch);
    const shim = writeCmdShim(scratch, "fake-claude.cmd", "fake-cli-dist\\bin\\fake-claude.js");

    // Success path from the Unicode+space directory (cwd set there too).
    const successRun = spawnCmdProcess(shim.path, ["--scenario", "success"], scratch);
    const successExit = await successRun.exit;
    successRun.stdout.finish();
    successRun.stderr.finish();
    const successCheck = checkEventStream(successRun.stdout.lines, successRun.stderr.lines);
    const successOk =
      successExit.code === 0 && successCheck.allJson && successCheck.bannerSynthetic &&
      successCheck.finalResult !== null && !successCheck.finalResult.is_error &&
      successCheck.finalResult.hasStructuredOutput;

    // Real-form flags accepted-and-ignored plus a positional: still exit 0.
    const realFormRun = spawnCmdProcess(
      shim.path,
      ["-p", "--output-format", "stream-json", "--model", "whatever", "--scenario", "success"],
      scratch
    );
    const realFormExit = await realFormRun.exit;
    realFormRun.stdout.finish();
    realFormRun.stderr.finish();

    // Unknown argument: strict rejection with exit code 2.
    const unknownRun = spawnCmdProcess(shim.path, ["--scenario", "success", "--definitely-not-a-flag"], scratch);
    const unknownExit = await unknownRun.exit;
    unknownRun.stdout.finish();
    unknownRun.stderr.finish();
    const argsOk = realFormExit.code === 0 && unknownExit.code === 2;

    // ---- Node fs-API health on the Unicode path (isolated child probes) ---
    const fsApiProbe = probeBrokenFsApis(scratch);

    // ---- Path length probe (observational) --------------------------------
    longPath = observeLongPath();

    return {
      ok: successOk && argsOk,
      scratchDirName: path.basename(scratch),
      scratchHasUnicodeAndSpace: path.basename(scratch).includes("中文") && path.basename(scratch).includes(" "),
      driveObservation: { repoDrive, tmpDrive, differentDrive: repoDrive !== tmpDrive },
      shimPath: shim.path,
      success: { exitCode: successExit.code, stream: successCheck, ok: successOk },
      realFormFlags: { argv: ["-p", "--output-format", "stream-json", "--model", "whatever", "--scenario", "success"], exitCode: realFormExit.code },
      unknownArg: { argv: ["--scenario", "success", "--definitely-not-a-flag"], exitCode: unknownExit.code },
      argsOk,
      fsApiProbe,
      longPath
    };
  } finally {
    removeScratch(scratch);
  }
}

function observeLongPath(): Record<string, unknown> {
  const base = path.join(os.tmpdir(), "process-lab-longpath");
  const deep = path.join(base, ...Array.from({ length: DEEP_SEGMENTS }, () => DEEP_SEGMENT_NAME));
  const observation: Record<string, unknown> = {
    attemptedPathLength: deep.length,
    maxPathReference: 260
  };
  let created = false;
  try {
    mkdirSync(deep, { recursive: true });
    created = true;
    observation["mkdir"] = "ok";
  } catch (error) {
    observation["mkdir"] = { error: (error as NodeJS.ErrnoException).code ?? String(error) };
  }
  if (created) {
    try {
      const fake = installFakeCli(deep, "dist");
      observation["copyDist"] = "ok (manual copy)";
      const deepBin = path.join(fake.distDir, "bin", "fake-claude.js");
      const run = spawnSync(process.execPath, [deepBin, "--scenario", "success"], {
        encoding: "utf8",
        timeout: 60_000,
        windowsHide: true
      });
      observation["spawn"] = {
        scriptPathLength: deepBin.length,
        error: run.error !== undefined ? ((run.error as NodeJS.ErrnoException).code ?? String(run.error)) : null,
        exitCode: run.status,
        stderrHead: (run.stderr ?? "").split(/\r?\n/).slice(0, 3).join(" / ")
      };
    } catch (error) {
      observation["copyDist"] = { error: (error as NodeJS.ErrnoException).code ?? String(error) };
    }
  }
  removeScratch(base);
  return observation;
}

function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    if (statSync(entryPath).isDirectory()) count += countFiles(entryPath);
    else count += 1;
  }
  return count;
}

/**
 * Runs one fs call inside a disposable child process. Needed because the
 * broken APIs can kill the calling process outright (silent exit 9).
 */
function childProbe(script: string): { exitCode: number | null; stderrHead: string } {
  const run = spawnSync(process.execPath, ["-e", script], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
  return {
    exitCode: run.status,
    stderrHead: (run.stderr ?? "").split(/\r?\n/).filter((line) => line !== "").slice(0, 2).join(" / ")
  };
}

/**
 * Measures the Node 25.0.0/win32 fs-API breakage on a Unicode path with
 * child-process isolation: cpSync (recursive) and rmSync (per-file).
 * The verified-primitives manual copy in installFakeCli is the workaround.
 */
function probeBrokenFsApis(scratch: string): Record<string, unknown> {
  const source = fakeCliDistSource();
  const sourceCount = countFiles(source);

  const cpTarget = path.join(scratch, "cp-sync-probe");
  const cpProbe = childProbe(
    `require('node:fs').cpSync(${JSON.stringify(source)}, ${JSON.stringify(cpTarget)}, { recursive: true });`
  );
  const cpCopiedFiles = existsSync(cpTarget) ? countFiles(cpTarget) : null;

  const victim = path.join(scratch, "rm-victim.txt");
  writeFileSync(victim, "x", "utf8");
  const rmProbe = childProbe(`require('node:fs').rmSync(${JSON.stringify(victim)});`);
  const victimStillExists = existsSync(victim);

  return {
    sourceFileCount: sourceCount,
    cpSyncRecursive: {
      childExitCode: cpProbe.exitCode,
      childExitCodeHex: cpProbe.exitCode === null ? null : `0x${(cpProbe.exitCode >>> 0).toString(16).toUpperCase()}`,
      childStderrHead: cpProbe.stderrHead,
      copiedFiles: cpCopiedFiles,
      silentNoOp: cpProbe.exitCode === 0 && cpCopiedFiles === 0,
      crashed: cpProbe.exitCode === 9 || cpProbe.exitCode === 3221226505
    },
    rmSyncPerFile: {
      childExitCode: rmProbe.exitCode,
      childExitCodeHex: rmProbe.exitCode === null ? null : `0x${(rmProbe.exitCode >>> 0).toString(16).toUpperCase()}`,
      childStderrHead: rmProbe.stderrHead,
      victimStillExists,
      silentNoOp: rmProbe.exitCode === 0 && victimStillExists
    },
    note: "cpSync/rmSync are unreliable on non-ASCII paths (Node 25.0.0, win32); process-lab uses mkdirSync/copyFileSync/unlinkSync/rmdirSync walks instead"
  };
}
