/**
 * The worker half of the A07 stress test. Runs as a REAL thread via
 * `worker_threads` against the BUILT package (`dist/index.js`) — the same
 * code the scheduler ships, exercised through its public API on its own
 * `node:sqlite` connection, so fencing and quota atomicity are proven across
 * threads and connections, not just within one process.
 *
 * NOTE: `pnpm test` runs through turbo with `build` as a dependency, so
 * `dist/` exists when this file executes. Running vitest directly WITHOUT a
 * prior build fails here by design (import error) — that is a build-order
 * precondition, never a skipped assertion.
 *
 * M4-04 note — deterministic contention protocol (the "contention really
 * happened" assertion used to be timing-dependent: under a fully loaded
 * machine, thread startup could stagger so far that no worker ever hit a
 * quota-full window). The protocol is now barrier-synchronized and the
 * contention is guaranteed BY CONSTRUCTION:
 *
 *   1. every worker connects, then reports `ready` and BLOCKS on the start
 *      flag (cell 0 of the shared buffer) — no acquisition happens early;
 *   2. the parent waits for ALL workers to be ready, then releases the
 *      barrier, so all N workers race on the slots simultaneously;
 *   3. phase 1 = exactly ONE acquire attempt per worker. A worker that gets
 *      a grant HOLDS it (no release) until the parent raises the release
 *      flag (cell 1) — which the parent only raises after all N first-attempt
 *      reports are in. Since the global slot count is < N and grants are
 *      all-or-nothing, every other worker's first attempt MUST fail with
 *      quota-full: at least N - max per-level contention events, no matter
 *      how the OS schedules the threads;
 *   4. phase 2 = losers retry through normal quota-full rejections until
 *      each acquires exactly once, then releases.
 */
import { parentPort, workerData } from "node:worker_threads";

// `Atomics` is a global, not a module export — used for synchronous sleeps
// and for the barrier flags.

const { dbPath, executionId, slots, leaseMs, holdMsMin, holdMsMax, sab } = workerData;
const flags = new Int32Array(sab);
const CELL_START = 0;
const CELL_RELEASE = 1;

const packageEntry = new URL("../../dist/index.js", import.meta.url);
const scheduler = await import(packageEntry);
// openDatabase (pragmas: WAL, busy_timeout, foreign_keys) belongs to the
// store package; the scheduler package does not re-export connection concerns.
const store = await import(new URL("../../../store/dist/index.js", import.meta.url));
const { acquireQuotaSlots, releaseExecutionQuotaGrants } = scheduler;
const { openDatabase } = store;

const db = openDatabase(dbPath);

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Block until the parent raises the given flag cell. */
function waitForFlag(cell) {
  while (Atomics.load(flags, cell) === 0) {
    Atomics.wait(flags, cell, 0);
  }
}

function post(message) {
  parentPort.postMessage(message);
}

const report = { executionId, granted: 0, quotaFull: 0, errors: [] };

// Acquisitions may raise transient SQLITE_BUSY ("database is locked") when
// 24 connections contend for the write lock — that is a transport-level
// retry, never a protocol verdict. Bounded by a wall-clock deadline so a
// broken scheduler surfaces as a recorded error, not a hung thread.
const DEADLINE = Date.now() + 45_000;
function acquireWithRetry() {
  while (true) {
    try {
      return acquireQuotaSlots(db, { executionId, slots, leaseMs, now: new Date().toISOString() });
    } catch (error) {
      if (Date.now() > DEADLINE) {
        throw error;
      }
      sleep(5);
    }
  }
}

try {
  // Ready barrier: report, then block until ALL workers are connected.
  post({ type: "ready", executionId });
  waitForFlag(CELL_START);

  // Phase 1 — exactly ONE acquire attempt. A granted worker HOLDS the slot
  // until the parent's release flag: every other worker's first attempt must
  // see quota-full (the parent guarantees this by waiting for all first
  // attempts before releasing).
  const first = acquireWithRetry();
  if (first.granted) {
    report.granted += 1;
    post({ type: "first", executionId, granted: true });
    waitForFlag(CELL_RELEASE);
    releaseExecutionQuotaGrants(db, { executionId, now: new Date().toISOString() });
    post({ type: "done", executionId, ...report });
  } else {
    report.quotaFull += 1;
    post({ type: "first", executionId, granted: false });

    // Phase 2 — retry through quota-full rejections until the acquisition
    // lands.
    let acquired = false;
    while (!acquired) {
      const result = acquireWithRetry();
      if (result.granted) {
        report.granted += 1;
        const hold = holdMsMin + Math.floor(Math.random() * (holdMsMax - holdMsMin));
        sleep(hold);
        releaseExecutionQuotaGrants(db, { executionId, now: new Date().toISOString() });
        acquired = true;
      } else {
        report.quotaFull += 1;
        if (Date.now() > DEADLINE) {
          report.errors.push("deadline exceeded without acquiring a quota slot");
          break;
        }
        sleep(2 + Math.floor(Math.random() * 6));
      }
    }
    post({ type: "done", executionId, ...report });
  }
} catch (error) {
  report.errors.push(String((error && error.stack) || error));
  post({ type: "done", executionId, ...report });
} finally {
  db.close();
}
