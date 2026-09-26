/**
 * PID-reuse observation (the A27 evidence base).
 *
 * Method: spawn cohorts of short-lived `cmd.exe /c exit` children with a
 * hard barrier (every child of a cohort has exited before the next cohort
 * starts), and record the PID of every spawn. A PID that reappears in a
 * later cohort necessarily belonged to an already-exited process in an
 * earlier cohort — the same numeric PID now denotes a different, later
 * process. That is precisely why "kill/verify by PID value" is unsafe and
 * identity needs the creation timestamp (see src/proc.ts).
 */
import { spawn } from "node:child_process";
import { sleep } from "./lines.js";
import { queryProcessIdentity, type ProcessIdentity } from "./proc.js";

export interface PidReuseObservation {
  readonly roundsRun: number;
  readonly cohortSize: number;
  readonly distinctPidsObserved: number;
  /** Reappearances of an earlier cohort's PID in a later cohort. */
  readonly collisionPid: number | null;
  /** Cohort index (0-based) where the collision was observed. */
  readonly collisionRound: number | null;
  /**
   * Win32_Process identity of the collision PID's current holder, captured
   * immediately at detection time (the holder is a ~1s-lived cmd.exe, so the
   * query usually lands while it is still running; null when it exited first).
   */
  readonly collisionHolderIdentity: ProcessIdentity | null;
  readonly stoppedOnFirstCollision: boolean;
  readonly pidRange: { readonly min: number; readonly max: number };
  readonly durationMs: number;
}

export interface PidReuseOptions {
  readonly maxRounds: number;
  readonly cohortSize: number;
  /** Default true: stop at the first observed collision. */
  readonly stopOnFirstCollision?: boolean;
}

/**
 * One cohort child: `cmd.exe /d /c ping -n 4 127.0.0.1` lives roughly three
 * seconds — long enough for the Win32_Process identity query of a reused PID
 * to catch its holder (PowerShell startup alone costs ~1.4s here), short
 * enough to keep the cohort barrier fast.
 */
const COHORT_CHILD_ARGS = ["/d", "/c", "ping", "-n", "4", "127.0.0.1"];

function spawnCohort(
  size: number,
  onSpawn: (pid: number) => void
): Promise<void> {
  return new Promise((resolve) => {
    let exited = 0;
    for (let i = 0; i < size; i += 1) {
      const child = spawn("cmd.exe", COHORT_CHILD_ARGS, { stdio: "ignore", windowsHide: true });
      if (child.pid !== undefined) onSpawn(child.pid);
      const done = () => {
        exited += 1;
        if (exited === size) resolve();
      };
      child.once("exit", done);
      child.once("error", done);
    }
  });
}

export async function observePidReuse(options: PidReuseOptions): Promise<PidReuseObservation> {
  const stopOnFirst = options.stopOnFirstCollision !== false;
  const started = Date.now();
  const seen = new Set<number>();
  let collisionPid: number | null = null;
  let collisionRound: number | null = null;
  let collisionHolderIdentity: ProcessIdentity | null = null;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let roundsRun = 0;

  for (let round = 0; round < options.maxRounds; round += 1) {
    // Full exit barrier before the next cohort: any PID reappearing in a
    // later cohort necessarily belonged to an already-exited process.
    let identityPromise: Promise<ProcessIdentity | null> | null = null;
    await spawnCohort(options.cohortSize, (pid) => {
      if (pid < min) min = pid;
      if (pid > max) max = pid;
      if (seen.has(pid) && collisionPid === null) {
        collisionPid = pid;
        collisionRound = round;
        // Kick off the identity query at detection time so it lands while
        // the ~1s-lived new holder is still running.
        identityPromise = queryProcessIdentity(pid);
      }
      seen.add(pid);
    });
    roundsRun += 1;
    if (collisionPid !== null) {
      collisionHolderIdentity = await identityPromise;
      if (stopOnFirst) break;
    }
  }

  return {
    roundsRun,
    cohortSize: options.cohortSize,
    distinctPidsObserved: seen.size,
    collisionPid,
    collisionRound,
    collisionHolderIdentity,
    stoppedOnFirstCollision: stopOnFirst,
    pidRange: { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 },
    durationMs: Date.now() - started
  };
}

/** Small helper so experiments can show a short liveness sample inline. */
export async function sampleLiveness(pid: number, attempts = 3): Promise<boolean[]> {
  const samples: boolean[] = [];
  for (let i = 0; i < attempts; i += 1) {
    try {
      process.kill(pid, 0);
      samples.push(true);
    } catch {
      samples.push(false);
    }
    if (i < attempts - 1) await sleep(50);
  }
  return samples;
}
