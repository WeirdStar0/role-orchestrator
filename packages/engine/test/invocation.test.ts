/**
 * Unit tests for the PreparedInvocation assembly: executable form
 * resolution, dialect protocol args, the model-override guard (the process
 * level A02 cousin), target checks (A29), manifest-hash determinism and the
 * stdin file contract.
 */
import { describe, expect, test } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ModelOverrideArgError,
  WorkingDirectoryError,
  UnsupportedExecutionTargetError,
  UnsupportedExecutableFormError,
  defaultEvidencePolicy,
  dialectProtocolArgs,
  prepareExecutionInvocation,
  resolveExecutionCommand
} from "../src/index.js";
import { createSeededDb, makeWorkDir, seedFakeRun } from "./helpers.js";

describe("resolveExecutionCommand", () => {
  test("a .js script runs through the current node binary (fake-cli dogfood form)", () => {
    const command = resolveExecutionCommand("H:/repo/bin/fake-claude.js", "win32");
    expect(command.form).toBe("node-script");
    expect(command.command).toBe(process.execPath);
    expect(command.prefix).toEqual(["H:/repo/bin/fake-claude.js"]);
  });

  test("a .cmd shim goes through cmd.exe /d /c on Windows only", () => {
    const win = resolveExecutionCommand("claude.cmd", "win32");
    expect(win.form).toBe("cmd-shim");
    expect(win.command).toBe("cmd.exe");
    expect(win.prefix).toEqual(["/d", "/c", "claude.cmd"]);

    expect(() => resolveExecutionCommand("claude.cmd", "linux")).toThrow(
      UnsupportedExecutableFormError
    );
  });

  test("anything else is spawned directly", () => {
    const command = resolveExecutionCommand("codex", "win32");
    expect(command).toEqual({ command: "codex", prefix: [], form: "direct" });
  });
});

describe("dialectProtocolArgs", () => {
  test("claude gets the non-interactive stream-json form plus an explicit model", () => {
    expect(dialectProtocolArgs("claude", null)).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose"
    ]);
    expect(dialectProtocolArgs("claude", "m1")).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "m1"
    ]);
  });

  test("codex gets exec --json plus -m when a model is pinned", () => {
    expect(dialectProtocolArgs("codex", null)).toEqual(["exec", "--json"]);
    expect(dialectProtocolArgs("codex", "m1")).toEqual(["exec", "--json", "-m", "m1"]);
  });
});

describe("assertNoModelOverrideArgs via prepareExecutionInvocation", () => {
  test("a model flag in the invocation args is rejected by name", async () => {
    const { db, close } = createSeededDb("override");
    try {
      const seed = await seedFakeRun(db, { dialect: "claude" });
      const base = {
        executionId: "exec-ov",
        runId: seed.runId,
        roleId: "developer" as const,
        nodeId: "node-1",
        attempt: 1,
        cwd: makeWorkDir("ov"),
        prompt: "p",
        timeoutSeconds: 10
      };
      expect(() =>
        prepareExecutionInvocation(db, { ...base, invocationArgs: ["--model", "x"] })
      ).toThrow(ModelOverrideArgError);
      expect(() =>
        prepareExecutionInvocation(db, { ...base, invocationArgs: ["-m", "x"] })
      ).toThrow(ModelOverrideArgError);
      // Non-model arguments pass the guard.
      const prepared = prepareExecutionInvocation(db, {
        ...base,
        invocationArgs: ["--scenario", "success"]
      });
      expect(prepared.argv.at(-1)).toBe("success");
    } finally {
      close();
    }
  });
});

describe("prepareExecutionInvocation over a frozen snapshot", () => {
  test("assembles the full argv array, stdin file and stable manifest hash", async () => {
    const { db, close } = createSeededDb("prepare");
    try {
      const seed = await seedFakeRun(db, { dialect: "claude" });
      const cwd = makeWorkDir("prepare");
      const input = {
        executionId: "exec-prep",
        runId: seed.runId,
        roleId: "developer" as const,
        nodeId: "node-1",
        attempt: 1,
        cwd,
        prompt: "synthetic prompt",
        invocationArgs: ["--scenario", "success"],
        timeoutSeconds: 42
      };
      const prepared = prepareExecutionInvocation(db, input);

      // The executable is the frozen snapshot's value resolved through the
      // node-script form; the argv array is prefix + protocol + invocation.
      expect(prepared.command).toBe(process.execPath);
      expect(prepared.argv).toEqual([
        seed.executable,
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--scenario",
        "success"
      ]);
      expect(prepared.dialect).toBe("claude");
      expect(prepared.snapshot.id).toBe(seed.profileId);
      expect(prepared.timeoutSeconds).toBe(42);
      expect(prepared.evidencePolicy).toBe("cited-artifact-ids");

      // contracts-shaped view.
      expect(prepared.invocation.executable).toBe(prepared.command);
      expect(prepared.invocation.args).toEqual(prepared.argv);
      expect(prepared.invocation.runtimeSecretRefs).toEqual([]);
      expect(prepared.invocation.requiredCapabilities).toEqual(["streaming", "structuredOutput"]);

      // The stdin file exists and carries the prompt.
      expect(existsSync(prepared.stdinFile)).toBe(true);
      expect(readFileSync(prepared.stdinFile, "utf8")).toBe("synthetic prompt");
      expect(prepared.stdinFile.startsWith(cwd)).toBe(true);

      // Manifest hash is deterministic and input-sensitive.
      const second = prepareExecutionInvocation(db, input);
      expect(second.manifestHash).toBe(prepared.manifestHash);
      const changed = prepareExecutionInvocation(db, {
        ...input,
        invocationArgs: ["--scenario", "truncated"]
      });
      expect(changed.manifestHash).not.toBe(prepared.manifestHash);
      const changedModel = prepareExecutionInvocation(db, { ...input, timeoutSeconds: 43 });
      expect(changedModel.manifestHash).not.toBe(prepared.manifestHash);
    } finally {
      close();
    }
  });

  test("refuses a missing working directory", async () => {
    const { db, close } = createSeededDb("cwd");
    try {
      const seed = await seedFakeRun(db, { dialect: "claude" });
      expect(() =>
        prepareExecutionInvocation(db, {
          executionId: "exec-cwd",
          runId: seed.runId,
          roleId: "developer",
          nodeId: "node-1",
          attempt: 1,
          cwd: join(makeWorkDir("nope"), "does-not-exist"),
          prompt: "p",
          invocationArgs: [],
          timeoutSeconds: 10
        })
      ).toThrow(WorkingDirectoryError);
    } finally {
      close();
    }
  });

  test("refuses a non-windows-native snapshot target without conversion (A29)", async () => {
    const { db, close } = createSeededDb("wsl");
    try {
      // Relative path forms pass the A29 shape checks; the launcher itself
      // must still refuse the target instead of converting anything.
      const seed = await seedFakeRun(db, { dialect: "claude", projectTarget: "wsl" });
      expect(() =>
        prepareExecutionInvocation(db, {
          executionId: "exec-wsl",
          runId: seed.runId,
          roleId: "developer",
          nodeId: "node-1",
          attempt: 1,
          cwd: makeWorkDir("wsl"),
          prompt: "p",
          invocationArgs: [],
          timeoutSeconds: 10
        })
      ).toThrow(UnsupportedExecutionTargetError);
    } finally {
      close();
    }
  });
});

describe("defaultEvidencePolicy", () => {
  test("claude requires cited ids; codex requires any artifact report", () => {
    expect(defaultEvidencePolicy("claude")).toBe("cited-artifact-ids");
    expect(defaultEvidencePolicy("codex")).toBe("any-artifact-reported");
  });
});
