/**
 * Spawns the built bins for every quick (self-exiting) scenario and asserts
 * exit codes, the SYNTHETIC stderr banner, and the synthetic marker on every
 * stdout line. The long-running scenarios (timeout, interrupt, grandchild)
 * are covered by the cli-events end-to-end tests.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageDir, "dist");

function binPath(dialect: "claude" | "codex"): string {
  const p = path.join(distDir, "bin", dialect === "claude" ? "fake-claude.js" : "fake-codex.js");
  if (!existsSync(p)) {
    throw new Error(`fake-cli is not built; run "pnpm build" first (missing ${p})`);
  }
  return p;
}

interface SpawnResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutLines: readonly string[];
  readonly stderrText: string;
}

function runBin(
  dialect: "claude" | "codex",
  args: readonly string[],
  timeoutMs = 30_000
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath(dialect), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    const decoder = new StringDecoder("utf8");
    let stdoutBuffer = "";
    const lines: string[] = [];
    let stderrText = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`fake-${dialect} did not exit within ${timeoutMs}ms (args: ${args.join(" ")})`));
      }
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBuffer += decoder.write(chunk);
      let index = stdoutBuffer.indexOf("\n");
      while (index >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        if (line.trim() !== "") lines.push(line);
        index = stdoutBuffer.indexOf("\n");
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrText += String(chunk);
    });
    child.once("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.once("exit", (code, signal) => {
      const tail = stdoutBuffer + decoder.end();
      if (tail.trim() !== "") lines.push(tail);
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, signal, stdoutLines: lines, stderrText });
      }
    });
  });
}

interface MatrixCase {
  readonly dialect: "claude" | "codex";
  readonly args: readonly string[];
  readonly expectedExit: number;
  readonly label: string;
}

const CASES: readonly MatrixCase[] = [
  { dialect: "claude", args: ["--scenario", "success"], expectedExit: 0, label: "success" },
  { dialect: "claude", args: ["--scenario", "error-result"], expectedExit: 1, label: "error-result" },
  { dialect: "claude", args: ["--scenario", "truncated"], expectedExit: 0, label: "truncated" },
  { dialect: "claude", args: ["--scenario", "fake-success"], expectedExit: 0, label: "fake-success(error-final)" },
  {
    dialect: "claude",
    args: ["--scenario", "fake-success", "--variant", "missing-final"],
    expectedExit: 0,
    label: "fake-success(missing-final)"
  },
  {
    dialect: "claude",
    args: ["--scenario", "fake-success", "--variant", "schema-invalid"],
    expectedExit: 0,
    label: "fake-success(schema-invalid)"
  },
  { dialect: "codex", args: ["exec", "--json", "--scenario", "success"], expectedExit: 0, label: "success" },
  { dialect: "codex", args: ["--scenario", "error-result"], expectedExit: 1, label: "error-result" },
  { dialect: "codex", args: ["--scenario", "truncated"], expectedExit: 0, label: "truncated" },
  { dialect: "codex", args: ["--scenario", "fake-success"], expectedExit: 0, label: "fake-success(error-final)" },
  {
    dialect: "codex",
    args: ["--scenario", "fake-success", "--variant", "missing-final"],
    expectedExit: 0,
    label: "fake-success(missing-final)"
  },
  {
    dialect: "codex",
    args: ["--scenario", "fake-success", "--variant", "schema-invalid"],
    expectedExit: 0,
    label: "fake-success(schema-invalid)"
  },
  {
    dialect: "claude",
    args: ["--scenario", "review", "--review-exists", "package.json"],
    expectedExit: 0,
    label: "review(pass: package.json exists in the process cwd)"
  },
  {
    dialect: "claude",
    args: ["--scenario", "review", "--review-exists", "no-such-file-anywhere.txt"],
    expectedExit: 0,
    label: "review(fail: missing path)"
  },
  {
    dialect: "codex",
    args: ["--scenario", "review", "--review-exists", "package.json"],
    expectedExit: 0,
    label: "review(pass: package.json exists in the process cwd)"
  },
  {
    dialect: "codex",
    args: ["--scenario", "review", "--review-exists", "no-such-file-anywhere.txt"],
    expectedExit: 0,
    label: "review(fail: missing path)"
  }
];

describe("scenario matrix (spawned bins)", () => {
  for (const item of CASES) {
    test(`${item.dialect}: ${item.label} exits ${item.expectedExit} with synthetic-marked output`, async () => {
      const result = await runBin(item.dialect, item.args);
      expect(result.code, `exit code for ${item.label}`).toBe(item.expectedExit);
      expect(result.signal).toBeNull();

      // SYNTHETIC banner must be on stderr, never on the protocol stream.
      expect(result.stderrText).toContain("SYNTHETIC EVENT STREAM");

      // The truncated scenario's tail is deliberately broken JSON; every
      // complete line must still carry the synthetic marker.
      const isTruncated = item.args.includes("truncated");
      const completeLines = isTruncated ? result.stdoutLines.slice(0, -1) : result.stdoutLines;
      if (isTruncated) {
        const lastLine = result.stdoutLines[result.stdoutLines.length - 1] ?? "";
        expect(() => JSON.parse(lastLine), `${item.label} tail should be broken JSON`).toThrow();
      }
      for (const line of completeLines) {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        expect(parsed["synthetic"], `line without synthetic marker: ${line.slice(0, 80)}`).toBe(true);
      }
    }, 45_000);
  }

  test("success scenario really contains a final result event", async () => {
    for (const dialect of ["claude", "codex"] as const) {
      const result = await runBin(dialect, ["--scenario", "success"]);
      const finalTypes = result.stdoutLines.map((line) => {
        const parsed = JSON.parse(line) as { type?: unknown };
        return typeof parsed["type"] === "string" ? parsed["type"] : "";
      });
      const lastType = finalTypes[finalTypes.length - 1] ?? "";
      expect(lastType, `${dialect} final event type`).toBe(dialect === "claude" ? "result" : "turn.completed");
    }
  }, 45_000);

  test("truncated scenario leaves an unparseable last line", async () => {
    for (const dialect of ["claude", "codex"] as const) {
      const result = await runBin(dialect, ["--scenario", "truncated"]);
      const lastLine = result.stdoutLines[result.stdoutLines.length - 1] ?? "";
      expect(() => JSON.parse(lastLine), `${dialect} last line should be broken JSON`).toThrow();
    }
  }, 45_000);

  test("fake-success keeps exit 0 while the final result reports an error", async () => {
    for (const dialect of ["claude", "codex"] as const) {
      const result = await runBin(dialect, ["--scenario", "fake-success"]);
      expect(result.code).toBe(0);
      const isErrorMarked = result.stdoutLines.some((line) => {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (dialect === "claude") {
          return parsed["type"] === "result" && parsed["is_error"] === true;
        }
        return parsed["type"] === "turn.failed";
      });
      expect(isErrorMarked, `${dialect} should carry an error-marked final event`).toBe(true);
    }
  }, 45_000);

  test("unknown arguments are rejected with exit code 2", async () => {
    const result = await runBin("claude", ["--totally-unknown-flag"]);
    expect(result.code).toBe(2);
    expect(result.stderrText).toContain("unknown option");
  }, 45_000);

  test("--help exits 0 and prints the SYNTHETIC notice", async () => {
    const result = await runBin("codex", ["--help"]);
    expect(result.code).toBe(0);
    expect(result.stderrText + result.stdoutLines.join("\n")).toContain("SYNTHETIC");
  }, 45_000);

  // M10-03: the review scenario's verdict is CONTENT-grounded and rides the
  // frozen contracts ExecutionResult.review channel — pass iff the
  // --review-exists path resolves in the process cwd, fail (with one finding)
  // otherwise, and the reviewer run exits 0 either way (a fail verdict is
  // data, not a crashed reviewer).
  test("review scenario grounds the structured verdict in the checked path", async () => {
    for (const dialect of ["claude", "codex"] as const) {
      const pass = await runBin(dialect, ["--scenario", "review", "--review-exists", "package.json"]);
      expect(pass.code, `${dialect} pass exit`).toBe(0);
      const passVerdict = extractReview(pass.stdoutLines, dialect);
      expect(passVerdict?.verdict, `${dialect} pass verdict`).toBe("pass");
      expect(passVerdict?.findings, `${dialect} pass findings`).toEqual([]);

      const fail = await runBin(dialect, ["--scenario", "review", "--review-exists", "no-such-file-anywhere.txt"]);
      expect(fail.code, `${dialect} fail exit`).toBe(0);
      const failVerdict = extractReview(fail.stdoutLines, dialect);
      expect(failVerdict?.verdict, `${dialect} fail verdict`).toBe("fail");
      expect(failVerdict?.findings.join(" "), `${dialect} fail finding`).toContain("no-such-file-anywhere.txt");
    }
  }, 60_000);

  test("review scenario requires --review-exists (exit 2), which is refused elsewhere", async () => {
    const missing = await runBin("claude", ["--scenario", "review"]);
    expect(missing.code).toBe(2);
    expect(missing.stderrText).toContain("--review-exists");
    const misplaced = await runBin("claude", ["--scenario", "success", "--review-exists", "package.json"]);
    expect(misplaced.code).toBe(2);
    expect(misplaced.stderrText).toContain("only valid with --scenario review");
  }, 45_000);
});

/** Pulls the structured review field out of the final result line. */
function extractReview(stdoutLines: readonly string[], dialect: "claude" | "codex"): {
  verdict: string;
  findings: readonly string[];
} | null {
  for (const line of [...stdoutLines].reverse()) {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const business =
      dialect === "claude"
        ? (parsed["structured_output"] as Record<string, unknown> | undefined)
        : (parsed["execution_result"] as Record<string, unknown> | undefined);
    if (business === undefined) continue;
    const review = business["review"] as { verdict?: unknown; findings?: unknown } | undefined;
    if (review === undefined) continue;
    return {
      verdict: String(review["verdict"]),
      findings: Array.isArray(review["findings"]) ? review["findings"].map(String) : []
    };
  }
  return null;
}
