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

/**
 * M10-03 — the node-output commit port (the controlled Git-Service commit
 * step of docs/GIT_AND_WORKSPACES.md "提交与集成": path checks + secret scan
 * + "仅提交允许的文件" are the IMPLEMENTATION's responsibility, not the
 * driver's). Injected per composition root via RunDriverPorts; the PRODUCTION
 * composition root passes none, and the driver then never commits — an agent
 * node's accepted output is its inputSha (the doctrine's "没有代码修改的节点
 * 沿用 inputSha"), which is exactly the v0.2.1 single-node behavior.
 *
 * GUARD: the port is consulted ONLY for multi-node runs (runs created with a
 * workflow graph) — the v0.2.1 single-node path never commits, regardless of
 * injection. Like the M8 validation command, no command/argv ever crosses
 * this surface: the implementation performs its own git calls.
 */
export interface OutputCommitter {
  readonly commitNodeOutput: (input: {
    readonly runId: string;
    readonly nodeId: string;
    readonly executionId: string;
    readonly attempt: number;
    readonly worktreePath: string;
    /** The commit the node's worktree started from (its inputSha). */
    readonly baselineSha: string;
  }) => Promise<string | null>;
}
