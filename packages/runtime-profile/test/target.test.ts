import { describe, expect, it } from "vitest";
import type { ExecutionTarget } from "@role-orchestrator/contracts";
import {
  checkExecutionTarget,
  classifyPathForm,
  createProfile,
  ExecutionTargetMismatchError
} from "../src/index.js";
import { createMigratedMemoryDb, expectError, T0 } from "./helpers.js";

describe("path form classification", () => {
  it("classifies windows, POSIX, UNC, WSL-UNC and relative forms", () => {
    expect(classifyPathForm("C:\\Users\\u\\claude.cmd")).toBe("win32-drive");
    expect(classifyPathForm("C:/Users/u/claude.cmd")).toBe("win32-drive");
    expect(classifyPathForm("h:/repos/demo")).toBe("win32-drive");
    expect(classifyPathForm("/usr/local/bin/claude")).toBe("posix-absolute");
    expect(classifyPathForm("\\\\wsl$\\Ubuntu\\usr\\bin\\claude")).toBe("unc-wsl");
    expect(classifyPathForm("\\\\wsl.localhost\\Ubuntu\\home\\u")).toBe("unc-wsl");
    expect(classifyPathForm("\\\\server\\share\\claude.cmd")).toBe("unc");
    expect(classifyPathForm("claude.cmd")).toBe("relative");
    expect(classifyPathForm("./tools/claude.cmd")).toBe("relative");
  });
});

describe("A29: checkExecutionTarget refuses mismatches before execution", () => {
  it("profile target differing from project target is a typed error (windows-native vs wsl)", () => {
    expectError(
      () =>
        checkExecutionTarget({
          projectTarget: "windows-native",
          profileTarget: "wsl"
        }),
      ExecutionTargetMismatchError
    );
  });

  it("explicit request target differing from the project target is refused", () => {
    const error = expectError(
      () =>
        checkExecutionTarget({
          projectTarget: "windows-native",
          profileTarget: "windows-native",
          requestTarget: "wsl"
        }),
      ExecutionTargetMismatchError
    );
    expect(error.kind).toBe("target-differ");
    expect(error.field).toBe("requestTarget");
  });

  it("windows-native target with a POSIX absolute path is refused (no implicit conversion)", () => {
    const error = expectError(
      () =>
        checkExecutionTarget({
          projectTarget: "windows-native",
          profileTarget: "windows-native",
          executable: "/usr/local/bin/claude",
          configDir: "C:\\Users\\u\\.claude"
        }),
      ExecutionTargetMismatchError
    );
    expect(error.kind).toBe("path-form");
    expect(error.field).toBe("executable");
  });

  it("wsl target with a Windows drive path is refused", () => {
    const error = expectError(
      () =>
        checkExecutionTarget({
          projectTarget: "wsl",
          profileTarget: "wsl",
          executable: "C:\\Program Files\\claude\\claude.exe"
        }),
      ExecutionTargetMismatchError
    );
    expect(error.kind).toBe("path-form");
  });

  it("wsl target with a non-WSL UNC path is refused", () => {
    expectError(
      () =>
        checkExecutionTarget({
          projectTarget: "wsl",
          profileTarget: "wsl",
          configDir: "\\\\server\\share\\config"
        }),
      ExecutionTargetMismatchError
    );
  });

  it("\\wsl$ views of the WSL filesystem are refused for BOTH worlds (mixed-world paths)", () => {
    for (const target of ["windows-native", "wsl"] as const) {
      const error = expectError(
        () =>
          checkExecutionTarget({
            projectTarget: target,
            profileTarget: target,
            executable: "\\\\wsl$\\Ubuntu\\usr\\bin\\claude"
          }),
        ExecutionTargetMismatchError
      );
      expect(error.kind).toBe("path-form");
    }
  });

  it("accepts matching forms: win32/UNC/relative for windows-native, POSIX/relative for wsl", () => {
    expect(() =>
      checkExecutionTarget({
        projectTarget: "windows-native",
        profileTarget: "windows-native",
        executable: "C:\\Users\\u\\claude.cmd",
        configDir: "\\\\server\\share\\.claude"
      })
    ).not.toThrow();
    expect(() =>
      checkExecutionTarget({
        projectTarget: "windows-native",
        profileTarget: "windows-native",
        executable: "claude.cmd"
      })
    ).not.toThrow();
    expect(() =>
      checkExecutionTarget({
        projectTarget: "wsl",
        profileTarget: "wsl",
        executable: "/usr/local/bin/claude",
        configDir: "/home/u/.claude"
      })
    ).not.toThrow();
    expect(() =>
      checkExecutionTarget({
        projectTarget: "linux-native",
        profileTarget: "linux-native",
        executable: "/opt/claude/claude",
        configDir: "/home/u/.claude"
      })
    ).not.toThrow();
  });

  it("relative command names are allowed for every target (PATH lookup happens in-world)", () => {
    for (const target of [
      "windows-native",
      "wsl",
      "linux-native",
      "macos-native"
    ] as readonly ExecutionTarget[]) {
      expect(() =>
        checkExecutionTarget({ projectTarget: target, profileTarget: target, executable: "claude" })
      ).not.toThrow();
    }
  });
});

describe("A29 at registration: createProfile validates path forms against its own target", () => {
  it("refuses a windows-native profile with a POSIX executable", () => {
    const db = createMigratedMemoryDb();
    expectError(
      () =>
        createProfile(db, {
          id: "claude-confused",
          runtime: "claude",
          executable: "/usr/local/bin/claude",
          executionTarget: "windows-native",
          configDir: "C:\\Users\\u\\.claude",
          credentialGroup: "personal",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          now: T0
        }),
      ExecutionTargetMismatchError
    );
  });

  it("refuses a \\wsl$ executable for a wsl profile (mixed-world view)", () => {
    const db = createMigratedMemoryDb();
    expectError(
      () =>
        createProfile(db, {
          id: "codex-wsl-unc",
          runtime: "codex",
          executable: "\\\\wsl.localhost\\Ubuntu\\usr\\bin\\codex",
          executionTarget: "wsl",
          configDir: "/home/u/.codex",
          credentialGroup: "personal",
          maxConcurrency: 2,
          timeoutSeconds: 600,
          now: T0
        }),
      ExecutionTargetMismatchError
    );
  });

  it("accepts a consistent wsl profile", () => {
    const db = createMigratedMemoryDb();
    const profile = createProfile(db, {
      id: "codex-wsl",
      runtime: "codex",
      executable: "/usr/local/bin/codex",
      executionTarget: "wsl",
      configDir: "/home/u/.codex",
      credentialGroup: "personal",
      maxConcurrency: 2,
      timeoutSeconds: 600,
      now: T0
    });
    expect(profile.executionTarget).toBe("wsl");
  });
});
