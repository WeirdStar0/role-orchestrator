/**
 * Deterministic sequence clock for the baseline driver.
 *
 * All DB timestamps the DRIVER controls come from this clock: a fixed-width
 * UTC ISO string advancing `stepMs` per `tick()` call. The whole baseline is
 * therefore reproducible run-to-run (same derived ids, same integration
 * identity) as long as content and commit environments are deterministic too.
 *
 * The step (1s per tick) keeps synthetic time strictly monotonic across the
 * many driver calls of one round while staying far below the scheduler lease
 * window, so grants never expire mid-run.
 */
export const BASELINE_T0 = "2026-09-22T00:00:00.000Z";

export interface SequenceClock {
  /** Next timestamp; each call advances synthetic time by one step. */
  tick(): string;
  /** Current synthetic time without advancing (diagnostics only). */
  now(): string;
  /** How many ticks have been consumed. */
  ticks(): number;
}

export function createSequenceClock(options?: { start?: string; stepMs?: number }): SequenceClock {
  const startMs = Date.parse(options?.start ?? BASELINE_T0);
  if (Number.isNaN(startMs)) {
    throw new Error(`sequence clock: invalid start timestamp ${String(options?.start)}`);
  }
  const stepMs = options?.stepMs ?? 1_000;
  let count = 0;
  return {
    tick: (): string => {
      count += 1;
      return new Date(startMs + count * stepMs).toISOString();
    },
    now: (): string => new Date(startMs + count * stepMs).toISOString(),
    ticks: (): number => count
  };
}
