/**
 * M8-05 task 2: fetch the portable Windows node runtime for the desktop
 * shell sidecar (apps/desktop-shell/node-runtime/node.exe).
 *
 * Source policy (repo hard rule): the ONLY download origin is the official
 * https://nodejs.org/dist/ — build-time only, never shipped code from
 * anywhere else, and the downloaded zip is verified against the SAME
 * origin's SHASUMS256.txt before anything is extracted (mismatch = nonzero
 * exit, nothing written).
 *
 * Version policy: NODE_VERSION below is pinned to the workspace toolchain —
 * mise.toml [tools] `node = "25.9.0"` (the acceptance-baseline node 25 line;
 * packages/local-api engines requires >=25). The bundled node.exe must run
 * the exact same JS the dev layout runs, so it tracks mise, not "latest".
 *
 * Idempotency: with NODE_EXE_SHA256 pinned (filled from the first recorded
 * run), a re-run hashes the existing apps/desktop-shell/node-runtime/node.exe
 * and SKIPS the download entirely on match — the script is zero-network when
 * the tree is already provisioned. On mismatch (or a missing file) it
 * re-downloads and re-extracts (repair). An empty constant means "never
 * provisioned here": download, extract, then PRINT the hash so the maintainer
 * can pin it.
 *
 * Extraction: a minimal ZIP reader implemented on node:zlib (inflateRaw for
 * method 8, stored for method 0). No new npm dependency is introduced (the
 * esbuild devDependency in packages/local-api remains the single authorized
 * exception), and no external unzip process is spawned. Only the single
 * entry `<zipstem>/node.exe` is extracted — npm/corepack and the rest of the
 * zip are never materialized on disk.
 *
 * Everything this script fetches/writes is build-time tooling:
 * - download → held entirely in memory (one Buffer per URL; the zip is never
 *   materialized on disk, so there is no %TEMP% scratch file and nothing to
 *   clean up after extraction)
 * - output → apps/desktop-shell/node-runtime/node.exe (gitignored)
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

// --- pinned constants (disclosure surface; keep in sync with mise.toml) ---

/** Aligned with mise.toml [tools] node = "25.9.0" (acceptance baseline, node 25 line). */
const NODE_VERSION = "25.9.0";
/** The one and only download origin (official distribution server). */
const DIST_BASE = "https://nodejs.org/dist";
/**
 * sha256 of the EXTRACTED node.exe, pinned so a re-run can skip the download
 * (zero network) and detect a corrupted/replaced runtime. Empty = first run:
 * download, then print the hash for pinning.
 *
 * Recorded 2026-09-30 from the first provisioned run (sha256 of the node.exe
 * extracted from node-v25.9.0-win-x64.zip whose own zip sha256
 * 929552b8305effac843ba7b4270c437aefb702fc3fbd73fcd1bffd35d4ac284e was
 * verified against the same origin's SHASUMS256.txt).
 */
const NODE_EXE_SHA256 = "98843732431bad6c2c165908bb7dde6fe2a221ddbc491a955d548a2e6ab9ebff";

// --- derived paths ---

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(repoRoot, "apps", "desktop-shell", "node-runtime");
const outExe = path.join(outDir, "node.exe");
const zipName = `node-v${NODE_VERSION}-win-x64.zip`;
const zipUrl = `${DIST_BASE}/v${NODE_VERSION}/${zipName}`;
const shasumsUrl = `${DIST_BASE}/v${NODE_VERSION}/SHASUMS256.txt`;
/** Entry name of node.exe inside the zip (single top-level directory). */
const zipEntryName = `node-v${NODE_VERSION}-win-x64/node.exe`;

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

async function fetchBuffer(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`GET ${url} -> HTTP ${response.status}`);
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Minimal ZIP single-entry extractor. Returns the DECOMPRESSED bytes of the
 * entry `wantedName`, or null when the archive has no such entry.
 *
 * Layout used (ZIP application note): locate the End Of Central Directory
 * record (scan the tail for the 0x06054b50 signature), walk the central
 * directory to find the entry (name + compression method + sizes + local
 * header offset), then read that local file header (0x04034b50) to get the
 * data offset — central-dir offsets already account for the local header,
 * but the local header's own name/extra fields can differ in length, so the
 * data start is computed from the LOCAL header, per spec.
 */
function extractEntry(zip, wantedName) {
  const eocdSignature = 0x06054b50;
  let eocd = -1;
  // EOCD is at most 22 bytes + up to 64KiB of trailing comment.
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === eocdSignature) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error("not a ZIP archive (no End Of Central Directory record)");

  const entryCount = zip.readUInt16LE(eocd + 10);
  let dirOffset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n++) {
    if (zip.readUInt32LE(dirOffset) !== 0x02014b50) {
      throw new Error(`corrupt central directory at entry ${n}`);
    }
    const method = zip.readUInt16LE(dirOffset + 10);
    const compressedSize = zip.readUInt32LE(dirOffset + 20);
    const nameLength = zip.readUInt16LE(dirOffset + 28);
    const extraLength = zip.readUInt16LE(dirOffset + 30);
    const commentLength = zip.readUInt16LE(dirOffset + 32);
    const localHeaderOffset = zip.readUInt32LE(dirOffset + 42);
    const name = zip.toString("utf8", dirOffset + 46, dirOffset + 46 + nameLength);
    if (name === wantedName) {
      // Local file header: signature(4) + fields... nameLength(26) extraLength(28).
      if (zip.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
        throw new Error(`corrupt local header for ${wantedName}`);
      }
      const localNameLength = zip.readUInt16LE(localHeaderOffset + 26);
      const localExtraLength = zip.readUInt16LE(localHeaderOffset + 28);
      const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
      const raw = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return zlib.inflateRawSync(raw);
      throw new Error(`unsupported ZIP compression method ${method} for ${wantedName}`);
    }
    dirOffset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

// --- idempotent fast path: existing node.exe matching the pinned hash ---

if (NODE_EXE_SHA256 !== "") {
  try {
    const existing = readFileSync(outExe);
    if (sha256(existing) === NODE_EXE_SHA256) {
      console.log(
        `fetch-node-runtime: ${outExe} already present and sha256 matches the pinned ` +
          `${NODE_EXE_SHA256} — download skipped (idempotent, zero network)`
      );
      process.exit(0);
    }
    console.log(
      `fetch-node-runtime: existing node.exe sha256 mismatch — re-downloading (repair)`
    );
  } catch {
    console.log(`fetch-node-runtime: ${outExe} absent — downloading`);
  }
}

// --- download + verify (SHASUMS256.txt from the SAME origin) ---

console.log(`fetch-node-runtime: GET ${zipUrl}`);
const zip = await fetchBuffer(zipUrl);
console.log(`fetch-node-runtime: zip ${zipName} = ${zip.length} bytes`);

console.log(`fetch-node-runtime: GET ${shasumsUrl}`);
const shasums = (await fetchBuffer(shasumsUrl)).toString("utf8");
const expectedLine = shasums
  .split(/\r?\n/)
  .find((line) => line.trim().endsWith(`  ${zipName}`));
if (expectedLine === undefined) {
  console.error(`fetch-node-runtime: ${zipName} not listed in ${shasumsUrl} — refusing to trust the download`);
  process.exit(1);
}
const expectedHash = expectedLine.trim().split(/\s+/)[0].toLowerCase();
const actualHash = sha256(zip);
if (actualHash !== expectedHash) {
  console.error(
    `fetch-node-runtime: SHASUMS256 mismatch for ${zipName}\n` +
      `  expected: ${expectedHash}\n` +
      `  actual:   ${actualHash}\n` +
      `  nothing was extracted or written; retry the download`
  );
  process.exit(1);
}
console.log(`fetch-node-runtime: zip sha256 verified against SHASUMS256.txt: ${actualHash}`);

// --- extract only node.exe ---

const exeBytes = extractEntry(zip, zipEntryName);
if (exeBytes === null) {
  console.error(`fetch-node-runtime: entry ${zipEntryName} not found in ${zipName}`);
  process.exit(1);
}
const exeHash = sha256(exeBytes);

// --- fail-closed BEFORE any disk write: compare the extracted bytes against
// the pinned hash first. A changed upstream artifact must never replace the
// runtime on disk — the earlier order wrote first and compared afterwards,
// so an upstream drift already had overwritten node.exe by the time this
// script exited 1. With the compare first, a mismatch leaves
// apps/desktop-shell/node-runtime/ byte-for-byte untouched.

if (NODE_EXE_SHA256 !== "" && exeHash !== NODE_EXE_SHA256) {
  console.error(
    `fetch-node-runtime: extracted node.exe sha256 ${exeHash} != pinned ${NODE_EXE_SHA256} — ` +
      `the upstream artifact changed; nothing was written to disk. ` +
      `Re-pin consciously or investigate (after a conscious re-pin the next ` +
      `run repairs the runtime by download)`
  );
  process.exit(1);
}

// --- write output (build-time tooling, gitignored directory) ---

mkdirSync(outDir, { recursive: true });
writeFileSync(outExe, exeBytes);

console.log(`fetch-node-runtime: wrote ${outExe} (${exeBytes.length} bytes)`);
console.log(`fetch-node-runtime: node.exe sha256 = ${exeHash}`);
if (NODE_EXE_SHA256 === "") {
  console.log(
    `fetch-node-runtime: NODE_EXE_SHA256 is not pinned yet — ` +
      `paste the hash above into the script to enable the zero-network idempotent path`
  );
}
