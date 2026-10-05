/**
 * Strict argument parsing for the fake CLI bins.
 *
 * Known real-CLI-shaped flags (`-p`, `--output-format`, `exec`, `--json`, ...)
 * are accepted and IGNORED so the fake can sit where the real invocation form
 * would be; every other unknown argument is rejected with exit code 2 — the
 * same "unknown fields are rejected by default" stance the product takes on
 * inputs.
 */
import { FAKE_SUCCESS_VARIANTS, isScenario, type Scenario } from "./scenarios.js";
import type { Dialect } from "./events.js";

export class CliUsageError extends Error {}

/** Real-shape flags accepted without a value and ignored. */
const IGNORED_BOOLEAN: Record<Dialect, readonly string[]> = {
  claude: ["-p", "--print", "--verbose"],
  codex: ["exec", "--json", "--skip-git-repo-check"]
};

/** Real-shape flags accepted with a value and ignored. */
const IGNORED_WITH_VALUE: Record<Dialect, readonly string[]> = {
  claude: ["--output-format", "--model"],
  codex: ["-m", "--model", "--sandbox", "--output-last-message-file"]
};

export interface ParsedArgs {
  readonly help: boolean;
  readonly scenario: Scenario | undefined;
  readonly variant: string | undefined;
  readonly delayMs: number;
  readonly interruptOn: "signal" | "stdin-close";
  readonly emitFixturePath: string | undefined;
  /**
   * M4-02: path embedded in the `action-proposal` scenario's structured
   * action proposal (the agent proposes to write this path; nothing writes it).
   */
  readonly proposeWritePath: string | undefined;
  /**
   * M4-02: a TEST-CONTROLLED side effect — when set, the process writes this
   * file at startup. Exists so checkpoint tests can prove that only an
   * execution explicitly launched with this flag performs the action.
   */
  readonly writeFilePath: string | undefined;
  /**
   * M10-03 `review` scenario only: the relative path whose presence in the
   * process cwd decides the structured review verdict (pass when present,
   * fail with one finding when not).
   */
  readonly reviewExistsPath: string | undefined;
}

export function usage(dialect: Dialect): string {
  return [
    `fake-${dialect} — SYNTHETIC ${dialect} dialect event stream (not a real CLI binary).`,
    "",
    "Usage:",
    `  fake-${dialect} --scenario <name> [--variant <v>] [real-CLI-shaped flags are accepted and ignored]`,
    "",
    "Scenarios:",
    "  success        normal streaming to a final result, exit 0",
    "  error-result   error events plus a nonzero exit code",
    "  truncated      last JSONL line cut off mid-JSON (exit 0 on purpose)",
    "  fake-success   exit 0 but the final result reports an error or is missing",
    "                 variants: error-final (default) | missing-final | schema-invalid",
    "  timeout        hangs until killed externally",
    "  grandchild     spawns child -> grandchild, reports both PIDs, hangs until killed",
    "  interrupt      emits a partial stream, then exits nonzero on SIGINT/SIGTERM",
    "                 (or on stdin EOF with --interrupt-on stdin-close)",
    "  action-proposal emits a control_request carrying a structured action",
    "                 proposal (requires --propose-write), then exits 0 without",
    "                 a final result — the node-checkpoint pre-condition",
    "  review         emits a final structured result whose frozen review field",
    "                 carries verdict pass iff --review-exists resolves in the",
    "                 process cwd (else fail with one finding); exit 0 either way",
    "",
    "Options:",
    "  --scenario <name>         scenario to run (required)",
    "  --variant <v>             variant for fake-success",
    "  --delay-ms <n>            delay between protocol lines (default 0)",
    "  --interrupt-on <mode>     signal (default) | stdin-close",
    "  --emit-fixture <path>     write the deterministic stdout frames to <path> and exit",
    "  --propose-write <path>    path embedded in the action-proposal scenario's proposal",
    "  --write-file <path>       TEST side effect: write <path> at process start",
    "  --review-exists <path>    relative path the review scenario checks for its verdict",
    "  -h, --help                show this help",
    "",
    "Every emitted JSON line contains \"synthetic\": true; a SYNTHETIC banner is",
    "printed to stderr at startup. Output is synthetic test data only."
  ].join("\n");
}

export function parseArgs(dialect: Dialect, argv: readonly string[]): ParsedArgs {
  const result: {
    help: boolean;
    scenario: Scenario | undefined;
    variant: string | undefined;
    delayMs: number;
    interruptOn: "signal" | "stdin-close";
    emitFixturePath: string | undefined;
    proposeWritePath: string | undefined;
    writeFilePath: string | undefined;
    reviewExistsPath: string | undefined;
  } = {
    help: false,
    scenario: undefined,
    variant: undefined,
    delayMs: 0,
    interruptOn: "signal",
    emitFixturePath: undefined,
    proposeWritePath: undefined,
    writeFilePath: undefined,
    reviewExistsPath: undefined
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    const value = (): string => {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new CliUsageError(`option ${token} requires a value`);
      }
      i += 1;
      return next;
    };

    if (token === "--help" || token === "-h") {
      result.help = true;
      continue;
    }
    if (token === "--scenario") {
      const scenario = value();
      if (!isScenario(scenario)) {
        throw new CliUsageError(`unknown scenario: ${scenario}`);
      }
      result.scenario = scenario;
      continue;
    }
    if (token === "--variant") {
      const variant = value();
      if (!(FAKE_SUCCESS_VARIANTS as readonly string[]).includes(variant)) {
        throw new CliUsageError(
          `unknown variant: ${variant} (expected one of ${FAKE_SUCCESS_VARIANTS.join(", ")})`
        );
      }
      result.variant = variant;
      continue;
    }
    if (token === "--delay-ms") {
      const raw = value();
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new CliUsageError(`--delay-ms must be a non-negative integer, got: ${raw}`);
      }
      result.delayMs = parsed;
      continue;
    }
    if (token === "--interrupt-on") {
      const mode = value();
      if (mode !== "signal" && mode !== "stdin-close") {
        throw new CliUsageError(`--interrupt-on must be "signal" or "stdin-close", got: ${mode}`);
      }
      result.interruptOn = mode;
      continue;
    }
    if (token === "--emit-fixture") {
      result.emitFixturePath = value();
      continue;
    }
    if (token === "--propose-write") {
      result.proposeWritePath = value();
      continue;
    }
    if (token === "--write-file") {
      result.writeFilePath = value();
      continue;
    }
    if (token === "--review-exists") {
      result.reviewExistsPath = value();
      continue;
    }
    if ((IGNORED_BOOLEAN[dialect] as readonly string[]).includes(token)) {
      continue;
    }
    if ((IGNORED_WITH_VALUE[dialect] as readonly string[]).includes(token)) {
      value();
      continue;
    }
    if (token.startsWith("-")) {
      throw new CliUsageError(`unknown option: ${token}`);
    }
    throw new CliUsageError(`unexpected positional argument: ${token}`);
  }

  if (!result.help && result.scenario === undefined) {
    throw new CliUsageError("missing required --scenario");
  }
  if (result.scenario === "action-proposal" && (result.proposeWritePath === undefined || result.proposeWritePath.length === 0)) {
    throw new CliUsageError(`scenario "action-proposal" requires --propose-write <path>`);
  }
  if (result.proposeWritePath !== undefined && result.scenario !== "action-proposal") {
    throw new CliUsageError(`--propose-write is only valid with --scenario action-proposal`);
  }
  if (result.scenario === "review" && (result.reviewExistsPath === undefined || result.reviewExistsPath.length === 0)) {
    throw new CliUsageError(`scenario "review" requires --review-exists <relative-path>`);
  }
  if (result.reviewExistsPath !== undefined && result.scenario !== "review") {
    throw new CliUsageError(`--review-exists is only valid with --scenario review`);
  }
  return result;
}
