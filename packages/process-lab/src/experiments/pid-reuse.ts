/**
 * Experiment 4 — PID reuse in an observation window (A27 input).
 *
 * Cohorts of short-lived processes with an exit barrier; a PID reappearing
 * in a later cohort proves the same numeric value now denotes a different
 * process. The current holder's Win32_Process identity (fresh creation
 * timestamp) is captured as the discriminator.
 */
import { observePidReuse } from "../pidreuse.js";
import type { LabResult } from "../scratch.js";

export async function runPidReuseExperiment(): Promise<LabResult> {
  const observation = await observePidReuse({
    maxRounds: 12,
    cohortSize: 150,
    stopOnFirstCollision: true
  });
  return {
    ok: observation.collisionPid !== null,
    method: "cohorts of `cmd.exe /d /c ping -n 4 127.0.0.1` (~3s lifetime) with a full exit barrier between rounds",
    observation
  };
}
