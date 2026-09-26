#!/usr/bin/env node
/**
 * planning-check.mjs — honest integrity gate for the planning bundle (M0 phase).
 *
 * Run via `pnpm run planning:check` (root package.json) or `node planning-check.mjs`.
 *
 * Part (a): verify every file recorded in CHECKSUMS.sha256 (skipping the
 * .gitignore line, which the project explicitly allows to be amended) against
 * its recorded sha256. Any mismatch or missing file is printed and fails the
 * run with a non-zero exit code.
 *
 * Part (b): copy the repository tree into a fresh directory under the system
 * temp folder (excluding node_modules, dist, .turbo, .vitest, coverage, .git,
 * .zcode) and run `python scripts/validate_bundle.py --self-test` inside that
 * copy, passing its exit code through. The temp copy is removed afterwards.
 *
 * This script never modifies frozen files. It does not hide the fact that the
 * frozen scripts/validate_bundle.py exits 1 when node_modules is present in
 * the repo (see PROPOSALS.md); part (b) runs it on a tree without node_modules
 * precisely so the planning bundle itself is validated on its own merits.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const CHECKSUMS_FILE = path.join(REPO_ROOT, "CHECKSUMS.sha256");
const EXCLUDED_DIRS = new Set([
  "node_modules",
  "dist",
  ".turbo",
  ".vitest",
  "coverage",
  ".git",
  ".zcode",
]);

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function parseChecksums(text) {
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line);
    if (!match) {
      throw new Error(`Unparseable CHECKSUMS.sha256 line: ${rawLine}`);
    }
    entries.push({ hash: match[1].toLowerCase(), file: match[2].trim() });
  }
  return entries;
}

function checkChecksums() {
  const entries = parseChecksums(fs.readFileSync(CHECKSUMS_FILE, "utf8"));
  const toVerify = entries.filter((entry) => entry.file !== ".gitignore");
  const problems = [];
  for (const { hash, file } of toVerify) {
    const target = path.join(REPO_ROOT, ...file.split("/"));
    if (!fs.existsSync(target)) {
      problems.push(`MISSING  ${file}\n  expected sha256: ${hash}`);
      continue;
    }
    const actual = sha256File(target);
    if (actual !== hash) {
      problems.push(`MISMATCH ${file}\n  expected sha256: ${hash}\n  actual sha256:   ${actual}`);
    }
  }
  if (problems.length > 0) {
    console.error(
      `planning:check (a) checksum verification FAILED: ${problems.length} problem(s) out of ${toVerify.length} recorded files:`,
    );
    for (const problem of problems) console.error(problem);
    return false;
  }
  console.log(
    `planning:check (a) checksum verification OK: ${toVerify.length}/${toVerify.length} files match CHECKSUMS.sha256 (.gitignore line skipped).`,
  );
  return true;
}

function copyTree(srcDir, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      copyTree(src, dest);
    } else if (entry.isFile()) {
      fs.copyFileSync(src, dest);
    }
    // Symbolic links and other entry types are intentionally not copied.
  }
}

function runSelfTestInTempCopy() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "planning-check-"));
  console.log(
    `planning:check (b) copied repo tree to ${tempDir} (excluded directories: ${[...EXCLUDED_DIRS].join(", ")})`,
  );
  try {
    copyTree(REPO_ROOT, tempDir);
    const result = spawnSync("python", ["scripts/validate_bundle.py", "--self-test"], {
      cwd: tempDir,
      stdio: "inherit",
    });
    if (result.error) {
      console.error(`planning:check (b) failed to launch python: ${result.error.message}`);
      return 1;
    }
    if (result.signal) {
      console.error(`planning:check (b) python terminated by signal ${result.signal}`);
      return 1;
    }
    console.log(
      `planning:check (b) python scripts/validate_bundle.py --self-test (in temp copy) exited with code ${result.status}.`,
    );
    return result.status;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`planning:check (b) removed temp copy ${tempDir}`);
  }
}

try {
  if (!checkChecksums()) {
    process.exit(1);
  }
  process.exit(runSelfTestInTempCopy());
} catch (error) {
  console.error(`planning:check failed: ${error && error.stack ? error.stack : error}`);
  process.exit(1);
}
