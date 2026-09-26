/**
 * npm-style `.cmd` wrapper generation. Real package managers install
 * `.cmd` shims into `node_modules/.bin` (or pnpm's shim dir) so that a CLI
 * entry can be launched from a Windows shell. This module writes a
 * representative shim that:
 * - resolves `node` from PATH at runtime;
 * - uses `call` so cmd returns to the script after the node process exits;
 * - quotes the target path (spaces / Unicode-safe);
 * - forwards every argument via `%*`;
 * - propagates the node exit code through ENDLOCAL/EXIT /B.
 *
 * The shim content itself is pure ASCII; Unicode directories work because
 * `%~dp0` is expanded by cmd at runtime from the batch file's own location.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";

export interface CmdShim {
  readonly path: string;
  readonly text: string;
}

/**
 * @param dir Directory the shim is written to (may contain spaces/Unicode).
 * @param name Shim file name, e.g. `fake-claude.cmd`.
 * @param targetRelJs Path to the CLI entry script, relative to `dir` and
 *   using backslash separators, e.g. `fake-cli-dist\bin\fake-claude.js`.
 */
export function writeCmdShim(dir: string, name: string, targetRelJs: string): CmdShim {
  const lines = [
    "@ECHO OFF",
    "REM Representative npm-style .cmd wrapper (M0-05 process-lab).",
    "REM `call` keeps control inside cmd after node returns; the target is",
    "REM quoted so spaces and non-ASCII directory names survive; `%*`",
    "REM forwards all arguments; the node exit code is propagated.",
    "SETLOCAL",
    `SET "_TARGET=%~dp0${targetRelJs}"`,
    'call node "%_TARGET%" %*',
    'SET "_CODE=%ERRORLEVEL%"',
    "ENDLOCAL & EXIT /B %_CODE%",
    ""
  ];
  const text = lines.join("\r\n");
  const shimPath = path.join(dir, name);
  writeFileSync(shimPath, text, "utf8");
  return { path: shimPath, text };
}
