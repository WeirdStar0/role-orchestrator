/**
 * Experiment driver: `node dist/experiments/main.js <scenario>`.
 *
 * Scenarios print a JSON record of every real command, exit code and
 * observation, then exit 0 only when the scenario's expected behavior held
 * (WSL: exit 0 also when the environment lacks WSL/node — that case is
 * `verified:false` by design, an environment fact, not a failure).
 */
import { runCancelSemanticsExperiment } from "./cancel-semantics.js";
import { runCmdWrapperExperiment } from "./cmd-wrapper.js";
import { runPidReuseExperiment } from "./pid-reuse.js";
import { runUnicodePathExperiment } from "./unicode-path.js";
import { runWslExperiment } from "./wsl-scenario.js";

const SCENARIOS: Record<string, () => Promise<{ ok: boolean }>> = {
  "cmd-wrapper": () => runCmdWrapperExperiment(),
  "unicode-path": () => runUnicodePathExperiment(),
  "cancel-semantics": () => runCancelSemanticsExperiment(),
  "pid-reuse": () => runPidReuseExperiment(),
  wsl: () => runWslExperiment()
};

function usage(): string {
  return `usage: node dist/experiments/main.js <scenario>\nscenarios: ${Object.keys(SCENARIOS).join(", ")}`;
}

const name = process.argv[2];
const runner = name !== undefined ? SCENARIOS[name] : undefined;
if (name === undefined || runner === undefined) {
  process.stderr.write(`${usage()}\n`);
  process.exit(2);
}

const started = new Date().toISOString();
try {
  const result = await runner();
  const payload = `${JSON.stringify({ scenario: name, startedAt: started, finishedAt: new Date().toISOString(), ...result }, null, 2)}\n`;
  // Windows pipes are async: give the buffered bytes time to drain before
  // process.exit (same pattern as the fake-cli runner's flush grace).
  process.stdout.write(payload, () => {
    setTimeout(() => process.exit(result.ok ? 0 : 1), 150);
  });
} catch (error) {
  const payload = `${JSON.stringify({ scenario: name, startedAt: started, failedAt: new Date().toISOString(), ok: false, error: String(error) }, null, 2)}\n`;
  process.stderr.write(payload, () => {
    setTimeout(() => process.exit(1), 150);
  });
}
