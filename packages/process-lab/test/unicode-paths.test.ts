/**
 * M0-05 scenario 2 — Unicode + space paths (A28).
 *
 * The complete launcher chain (dist copy, `.cmd` shim, `call node`, cwd set
 * to the scratch dir) must work from a directory whose name contains CJK
 * characters and spaces: exit 0, complete JSONL event stream, and strict
 * argv pass-through (unknown argument rejected with exit 2).
 */
import { expect, test } from "vitest";
import { installFakeCli, type FakeCliInstall } from "../src/fakecli.js";
import { findJsonValue, withTimeout } from "../src/lines.js";
import { TreeRegistry } from "../src/registry.js";
import { makeUnicodeScratchDir, removeScratch } from "../src/scratch.js";
import { writeCmdShim, type CmdShim } from "../src/shim.js";
import { requiredPid, spawnCmdProcess } from "../src/spawnproc.js";

const isWindows = process.platform === "win32";
const d = isWindows ? test : test.skip;

interface UnicodeFixture {
  readonly scratchDir: string;
  readonly fake: FakeCliInstall;
  readonly shim: CmdShim;
  readonly registry: TreeRegistry;
}

function setupUnicodeFixture(): UnicodeFixture {
  const scratchDir = makeUnicodeScratchDir();
  return {
    scratchDir,
    fake: installFakeCli(scratchDir),
    shim: writeCmdShim(scratchDir, "fake-claude.cmd", "fake-cli-dist\\bin\\fake-claude.js"),
    registry: new TreeRegistry()
  };
}

async function teardownUnicodeFixture(fixture: UnicodeFixture): Promise<void> {
  await fixture.registry.reapAll();
  removeScratch(fixture.scratchDir);
}

d(
  "fake-cli runs from a Chinese+space directory: exit 0, complete JSONL stream, strict unknown-arg rejection",
  { timeout: 360_000 },
  async () => {
    const fixture = setupUnicodeFixture();
    try {
      const name = fixture.scratchDir.split("\\").pop() ?? "";
      expect(name, "scratch name must contain CJK characters and spaces").toContain("中文");
      expect(name).toContain(" ");

      const run = spawnCmdProcess(fixture.shim.path, ["--scenario", "success"], fixture.scratchDir);
      fixture.registry.add(requiredPid(run.child));
      const info = await withTimeout(run.exit, 60_000, "unicode success run");
      run.stdout.finish();
      run.stderr.finish();
      expect(info.code, "exit code from the unicode+space directory").toBe(0);

      expect(
        run.stderr.lines.some((line) => line.includes("SYNTHETIC EVENT STREAM")),
        "stderr must carry the SYNTHETIC banner"
      ).toBe(true);
      expect(run.stdout.lines.length, `stdout line count: ${run.stdout.lines.length}`).toBeGreaterThanOrEqual(7);

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
      expect(finalResult!["result"]).toBe("Synthetic final message");

      // Unknown argument must be rejected by the CLI itself (exit 2), proving
      // argv pass-through survived the shim + unicode path.
      const unknownRun = spawnCmdProcess(
        fixture.shim.path,
        ["--scenario", "success", "--definitely-not-a-flag"],
        fixture.scratchDir
      );
      fixture.registry.add(requiredPid(unknownRun.child));
      const unknownInfo = await withTimeout(unknownRun.exit, 60_000, "unicode unknown-arg run");
      unknownRun.stdout.finish();
      unknownRun.stderr.finish();
      expect(unknownInfo.code, "unknown argument must exit 2").toBe(2);
    } finally {
      await teardownUnicodeFixture(fixture);
    }
  }
);
