/**
 * End-to-end tests over spawned fake-cli processes (A05/A06 directions plus
 * the timeout / interrupt / grandchild behaviors):
 * - outcomes are computed from real subprocess stdout and exit codes;
 * - the timeout scenario never exits on its own and is killed externally;
 * - the interrupt scenario flushes a partial stream and exits nonzero
 *   (SIGTERM on POSIX; stdin EOF on Windows where Node cannot deliver
 *   catchable signals to a child);
 * - the grandchild scenario reports child+grandchild PIDs and the whole tree
 *   dies after `taskkill /T /F` (Windows) / process-group SIGKILL (POSIX).
 */
import { describe, expect, test } from "vitest";
import { EventStreamPipeline, evaluateOutcome, type StreamResult } from "../src/index.js";
import {
  expectPidDead,
  findJsonValue,
  killTree,
  spawnFake,
  waitForLine,
  withTimeout,
  type FakeDialect,
  type FakeRun
} from "./helpers.js";

const WAIT_MS = 30_000;

/** Defensive: newer Node typings model child.pid as number | undefined. */
function requiredPid(child: FakeRun["child"]): number {
  const pid = child.pid;
  if (pid === undefined) throw new Error("child pid unavailable (spawn failed)");
  return pid;
}

async function settle(run: FakeRun): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const info = await withTimeout(run.exit, WAIT_MS, "fake process exit");
  run.stdout.finish();
  run.stderr.finish();
  return info;
}

async function ensureTerminated(run: FakeRun): Promise<void> {
  if (run.child.exitCode === null && run.child.signalCode === null) {
    await killTree(requiredPid(run.child));
    await withTimeout(run.exit, WAIT_MS, "cleanup kill").catch(() => {});
  }
}

function streamFromLines(dialect: FakeDialect, lines: readonly string[]): StreamResult {
  const pipeline = new EventStreamPipeline({ dialect, executionId: "exec_e2e" });
  pipeline.feedStdout(lines.join("\n"));
  return pipeline.finalize();
}

describe("spawned fake-cli end to end", () => {
  test(
    "success scenario: exit 0 with a final result judges business success",
    { timeout: 90_000 },
    async () => {
      for (const dialect of ["claude", "codex"] as const) {
        const run = spawnFake(dialect, ["--scenario", "success"]);
        try {
          const info = await settle(run);
          expect(info.code, `${dialect} exit`).toBe(0);
          const verdict = evaluateOutcome(streamFromLines(dialect, run.stdout.lines), {
            exitCode: info.code
          });
          expect(verdict.success, `${dialect} outcome`).toBe(true);
        } finally {
          await ensureTerminated(run);
        }
      }
    }
  );

  test(
    "error-result scenario: nonzero exit and error-marked final result",
    { timeout: 90_000 },
    async () => {
      for (const dialect of ["claude", "codex"] as const) {
        const run = spawnFake(dialect, ["--scenario", "error-result"]);
        try {
          const info = await settle(run);
          expect(info.code, `${dialect} exit`).toBe(1);
          const verdict = evaluateOutcome(streamFromLines(dialect, run.stdout.lines), {
            exitCode: info.code
          });
          expect(verdict.success).toBe(false);
          expect([...verdict.reasons]).toEqual(["nonzero-exit", "final-result-error"]);
        } finally {
          await ensureTerminated(run);
        }
      }
    }
  );

  test(
    "A06: fake-success (error-final) exits 0 but the outcome is not success",
    { timeout: 90_000 },
    async () => {
      for (const dialect of ["claude", "codex"] as const) {
        const run = spawnFake(dialect, ["--scenario", "fake-success"]);
        try {
          const info = await settle(run);
          expect(info.code, `${dialect} exit must be 0 (the trap)`).toBe(0);
          const verdict = evaluateOutcome(streamFromLines(dialect, run.stdout.lines), {
            exitCode: info.code
          });
          expect(verdict.success, `${dialect} must not be judged successful`).toBe(false);
          expect(verdict.reasons).toContain("final-result-error");
        } finally {
          await ensureTerminated(run);
        }
      }
    }
  );

  test(
    "A06: fake-success (missing-final) exits 0 without a final result event",
    { timeout: 90_000 },
    async () => {
      for (const dialect of ["claude", "codex"] as const) {
        const run = spawnFake(dialect, ["--scenario", "fake-success", "--variant", "missing-final"]);
        try {
          const info = await settle(run);
          expect(info.code).toBe(0);
          const verdict = evaluateOutcome(streamFromLines(dialect, run.stdout.lines), {
            exitCode: info.code
          });
          expect(verdict.success).toBe(false);
          expect([...verdict.reasons]).toEqual(["missing-final-result"]);
        } finally {
          await ensureTerminated(run);
        }
      }
    }
  );

  test(
    "A05: truncated scenario exits 0 yet is an explicit protocol failure",
    { timeout: 90_000 },
    async () => {
      for (const dialect of ["claude", "codex"] as const) {
        const run = spawnFake(dialect, ["--scenario", "truncated"]);
        try {
          const info = await settle(run);
          expect(info.code, `${dialect} trap exit`).toBe(0);
          const result = streamFromLines(dialect, run.stdout.lines);
          expect(result.protocolErrors.map((error) => error.kind)).toContain("unterminated-json");
          const verdict = evaluateOutcome(result, { exitCode: info.code });
          expect(verdict.success).toBe(false);
          expect(verdict.reasons).toContain("protocol-error");
        } finally {
          await ensureTerminated(run);
        }
      }
    }
  );

  test(
    "timeout scenario: partial stream, never self-exits, dies on external termination",
    { timeout: 90_000 },
    async () => {
      for (const dialect of ["claude", "codex"] as const) {
        const run = spawnFake(dialect, ["--scenario", "timeout"]);
        try {
          await waitForLine(
            run.stdout,
            () => run.stdout.lines.length >= 2,
            WAIT_MS,
            `${dialect} timeout scenario partial stream`
          );

          // Hold check: the process must still be running after a grace window.
          const stillRunning = await new Promise<boolean>((resolve) => {
            const timer = setTimeout(() => resolve(true), 2_000);
            run.child.once("exit", () => {
              clearTimeout(timer);
              resolve(false);
            });
          });
          expect(stillRunning, `${dialect} timeout scenario must hang until killed`).toBe(true);

          await killTree(requiredPid(run.child));
          const info = await withTimeout(run.exit, WAIT_MS, `${dialect} timeout kill`);
          expect(info.code === 0, `${dialect} must not exit cleanly`).toBe(false);

          const verdict = evaluateOutcome(streamFromLines(dialect, run.stdout.lines), {
            exitCode: null
          });
          expect(verdict.success).toBe(false);
          expect(verdict.reasons).toContain("nonzero-exit");
        } finally {
          await ensureTerminated(run);
        }
      }
    }
  );

  const interruptCases: ReadonlyArray<{ mode: "signal" | "stdin-close"; exitCode: number }> =
    process.platform === "win32"
      ? [{ mode: "stdin-close", exitCode: 130 }]
      : [
          { mode: "signal", exitCode: 143 },
          { mode: "stdin-close", exitCode: 130 }
        ];

  for (const item of interruptCases) {
    test(
      `interrupt scenario (${item.mode}): partial stream flushed, nonzero exit`,
      { timeout: 90_000 },
      async () => {
        for (const dialect of ["claude", "codex"] as const) {
          const run = spawnFake(dialect, [
            "--scenario",
            "interrupt",
            "--interrupt-on",
            item.mode
          ]);
          try {
            // Deterministic handshake: only trigger once handlers are armed.
            await waitForLine(
              run.stderr,
              (line) => line.includes("interrupt handlers armed"),
              WAIT_MS,
              `${dialect} interrupt armed banner`
            );
            await waitForLine(
              run.stdout,
              () => run.stdout.lines.length >= 2,
              WAIT_MS,
              `${dialect} interrupt partial stream`
            );

            if (item.mode === "signal") {
              run.child.kill("SIGTERM");
            } else {
              run.child.stdin.end();
            }

            const info = await withTimeout(run.exit, WAIT_MS, `${dialect} interrupt exit`);
            expect(info.code, `${dialect} graceful interrupt exit code`).toBe(item.exitCode);

            // The graceful path flushed an extra interrupt delta line.
            const interruptLine = run.stdout.lines.find((line) => line.includes("interrupted"));
            expect(interruptLine, `${dialect} interrupt delta must be flushed`).toBeDefined();

            const verdict = evaluateOutcome(streamFromLines(dialect, run.stdout.lines), {
              exitCode: info.code
            });
            expect(verdict.success).toBe(false);
            expect(verdict.reasons).toContain("nonzero-exit");
            expect(verdict.reasons).toContain("missing-final-result");
          } finally {
            await ensureTerminated(run);
          }
        }
      }
    );
  }

  for (const dialect of ["claude", "codex"] as const) {
    test(
      `grandchild scenario (${dialect}): reports both PIDs, tree dies after external kill`,
      { timeout: 120_000 },
      async () => {
        const run = spawnFake(dialect, ["--scenario", "grandchild"]);
        try {
          const reportLine = await waitForLine(
            run.stdout,
            (line) => line.includes("grandchildPid"),
            WAIT_MS,
            `${dialect} grandchild PID report event`
          );

          const parsed: unknown = JSON.parse(reportLine);
          const childPid = findJsonValue(parsed, "childPid");
          const grandchildPid = findJsonValue(parsed, "grandchildPid");
          expect(typeof childPid).toBe("number");
          expect(typeof grandchildPid).toBe("number");
          expect(childPid).not.toBe(run.child.pid);
          expect(grandchildPid).not.toBe(childPid);

          // The normalized stream carries the PIDs too.
          const normalized = streamFromLines(dialect, [reportLine]).events;
          expect(normalized.length).toBeGreaterThan(0);
          expect(findJsonValue(normalized, "grandchildPid")).toBe(grandchildPid);

          await killTree(requiredPid(run.child));
          const info = await withTimeout(run.exit, WAIT_MS, `${dialect} grandchild root kill`);
          expect(info.code === 0, `${dialect} root must not exit cleanly`).toBe(false);

          // The whole tree must be gone: child and grandchild.
          await expectPidDead(childPid as number);
          await expectPidDead(grandchildPid as number);
        } finally {
          await ensureTerminated(run);
        }
      }
    );
  }

  test("child and grandchild processes are separate live processes before the kill", { timeout: 90_000 }, async () => {
    // Sanity for the tree-death assertions: while the root lives, so do the
    // spawned descendants (existence check via signal 0).
    const run = spawnFake("claude", ["--scenario", "grandchild"]);
    try {
      const reportLine = await waitForLine(
        run.stdout,
        (line) => line.includes("grandchildPid"),
        WAIT_MS,
        "grandchild PID report event"
      );
      const parsed: unknown = JSON.parse(reportLine);
      const childPid = findJsonValue(parsed, "childPid") as number;
      const grandchildPid = findJsonValue(parsed, "grandchildPid") as number;
      expect(() => process.kill(childPid, 0)).not.toThrow();
      expect(() => process.kill(grandchildPid, 0)).not.toThrow();
    } finally {
      await ensureTerminated(run);
    }
  });
});
