/**
 * WSL availability probe and driver runner (read-only probing; the driver
 * script itself only uses /tmp inside the distro, never touches Windows
 * files beyond the fake-cli dist it copies).
 *
 * Results are recorded separately from the native Windows results — WSL and
 * native observations are never merged (A29 direction).
 */
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

export interface WslProbe {
  readonly available: boolean;
  readonly exitCode: number | null;
  /** Decoded `wsl --status` output (encoding-normalized, trimmed). */
  readonly detail: string;
}

/**
 * wsl.exe writes its status output as UTF-16LE; naive UTF-8 decoding leaves
 * NUL padding or mojibake. Decode the raw bytes as UTF-16LE when they carry
 * the NUL pattern, else UTF-8. The text is only recorded, never asserted on.
 */
function decodeConsoleOutput(raw: Buffer): string {
  let nuls = 0;
  const sample = Math.min(raw.length, 256);
  for (let i = 1; i < sample; i += 2) {
    if (raw[i] === 0) nuls += 1;
  }
  const text = nuls > sample / 4 ? raw.toString("utf16le") : raw.toString("utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" | ");
}

function normalizeWslText(raw: string): string {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" | ");
}

export function probeWsl(): WslProbe {
  const run = spawnSync("wsl.exe", ["--status"], { timeout: 30_000, windowsHide: true });
  if (run.error !== undefined) {
    return { available: false, exitCode: null, detail: `spawn error: ${String(run.error)}` };
  }
  const stdout = Buffer.isBuffer(run.stdout) ? run.stdout : Buffer.from(run.stdout ?? "");
  const stderr = Buffer.isBuffer(run.stderr) ? run.stderr : Buffer.from(run.stderr ?? "");
  const detail = normalizeWslText(`${decodeConsoleOutput(stdout)} ${decodeConsoleOutput(stderr)}`);
  return { available: run.status === 0, exitCode: run.status, detail };
}

export interface WslRunResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** Runs `wsl.exe -e sh -c <script>` synchronously. */
export function wslSh(script: string, timeoutMs = 180_000): WslRunResult {
  const run = spawnSync("wsl.exe", ["-e", "sh", "-c", script], {
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true
  });
  return {
    exitCode: run.status,
    stdout: run.stdout ?? "",
    stderr: run.stderr ?? "",
    timedOut: run.error !== undefined && String(run.error).includes("ETIMEDOUT")
  };
}

/** Converts a Windows path to its /mnt/<drive>/... form for WSL access. */
export function windowsPathToWsl(windowsPath: string): string {
  const resolved = path.resolve(windowsPath);
  const drive = resolved.slice(0, 1).toLowerCase();
  const rest = resolved.slice(2).split("\\").join("/");
  if (!/^[a-z]$/.test(drive)) {
    throw new Error(`not a drive-qualified Windows path: ${windowsPath}`);
  }
  return `/mnt/${drive}${rest}`;
}

/**
 * Writes the POSIX driver used inside WSL (LF line endings, ASCII only).
 * The driver:
 * 1. copies the fake-cli dist into /tmp inside the distro;
 * 2. starts the grandchild scenario detached in its own session (setsid when
 *    available) so its process group can be killed without hitting the
 *    driver's own group;
 * 3. reads the reported child/grandchild PIDs from the output file;
 * 4. performs a single kill of the root only, then records who survived;
 * 5. performs the POSIX tree kill (negative-PGID SIGKILL, falling back to
 *    explicit PIDs), then records who survived;
 * 6. prints exactly one line `WSLJSON {...}` with every observation and
 *    removes its scratch directory.
 */
export function writeWslDriver(filePath: string, mntDist: string): void {
  const script = [
    "#!/bin/sh",
    "# M0-05 process-lab WSL driver: grandchild scenario + single kill vs tree kill.",
    "set -u",
    `DIST="${mntDist}"`,
    'D="/tmp/process-lab-m0-05-$$"',
    'mkdir -p "$D" || { echo DRIVER_FAIL mkdir; exit 3; }',
    'cp -r "$DIST" "$D/dist" || { echo DRIVER_FAIL cp; exit 3; }',
    'HAVE_SETSID=$(command -v setsid >/dev/null 2>&1 && echo yes || echo no)',
    'if [ "$HAVE_SETSID" = yes ]; then',
    '  setsid node "$D/dist/bin/fake-claude.js" --scenario grandchild >"$D/out.jsonl" 2>"$D/err.txt" &',
    "else",
    '  node "$D/dist/bin/fake-claude.js" --scenario grandchild >"$D/out.jsonl" 2>"$D/err.txt" &',
    "fi",
    "ROOT=$!",
    'LINE=""',
    "i=0",
    'while [ $i -lt 150 ]; do',
    '  if grep -q grandchildPid "$D/out.jsonl" 2>/dev/null; then',
    '    LINE=$(grep grandchildPid "$D/out.jsonl" | head -n 1)',
    "    break",
    "  fi",
    "  i=$((i+1))",
    "  sleep 0.2",
    "done",
    'if [ -z "$LINE" ]; then',
    '  echo "DRIVER_FAIL no-report root=$ROOT"',
    "  kill -9 $ROOT 2>/dev/null",
    '  rm -rf "$D"',
    "  exit 4",
    "fi",
    'CHILD=$(printf \'%s\' "$LINE" | sed -n \'s/.*"childPid":\\([0-9][0-9]*\\).*/\\1/p\')',
    'GRAND=$(printf \'%s\' "$LINE" | sed -n \'s/.*"grandchildPid":\\([0-9][0-9]*\\).*/\\1/p\')',
    'alive() { if kill -0 "$1" 2>/dev/null; then echo alive; else echo dead; fi; }',
    "# Step 1: single kill of the root only (POSIX analog of taskkill /F).",
    "kill -9 $ROOT 2>/dev/null",
    "sleep 0.5",
    "ROOT_S1=$(alive $ROOT)",
    "CHILD_S1=$(alive $CHILD)",
    "GRAND_S1=$(alive $GRAND)",
    "# Step 2: POSIX tree kill - SIGKILL the child's process group (negative PGID).",
    "# Only attempted when the root runs in its own session (setsid); otherwise",
    "# the group includes this driver itself.",
    'PGID=$(ps -o pgid= -p "$CHILD" 2>/dev/null | tr -d " \\t")',
    'if [ "$HAVE_SETSID" = yes ] && [ -n "$PGID" ]; then kill -9 -"$PGID" 2>/dev/null; fi',
    "kill -9 $CHILD $GRAND 2>/dev/null",
    "sleep 0.5",
    "CHILD_S2=$(alive $CHILD)",
    "GRAND_S2=$(alive $GRAND)",
    'printf \'WSLJSON {"rootPid":%s,"childPid":%s,"grandchildPid":%s,"setsid":"%s","pgid":"%s","rootAfterSingleKill":"%s","childAfterSingleKill":"%s","grandAfterSingleKill":"%s","childAfterTreeKill":"%s","grandAfterTreeKill":"%s","nodeVersion":"%s"}\\n\' \\',
    '  "$ROOT" "$CHILD" "$GRAND" "$HAVE_SETSID" "${PGID:-none}" "$ROOT_S1" "$CHILD_S1" "$GRAND_S1" "$CHILD_S2" "$GRAND_S2" "$(node --version 2>/dev/null)"',
    'rm -rf "$D"',
    "exit 0",
    ""
  ].join("\n");
  writeFileSync(filePath, script, "utf8");
}

/** Extracts the driver's JSON record from its combined output. */
export function parseWslDriverJson(output: string): Record<string, unknown> | null {
  const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith("WSLJSON "));
  if (line === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice("WSLJSON ".length));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
