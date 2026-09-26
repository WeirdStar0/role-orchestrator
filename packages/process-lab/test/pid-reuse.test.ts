/**
 * M0-05 scenario 4 — PID reuse (A27 input).
 *
 * - Cohorts of short-lived processes with an exit barrier: a PID that
 *   reappears in a later cohort belonged to an already-exited process — the
 *   numeric value alone cannot identify a process across exits.
 * - Identity mechanism: (pid, name, parent, creation time) via Win32_Process
 *   is the discriminator; after death the identity is gone even if the PID
 *   value later returns.
 */
import { expect, test } from "vitest";
import { observePidReuse } from "../src/pidreuse.js";
import { expectPidGone, queryProcessIdentity } from "../src/proc.js";
import { taskkill } from "../src/taskkill.js";
import { requiredPid, spawnNodeProcess } from "../src/spawnproc.js";
import { withTimeout } from "../src/lines.js";
import { makeScratchDir, removeScratch } from "../src/scratch.js";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { TreeRegistry } from "../src/registry.js";

const isWindows = process.platform === "win32";
const d = isWindows ? test : test.skip;

d(
  "PID values are reused across exit barriers: the same numeric PID denotes different processes",
  { timeout: 420_000 },
  async () => {
    const observation = await observePidReuse({ maxRounds: 12, cohortSize: 150, stopOnFirstCollision: true });
    expect(
      observation.collisionPid,
      `expected a reused PID within ${observation.roundsRun} rounds x ${observation.cohortSize} spawns ` +
        `(distinct=${observation.distinctPidsObserved}, range=${observation.pidRange.min}..${observation.pidRange.max})`
    ).not.toBeNull();
    expect(observation.collisionRound ?? -1).toBeGreaterThan(0);
    // If the new holder was still alive for the identity query, it must be a
    // fresh cmd.exe with its own creation timestamp — the discriminator a
    // reconcile loop must use. (Null is acceptable: the holder may have
    // exited before the query returned; the collision itself is the proof.)
    const holder = observation.collisionHolderIdentity;
    if (holder !== null) {
      expect(holder.name.toLowerCase()).toBe("cmd.exe");
      expect(holder.creationTimeIso).not.toBeNull();
    }
  }
);

d("process identity is (pid, name, parent, creationTime); death removes it even if the PID returns", { timeout: 360_000 }, async () => {
  const scratch = makeScratchDir("identity");
  const registry = new TreeRegistry();
  try {
    // A hold-script process we can identify and then kill.
    const holdJs = path.join(scratch, "hold.js");
    writeFileSync(holdJs, "setTimeout(() => {}, 3_600_000);\n", "utf8");
    const run = spawnNodeProcess(holdJs, []);
    const pid = requiredPid(run.child);
    registry.add(pid);

    const identity = await queryProcessIdentity(pid);
    expect(identity, "identity of a live child must be resolvable").not.toBeNull();
    expect(identity!.name.toLowerCase()).toBe("node.exe");
    expect(identity!.parentPid).toBe(process.pid);
    expect(identity!.creationTimeIso).not.toBeNull();
    const creation = new Date(identity!.creationTimeIso!);
    expect(Number.isNaN(creation.getTime()), `creation time parses: ${identity!.creationTimeIso}`).toBe(false);
    expect(creation.getTime()).toBeLessThanOrEqual(Date.now());

    const kill = await taskkill(pid, { force: true });
    expect(kill.exitCode).toBe(0);
    await withTimeout(run.exit, 30_000, "hold process exit");
    await expectPidGone(pid);
    const after = await queryProcessIdentity(pid);
    expect(after === null || after.creationTimeIso !== identity!.creationTimeIso).toBe(true);
  } finally {
    await registry.reapAll();
    removeScratch(scratch);
  }
});
