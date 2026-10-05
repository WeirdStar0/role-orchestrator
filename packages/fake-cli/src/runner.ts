/**
 * Executes scenario frames against the real process: writes protocol lines to
 * stdout, noise to stderr, spawns the child/grandchild chain, arms the
 * interrupt handlers, and finally exits with the scenario's exit code.
 *
 * Every stdout write waits for its completion callback and the final exit is
 * delayed by a small grace period — on Windows, pipes are async and
 * process.exit() can otherwise drop buffered output.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenarioFrames, grandchildReportLine, interruptDeltaLine, type Frame } from "./scenarios.js";
import type { Dialect } from "./events.js";

const FLUSH_GRACE_MS = 150;
const CHAIN_REPORT_TIMEOUT_MS = 30_000;

export interface RunOptions {
  readonly dialect: Dialect;
  readonly scenario: Parameters<typeof buildScenarioFrames>[0]["scenario"];
  readonly variant?: string | undefined;
  readonly delayMs: number;
  readonly interruptOn: "signal" | "stdin-close";
  /** M4-02 `action-proposal` only: path embedded in the emitted proposal. */
  readonly proposeWritePath?: string | undefined;
  /** M10-03 `review` only: relative path whose presence decides the verdict. */
  readonly reviewExistsPath?: string | undefined;
}

function writeLine(line: string, truncatedTail: boolean): Promise<void> {
  const text = truncatedTail ? line : `${line}\n`;
  return new Promise((resolve, reject) => {
    process.stdout.write(text, "utf8", (err) => (err === null ? resolve() : reject(err)));
  });
}

function writeStderr(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.stderr.write(text, "utf8", (err) => (err === null ? resolve() : reject(err)));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Keeps the event loop alive for hold/arm frames. */
function keepAlive(): NodeJS.Timeout {
  return setInterval(() => {}, 3_600_000);
}

/** Schedules termination with a grace period so pending stdout bytes drain. */
function flushExit(code: number): void {
  setTimeout(() => process.exit(code), FLUSH_GRACE_MS);
}

interface ChainReport {
  readonly childPid: number;
  readonly grandchildPid: number;
}

/**
 * Spawns child -> grandchild; the child reports both PIDs through a temp
 * file (no console/IPC coupling). The report stays in the OS temp dir — the
 * fake process may be SIGKILLed and never gets to clean it up.
 */
async function spawnChainAndWait(): Promise<ChainReport> {
  const childJs = fileURLToPath(new URL("./grandchild/child.js", import.meta.url));
  const reportPath = path.join(os.tmpdir(), `fake-cli-chain-${process.pid}-${Date.now()}.json`);
  const child = spawn(process.execPath, [childJs, "--report-file", reportPath], {
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true
  });
  const deadline = Date.now() + CHAIN_REPORT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (existsSync(reportPath)) {
      const parsed: unknown = JSON.parse(readFileSync(reportPath, "utf8"));
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error("spawn-chain report is not an object");
      }
      const record = parsed as Record<string, unknown>;
      if (typeof record["childPid"] !== "number" || typeof record["grandchildPid"] !== "number") {
        throw new Error("spawn-chain report is missing numeric PIDs");
      }
      return { childPid: record["childPid"], grandchildPid: record["grandchildPid"] };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`spawn-chain child exited early (exitCode=${String(child.exitCode)})`);
    }
    await sleep(50);
  }
  throw new Error("timed out waiting for the spawn-chain report file");
}

/**
 * Arms the graceful interrupt path and never returns: the process exits from
 * inside the trigger. On POSIX the real SIGINT/SIGTERM arrive via signals; on
 * Windows, Node cannot deliver catchable SIGINT/SIGTERM to a child process
 * (kill() maps to TerminateProcess), so `--interrupt-on stdin-close` provides
 * the same graceful path through stdin EOF.
 */
async function armInterrupt(dialect: Dialect, interruptOn: "signal" | "stdin-close"): Promise<never> {
  keepAlive();
  const line = interruptDeltaLine(dialect);
  let fired = false;
  const trigger = (exitCode: number): void => {
    if (fired) return;
    fired = true;
    writeLine(line, false)
      .catch(() => {})
      .finally(() => {
        flushExit(exitCode);
      });
  };
  process.once("SIGINT", () => trigger(130));
  process.once("SIGTERM", () => trigger(143));
  if (interruptOn === "stdin-close") {
    process.stdin.resume();
    process.stdin.once("end", () => trigger(130));
  }
  // Deterministic handshake: tests wait for this line before triggering, so
  // the trigger can never race the handler installation.
  await writeStderr(`SYNTHETIC fake-${dialect}: interrupt handlers armed (mode=${interruptOn})\n`).catch(
    () => {}
  );
  return new Promise<never>(() => {});
}

/** Runs one scenario to completion. Returns the exit code for self-exit paths. */
export async function runScenario(opts: RunOptions): Promise<number> {
  const frames: readonly Frame[] = buildScenarioFrames({
    dialect: opts.dialect,
    scenario: opts.scenario,
    variant: opts.variant,
    delayMs: opts.delayMs,
    proposeWritePath: opts.proposeWritePath,
    reviewExistsPath: opts.reviewExistsPath
  });
  let chainReport: ChainReport | undefined;
  for (const frame of frames) {
    switch (frame.kind) {
      case "stderr":
        await writeStderr(`${frame.text}\n`);
        break;
      case "stdout":
        await writeLine(frame.line, frame.truncatedTail === true);
        break;
      case "wait":
        await sleep(frame.ms);
        break;
      case "spawn-chain":
        chainReport = await spawnChainAndWait();
        break;
      case "grandchild-report": {
        if (chainReport === undefined) {
          throw new Error("grandchild-report frame reached without a spawn-chain report");
        }
        await writeLine(
          grandchildReportLine(opts.dialect, chainReport.childPid, chainReport.grandchildPid),
          false
        );
        break;
      }
      case "arm-interrupt":
        await armInterrupt(opts.dialect, opts.interruptOn);
        break;
      case "hold": {
        keepAlive();
        await new Promise<never>(() => {});
        break;
      }
      case "exit": {
        flushExit(frame.code);
        await new Promise<never>(() => {});
        break;
      }
      default: {
        const never: never = frame;
        throw new Error(`unknown frame: ${JSON.stringify(never)}`);
      }
    }
  }
  return 0;
}

export { grandchildReportLine };
