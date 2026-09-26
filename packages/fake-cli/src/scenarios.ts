/**
 * Scenario registry: converts a (dialect, scenario, variant) selection into a
 * deterministic list of frames. The runner executes frames against the real
 * process; the fixture generator renders only the stdout frames to files.
 *
 * Frame streams are pure data — no clock reads, no PIDs — so pregenerated
 * fixtures stay byte-for-byte stable. Dynamic scenarios (grandchild) are not
 * fixture-able by design.
 */
import {
  codexError,
  codexActionProposalRequested,
  codexGrandchildReport,
  codexInterruptedDelta,
  codexItemCompleted,
  codexItemStarted,
  codexThreadStarted,
  codexTurnCompleted,
  codexTurnFailed,
  codexTurnStarted,
  claudeActionProposalRequest,
  claudeArtifact,
  claudeAssistantText,
  claudeError,
  claudeGrandchildReport,
  claudeInit,
  claudeInterruptedDelta,
  claudeResult,
  claudeToolResult,
  claudeToolUse,
  syntheticBanner,
  SCHEMA_INVALID_BUSINESS_RESULT,
  VALID_BUSINESS_RESULT,
  type Dialect,
  type Raw
} from "./events.js";

export type Frame =
  | { readonly kind: "stdout"; readonly line: string; readonly truncatedTail?: boolean | undefined }
  | { readonly kind: "stderr"; readonly text: string }
  | { readonly kind: "wait"; readonly ms: number }
  | { readonly kind: "arm-interrupt" }
  | { readonly kind: "spawn-chain" }
  | { readonly kind: "grandchild-report" }
  | { readonly kind: "hold" }
  | { readonly kind: "exit"; readonly code: number };

export const SCENARIOS = [
  "success",
  "error-result",
  "truncated",
  "fake-success",
  "timeout",
  "grandchild",
  "interrupt",
  "action-proposal"
] as const;
export type Scenario = (typeof SCENARIOS)[number];

export function isScenario(value: string): value is Scenario {
  return (SCENARIOS as readonly string[]).includes(value);
}

export const FAKE_SUCCESS_VARIANTS = ["error-final", "missing-final", "schema-invalid"] as const;
export type FakeSuccessVariant = (typeof FAKE_SUCCESS_VARIANTS)[number];

export interface ScenarioSpec {
  readonly dialect: Dialect;
  readonly scenario: Scenario;
  readonly variant: string | undefined;
  readonly delayMs: number;
  /**
   * M4-02 `action-proposal` only: the path the agent's proposal wants to
   * write. The path is embedded VERBATIM in the emitted proposal payload so
   * checkpoint tests can bind a real sentinel file to the proposed action.
   */
  readonly proposeWritePath?: string | undefined;
}

function stdout(line: string): Frame {
  return { kind: "stdout", line };
}

function json(raw: Raw): string {
  return JSON.stringify(raw);
}

// ---------------------------------------------------------------------------
// Per-scenario stdout frames
// ---------------------------------------------------------------------------

function bannerFrames(spec: ScenarioSpec): Frame[] {
  return [{ kind: "stderr", text: syntheticBanner(spec.dialect, spec.scenario, spec.variant) }];
}

function successFrames(dialect: Dialect): Frame[] {
  if (dialect === "claude") {
    return [
      stdout(json(claudeInit())),
      stdout(json(claudeAssistantText("Analyzing the synthetic task"))),
      stdout(json(claudeToolUse("toolu_synth_1", "Bash", { command: "pnpm test" }))),
      stdout(json(claudeToolResult("toolu_synth_1", "tests passed (synthetic)"))),
      // Multibyte characters on purpose: fixtures feed the UTF-8 parser tests.
      stdout(json(claudeAssistantText("分析完成 🎉 all good"))),
      stdout(json(claudeArtifact("artifact_fake_report", "report"))),
      stdout(
        json(
          claudeResult({
            subtype: "success",
            isError: false,
            businessResult: VALID_BUSINESS_RESULT,
            usage: { input_tokens: 42, output_tokens: 7 }
          })
        )
      )
    ];
  }
  return [
    stdout(json(codexThreadStarted())),
    stdout(json(codexTurnStarted())),
    stdout(
      json(
        codexItemStarted({ id: "item_1", type: "command_execution", command: "pnpm test", status: "in_progress" })
      )
    ),
    stdout(
      json(
        codexItemCompleted({
          id: "item_1",
          type: "command_execution",
          command: "pnpm test",
          status: "completed",
          exit_code: 0,
          aggregated_output: "tests passed (synthetic)"
        })
      )
    ),
    stdout(json(codexItemCompleted({ id: "item_2", type: "agent_message", text: "分析完成 🎉 all good" }))),
    stdout(json(codexItemCompleted({ id: "item_3", type: "file_change", paths: ["report.md"] }))),
    stdout(
      json(
        codexTurnCompleted(
          { input_tokens: 42, cached_input_tokens: 0, output_tokens: 7 },
          VALID_BUSINESS_RESULT
        )
      )
    )
  ];
}

function errorResultFrames(dialect: Dialect): Frame[] {
  if (dialect === "claude") {
    return [
      stdout(json(claudeInit())),
      stdout(json(claudeAssistantText("Attempting the synthetic task"))),
      stdout(json(claudeError("synthetic tool failure (error-result scenario)"))),
      stdout(
        json(
          claudeResult({
            subtype: "error_during_execution",
            isError: true,
            usage: { input_tokens: 11, output_tokens: 2 }
          })
        )
      )
    ];
  }
  return [
    stdout(json(codexThreadStarted())),
    stdout(json(codexTurnStarted())),
    stdout(json(codexItemCompleted({ id: "item_1", type: "agent_message", text: "Attempting the synthetic task" }))),
    stdout(json(codexError("synthetic turn failure (error-result scenario)"))),
    stdout(json(codexTurnFailed("synthetic turn failure (error-result scenario)")))
  ];
}

function truncatedFrames(dialect: Dialect): Frame[] {
  if (dialect === "claude") {
    const full = json(
      claudeResult({
        subtype: "success",
        isError: false,
        businessResult: VALID_BUSINESS_RESULT,
        usage: { input_tokens: 42, output_tokens: 7 }
      })
    );
    // Cut mid-key so the tail is unparseable JSON.
    return [
      stdout(json(claudeInit())),
      stdout(json(claudeAssistantText("Streaming the synthetic answer"))),
      { kind: "stdout", line: full.slice(0, Math.floor(full.length / 2)), truncatedTail: true }
    ];
  }
  const full = json(codexTurnCompleted({ input_tokens: 42, cached_input_tokens: 0, output_tokens: 7 }));
  return [
    stdout(json(codexThreadStarted())),
    stdout(json(codexTurnStarted())),
    stdout(json(codexItemCompleted({ id: "item_1", type: "agent_message", text: "Streaming the synthetic answer" }))),
    { kind: "stdout", line: full.slice(0, Math.floor(full.length / 2)), truncatedTail: true }
  ];
}

function fakeSuccessFrames(dialect: Dialect, variant: FakeSuccessVariant): Frame[] {
  if (dialect === "claude") {
    if (variant === "missing-final") {
      return [
        stdout(json(claudeInit())),
        stdout(json(claudeAssistantText("Looks done but the final result is missing"))),
        stdout(json(claudeAssistantText("still no result event")))
      ];
    }
    if (variant === "schema-invalid") {
      return [
        stdout(json(claudeInit())),
        stdout(json(claudeAssistantText("Claiming success with a broken business payload"))),
        stdout(
          json(
            claudeResult({
              subtype: "success",
              isError: false,
              businessResult: SCHEMA_INVALID_BUSINESS_RESULT,
              usage: { input_tokens: 5, output_tokens: 5 }
            })
          )
        )
      ];
    }
    // error-final: exit 0 while the final result reports an error.
    return [
      stdout(json(claudeInit())),
      stdout(json(claudeAssistantText("Claiming exit-code success while the result is an error"))),
      stdout(json(claudeResult({ subtype: "error_during_execution", isError: true })))
    ];
  }
  if (variant === "missing-final") {
    return [
      stdout(json(codexThreadStarted())),
      stdout(json(codexTurnStarted())),
      stdout(json(codexItemCompleted({ id: "item_1", type: "agent_message", text: "Looks done but turn.completed is missing" })))
    ];
  }
  if (variant === "schema-invalid") {
    return [
      stdout(json(codexThreadStarted())),
      stdout(json(codexTurnStarted())),
      stdout(
        json(
          codexTurnCompleted(
            { input_tokens: 5, cached_input_tokens: 0, output_tokens: 5 },
            SCHEMA_INVALID_BUSINESS_RESULT
          )
        )
      )
    ];
  }
  return [
    stdout(json(codexThreadStarted())),
    stdout(json(codexTurnStarted())),
    stdout(json(codexItemCompleted({ id: "item_1", type: "agent_message", text: "Claiming exit-code success while the turn failed" }))),
    stdout(json(codexTurnFailed("synthetic fake success (turn.failed but exit 0)")))
  ];
}

function timeoutFrames(dialect: Dialect): Frame[] {
  if (dialect === "claude") {
    return [
      stdout(json(claudeInit())),
      stdout(json(claudeAssistantText("Hanging forever (timeout scenario)"))),
      stdout(json(claudeAssistantText("never going to finish")))
    ];
  }
  return [
    stdout(json(codexThreadStarted())),
    stdout(json(codexTurnStarted())),
    stdout(json(codexItemCompleted({ id: "item_1", type: "agent_message", text: "Hanging forever (timeout scenario)" })))
  ];
}

function interruptFrames(dialect: Dialect): Frame[] {
  if (dialect === "claude") {
    return [
      stdout(json(claudeInit())),
      stdout(json(claudeAssistantText("Streaming until interrupted"))),
      stdout(json(claudeAssistantText("partial work")))
    ];
  }
  return [
    stdout(json(codexThreadStarted())),
    stdout(json(codexTurnStarted())),
    stdout(json(codexItemCompleted({ id: "item_1", type: "agent_message", text: "Streaming until interrupted" })))
  ];
}

function grandchildFrames(dialect: Dialect): Frame[] {
  if (dialect === "claude") {
    return [stdout(json(claudeInit())), { kind: "spawn-chain" }, { kind: "grandchild-report" }];
  }
  return [stdout(json(codexThreadStarted())), { kind: "spawn-chain" }, { kind: "grandchild-report" }];
}

/**
 * M4-02: the agent PROPOSES writing a file instead of writing it. The stream
 * carries a structured action proposal (claude: a control_request whose
 * can_use_tool input embeds `actionProposal`; codex: an approval.requested —
 * whose real-shape mapping carries no proposal payload, so extraction from a
 * codex proposal stream is deliberately unparsable). The process then exits 0
 * WITHOUT a final result: the CLI ended safely, exactly the checkpoint
 * pre-condition — no side effect ever happened in this process.
 */
function actionProposalFrames(dialect: Dialect, writePath: string): Frame[] {
  const proposal: Raw = {
    schemaVersion: 1,
    proposalId: "propose-write-1",
    action: {
      argv: ["fake-agent", "write", "--path", writePath],
      dimensions: ["write"],
      writeScope: "unscoped",
      requiredPermissions: ["repo.write"],
      requiredCapabilities: [`${dialect}.noninteractive-entry`],
      targetSha: null,
      requiresInteractiveApproval: false
    }
  };
  if (dialect === "claude") {
    return [
      stdout(json(claudeInit())),
      stdout(json(claudeAssistantText("Proposing a controlled write instead of performing it"))),
      stdout(json(claudeActionProposalRequest("req_proposal_1", "write_file", { actionProposal: proposal })))
    ];
  }
  return [
    stdout(json(codexThreadStarted())),
    stdout(json(codexTurnStarted())),
    stdout(json(codexItemCompleted({ id: "item_1", type: "agent_message", text: "Proposing a controlled write instead of performing it" }))),
    stdout(json(codexActionProposalRequested("req_proposal_1", "write_file", proposal)))
  ];
}

/** Interrupt-time delta emitted when the graceful shutdown path runs. */
export function interruptDeltaLine(dialect: Dialect): string {
  return dialect === "claude" ? json(claudeInterruptedDelta()) : json(codexInterruptedDelta());
}

/** Event carrying the spawned child/grandchild PIDs (dynamic, never fixed). */
export function grandchildReportLine(dialect: Dialect, childPid: number, grandchildPid: number): string {
  return dialect === "claude"
    ? json(claudeGrandchildReport(childPid, grandchildPid))
    : json(codexGrandchildReport(childPid, grandchildPid));
}

// ---------------------------------------------------------------------------

/**
 * Builds the full frame list for one scenario selection. Throws on unknown
 * scenario/variant combinations — the CLI never guesses.
 */
export function buildScenarioFrames(spec: ScenarioSpec): Frame[] {
  const delayMs = spec.delayMs ?? 0;
  const withDelays = (frames: Frame[]): Frame[] => {
    const out: Frame[] = [];
    for (const frame of frames) {
      out.push(frame);
      if (frame.kind === "stdout" && delayMs > 0) out.push({ kind: "wait", ms: delayMs });
    }
    return out;
  };

  const variant = spec.variant;
  let body: Frame[];
  let exit: Frame;
  switch (spec.scenario) {
    case "success":
      body = successFrames(spec.dialect);
      exit = { kind: "exit", code: 0 };
      break;
    case "error-result":
      body = errorResultFrames(spec.dialect);
      exit = { kind: "exit", code: 1 };
      break;
    case "truncated":
      body = truncatedFrames(spec.dialect);
      // Exit 0 on purpose: proves the parser detects truncation even when the
      // exit code alone would look successful.
      exit = { kind: "exit", code: 0 };
      break;
    case "fake-success": {
      if (variant !== undefined && !(FAKE_SUCCESS_VARIANTS as readonly string[]).includes(variant)) {
        throw new Error(`unknown fake-success variant: ${variant ?? "(none)"} (expected one of ${FAKE_SUCCESS_VARIANTS.join(", ")})`);
      }
      const v: FakeSuccessVariant = variant === undefined ? "error-final" : (variant as FakeSuccessVariant);
      body = fakeSuccessFrames(spec.dialect, v);
      exit = { kind: "exit", code: 0 };
      break;
    }
    case "timeout":
      if (variant !== undefined) throw new Error(`scenario "timeout" takes no variant`);
      body = timeoutFrames(spec.dialect);
      exit = { kind: "hold" };
      break;
    case "interrupt":
      if (variant !== undefined) throw new Error(`scenario "interrupt" takes no variant`);
      body = interruptFrames(spec.dialect);
      exit = { kind: "arm-interrupt" };
      break;
    case "grandchild":
      if (variant !== undefined) throw new Error(`scenario "grandchild" takes no variant`);
      body = grandchildFrames(spec.dialect);
      exit = { kind: "hold" };
      break;
    case "action-proposal": {
      if (variant !== undefined) throw new Error(`scenario "action-proposal" takes no variant`);
      if (spec.proposeWritePath === undefined || spec.proposeWritePath.length === 0) {
        throw new Error(`scenario "action-proposal" requires --propose-write <path>`);
      }
      body = actionProposalFrames(spec.dialect, spec.proposeWritePath);
      // Exit 0 without a final result: the CLI ended safely mid-task (the
      // checkpoint pre-condition), so the protocol verdict stays a failure.
      exit = { kind: "exit", code: 0 };
      break;
    }
    default: {
      const never: never = spec.scenario;
      throw new Error(`unknown scenario: ${String(never)}`);
    }
  }
  return [...bannerFrames(spec), ...withDelays(body), exit];
}

// ---------------------------------------------------------------------------
// Pregenerated fixture registry
// ---------------------------------------------------------------------------

export interface FixtureSpec {
  readonly file: string;
  readonly dialect: Dialect;
  readonly scenario: Scenario;
  readonly variant: string | null;
  readonly exitCode: number;
  readonly expected: {
    readonly success: boolean;
    /** Exact failure-reason list produced by @role-orchestrator/cli-events. */
    readonly failureReasons: readonly string[];
  };
}

const FAILURE_REASONS = {
  errorResult: ["nonzero-exit", "final-result-error"],
  truncated: ["protocol-error", "missing-final-result"],
  fakeSuccessErrorFinal: ["final-result-error"],
  fakeSuccessMissingFinal: ["missing-final-result"],
  fakeSuccessSchemaInvalid: ["business-schema-invalid"],
  success: []
} as const;

/**
 * The pregenerated fixture set: every entry is written to
 * `fixtures/<file>` by `pnpm generate:fixtures` and parsed by cli-events
 * tests. Keep this the single source of truth.
 */
export function listFixtureSpecs(): FixtureSpec[] {
  const specs: FixtureSpec[] = [];
  for (const dialect of ["claude", "codex"] as const) {
    specs.push(
      {
        file: `${dialect}-success.synthetic.jsonl`,
        dialect,
        scenario: "success",
        variant: null,
        exitCode: 0,
        expected: { success: true, failureReasons: FAILURE_REASONS.success }
      },
      {
        file: `${dialect}-error-result.synthetic.jsonl`,
        dialect,
        scenario: "error-result",
        variant: null,
        exitCode: 1,
        expected: { success: false, failureReasons: [...FAILURE_REASONS.errorResult] }
      },
      {
        file: `${dialect}-truncated.synthetic.jsonl`,
        dialect,
        scenario: "truncated",
        variant: null,
        exitCode: 0,
        expected: { success: false, failureReasons: [...FAILURE_REASONS.truncated] }
      },
      {
        file: `${dialect}-fake-success-error-final.synthetic.jsonl`,
        dialect,
        scenario: "fake-success",
        variant: "error-final",
        exitCode: 0,
        expected: { success: false, failureReasons: [...FAILURE_REASONS.fakeSuccessErrorFinal] }
      },
      {
        file: `${dialect}-fake-success-missing-final.synthetic.jsonl`,
        dialect,
        scenario: "fake-success",
        variant: "missing-final",
        exitCode: 0,
        expected: { success: false, failureReasons: [...FAILURE_REASONS.fakeSuccessMissingFinal] }
      },
      {
        file: `${dialect}-fake-success-schema-invalid.synthetic.jsonl`,
        dialect,
        scenario: "fake-success",
        variant: "schema-invalid",
        exitCode: 0,
        expected: { success: false, failureReasons: [...FAILURE_REASONS.fakeSuccessSchemaInvalid] }
      }
    );
  }
  return specs;
}

/**
 * Renders only the stdout frames — the fixture file content. Byte-faithful to
 * what the runner writes: lines are newline-terminated except a truncated
 * tail, which by definition ends without a newline.
 */
export function framesToFixtureText(frames: readonly Frame[]): string {
  const stdoutFrames = frames.filter(
    (frame): frame is Extract<Frame, { kind: "stdout" }> => frame.kind === "stdout"
  );
  if (stdoutFrames.length === 0) return "";
  const text = stdoutFrames.map((frame) => frame.line).join("\n");
  const last = stdoutFrames[stdoutFrames.length - 1];
  return last !== undefined && last.truncatedTail === true ? text : `${text}\n`;
}
