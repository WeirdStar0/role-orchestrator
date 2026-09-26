/**
 * M6-01 — the A28 cell that M0-05 left unverified (M0-05 §7 未验证项#5,
 * platform baseline §7.5): the `.cmd` shim driven through `cmd.exe /d /c`
 * COMBINED with a >260-character path AND CJK characters AND spaces —
 * all three at once. M0-05 verified long paths only for a direct
 * `node <script>` launch; the shim combination was never measured.
 *
 * Measured platform truth pinned here (win32 10.0.26100 x64, Node v25.0.0,
 * git-bash host, probed before this test was written):
 * 1. The full chain works: dist copy into the deep CJK+space directory,
 *    npm-style shim at a >260 path, `cmd.exe /d /c <shim> --scenario
 *    success` from a CJK+space cwd -> exit 0, complete JSONL stream,
 *    final result line with is_error=false. Unknown arguments still get
 *    the CLI's strict exit 2, proving argv pass-through survives the
 *    long CJK+space shim path.
 * 2. The hard boundary: ANY process spawned with a >260 cwd fails at
 *    CreateProcess before exec (spawn error ENOENT; observed for node
 *    and cmd.exe alike) — and, critically, the target command never
 *    runs (marker file stays absent). This is the fail-closed property
 *    a launcher may rely on: a >260 cwd cannot silently half-execute.
 *
 * Platform gate: both cells are win32-only (cmd.exe semantics); on other
 * platforms the file skips, declared here rather than silently.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { installFakeCli, type FakeCliInstall } from "../src/fakecli.js";
import { findJsonValue, withTimeout } from "../src/lines.js";
import { TreeRegistry } from "../src/registry.js";
import { makeUnicodeScratchDir, removeScratch } from "../src/scratch.js";
import { writeCmdShim, type CmdShim } from "../src/shim.js";
import { requiredPid, spawnCmdProcess } from "../src/spawnproc.js";

const isWindows = process.platform === "win32";
const d = isWindows ? test : test.skip;

const LONG_SEGMENT = "segment-level-abcdefghijklmnopqrstuvwxyz0123456789";

interface DeepFixture {
  readonly scratchDir: string;
  /** Directory whose path is >260 chars, containing CJK and spaces. */
  readonly deepDir: string;
  readonly fake: FakeCliInstall;
  readonly shim: CmdShim;
  readonly registry: TreeRegistry;
}

function setupDeepFixture(): DeepFixture {
  const scratchDir = makeUnicodeScratchDir();
  const deepDir = path.join(scratchDir, "中文 深 层", ...Array.from({ length: 6 }, () => LONG_SEGMENT));
  mkdirSync(deepDir, { recursive: true });
  return {
    scratchDir,
    deepDir,
    fake: installFakeCli(deepDir),
    shim: writeCmdShim(deepDir, "fake-claude.cmd", "fake-cli-dist\\bin\\fake-claude.js"),
    registry: new TreeRegistry()
  };
}

async function teardownDeepFixture(fixture: DeepFixture): Promise<void> {
  await fixture.registry.reapAll();
  removeScratch(fixture.scratchDir);
}

d(
  "A28 combined cell: .cmd shim at a >260 CJK+space path runs the full fake-cli chain",
  { timeout: 360_000 },
  async () => {
    const fixture = setupDeepFixture();
    try {
      // Precondition: the SHIM path and the TARGET script really are past the
      // classic MAX_PATH, and the prefix really carries CJK + spaces.
      expect(fixture.shim.path.length, `shim path: ${fixture.shim.path}`).toBeGreaterThan(260);
      expect(
        path.join(fixture.fake.distDir, "bin", "fake-claude.js").length
      ).toBeGreaterThan(260);
      expect(fixture.shim.path).toContain("中文");
      expect(fixture.shim.path).toContain(" ");

      const run = spawnCmdProcess(fixture.shim.path, ["--scenario", "success"], fixture.scratchDir);
      fixture.registry.add(requiredPid(run.child));
      const info = await withTimeout(run.exit, 120_000, "deep CJK+space shim success run");
      run.stdout.finish();
      run.stderr.finish();
      expect(info.code, `stderr: ${run.stderr.lines.slice(0, 4).join(" | ")}`).toBe(0);
      expect(
        run.stderr.lines.some((line) => line.includes("SYNTHETIC EVENT STREAM")),
        "stderr must carry the SYNTHETIC banner"
      ).toBe(true);
      expect(run.stdout.lines.length, `stdout lines: ${run.stdout.lines.length}`).toBeGreaterThanOrEqual(7);

      let finalResult: Record<string, unknown> | null = null;
      for (const line of run.stdout.lines) {
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(line);
        }, `line must parse as JSON: ${line.slice(0, 120)}`).not.toThrow();
        const record = parsed as Record<string, unknown> | null;
        if (record !== null && typeof record === "object" && record["type"] === "result") {
          finalResult = record;
        }
      }
      expect(finalResult, "a final result line must be present").not.toBeNull();
      expect(finalResult!["is_error"]).toBe(false);
      expect(findJsonValue(finalResult, "structured_output")).toBeDefined();

      // Unknown argument through the SAME long CJK+space shim: the fake CLI's
      // strict rejection (exit 2) proves argv pass-through is intact end to end.
      const unknownRun = spawnCmdProcess(
        fixture.shim.path,
        ["--scenario", "success", "--definitely-not-a-flag"],
        fixture.scratchDir
      );
      fixture.registry.add(requiredPid(unknownRun.child));
      const unknownInfo = await withTimeout(unknownRun.exit, 120_000, "deep CJK+space unknown-arg run");
      unknownRun.stdout.finish();
      unknownRun.stderr.finish();
      expect(unknownInfo.code, "unknown argument must still exit 2").toBe(2);
    } finally {
      await teardownDeepFixture(fixture);
    }
  }
);

d(
  "A28 boundary: a >260 cwd fails the spawn itself (ENOENT) and the command never executes",
  { timeout: 360_000 },
  async () => {
    const fixture = setupDeepFixture();
    try {
      expect(fixture.deepDir.length, `deep dir: ${fixture.deepDir}`).toBeGreaterThan(260);

      // Marker script: if the command ever ran, the marker file would exist.
      // (Plain node run, so CommonJS; the target path is baked in verbatim.)
      const markerScript = path.join(fixture.deepDir, "marker.js");
      const markerFile = path.join(fixture.deepDir, "marker.txt");
      writeFileSync(
        markerScript,
        `require("node:fs").writeFileSync(${JSON.stringify(markerFile)}, "ran\\n");\n`,
        "utf8"
      );
      expect(existsSync(markerFile)).toBe(false);

      const spawnIgnoringStdio = (command: string, args: readonly string[], cwd: string) =>
        new Promise<{ code: number | null; error: Error | null }>((resolve) => {
          const child = spawn(command, [...args], {
            cwd,
            stdio: "ignore",
            windowsHide: true
          });
          let spawnError: Error | null = null;
          child.once("error", (error: Error) => {
            spawnError = error;
          });
          child.once("close", (code) => {
            resolve({ code, error: spawnError });
          });
        });

      // node with a >260 cwd: spawn fails before exec.
      const nodeRun = await spawnIgnoringStdio(process.execPath, [markerScript], fixture.deepDir);
      expect(nodeRun.error, "node with a >260 cwd must fail to spawn").not.toBeNull();
      expect((nodeRun.error as NodeJS.ErrnoException | null)?.code).toBe("ENOENT");

      // cmd.exe with a >260 cwd: same CreateProcess boundary, independent of
      // which executable was requested.
      const cmdRun = await spawnIgnoringStdio("cmd.exe", ["/d", "/c", "echo hi"], fixture.deepDir);
      expect(cmdRun.error, "cmd.exe with a >260 cwd must fail to spawn").not.toBeNull();
      expect((cmdRun.error as NodeJS.ErrnoException | null)?.code).toBe("ENOENT");

      // Fail-closed proof: neither command ever executed — no marker file
      // appeared, so nothing "half-ran" at the long path.
      expect(existsSync(markerFile), "the marker must never be created").toBe(false);
    } finally {
      await teardownDeepFixture(fixture);
    }
  }
);
