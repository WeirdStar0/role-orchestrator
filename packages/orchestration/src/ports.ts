/**
 * M10-02 M12 (ports) — the injected side-effect ports of the run driver.
 *
 * Production keeps today's exact behavior: the default Clock is the system
 * wall clock (the former local `nowIso()`) and the default LogSink writes the
 * redacted, newline-terminated note to process.stdout (the former
 * `logPumpNote`). The stdout FORM is deliberately unchanged (strategy ⑧: the
 * serve diagnostic line -> shell drain coupling was surveyed; do not touch
 * the wire format from here) — the ports exist so test harnesses and future
 * composition roots can inject a deterministic clock / captured sink without
 * forking the driver.
 */
import { redactText } from "@role-orchestrator/cli-events";

/** Time source of the driver. Production: the system wall clock. */
export interface Clock {
  /** The driver's `now` for every store write, ISO-8601. */
  readonly nowIso: () => string;
}

/** The system wall clock — the production default (the former `nowIso`). */
export const systemClock: Clock = {
  nowIso: () => new Date().toISOString()
};

/** Log sink of the driver. Production: redacted stdout notes. */
export interface LogSink {
  /** One driver note (pump round bound, chain fault). Already one line. */
  readonly log: (message: string) => void;
}

/**
 * The production default sink: redactText FIRST, then one `\n`-terminated
 * line on the given writer (process.stdout when omitted) — byte-identical to
 * the former orchestrator.ts `logPumpNote`.
 */
export function createStdoutLogSink(writer: { write: (chunk: string) => void } = process.stdout): LogSink {
  return {
    log: (message: string): void => {
      writer.write(`${redactText(message).text}\n`);
    }
  };
}
