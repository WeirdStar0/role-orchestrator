#!/usr/bin/env node
/**
 * Shared entrypoint for fake-claude / fake-codex. Never spawns or probes a
 * real CLI; everything printed is synthetic.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliUsageError, parseArgs, usage } from "./args.js";
import { buildScenarioFrames, framesToFixtureText } from "./scenarios.js";
import { runScenario } from "./runner.js";
import type { Dialect } from "./events.js";

export async function main(dialect: Dialect, argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(dialect, argv);
  } catch (error) {
    const message = error instanceof CliUsageError ? error.message : String(error);
    process.stderr.write(`SYNTHETIC fake-${dialect}: argument error — ${message}\n\n${usage(dialect)}\n`);
    return 2;
  }

  if (parsed.help) {
    process.stdout.write(`${usage(dialect)}\n`);
    return 0;
  }

  // parseArgs validates the scenario against the registry, so it is defined
  // and narrowed to the Scenario union whenever help was not requested.
  const scenario = parsed.scenario;
  if (scenario === undefined) {
    process.stderr.write(`SYNTHETIC fake-${dialect}: missing --scenario\n`);
    return 2;
  }

  if (parsed.emitFixturePath !== undefined) {
    if (scenario === "grandchild") {
      process.stderr.write("SYNTHETIC fake-" + dialect + ": the grandchild scenario carries live PIDs and cannot be emitted as a fixture\n");
      return 2;
    }
    const text = framesToFixtureText(
      buildScenarioFrames({
        dialect,
        scenario,
        variant: parsed.variant,
        delayMs: 0,
        proposeWritePath: parsed.proposeWritePath
      })
    );
    const target = path.resolve(parsed.emitFixturePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, "utf8");
    process.stderr.write(`SYNTHETIC fake-${dialect}: fixture written to ${target}\n`);
    return 0;
  }

  // M4-02 test-controlled side effect: an execution explicitly launched with
  // --write-file performs exactly this one write at process start. Checkpoint
  // tests use it to prove that only such an execution ever performs the
  // proposed action — the proposal itself never writes anything.
  if (parsed.writeFilePath !== undefined) {
    const target = path.resolve(parsed.writeFilePath);
    writeFileSync(target, `side effect performed by synthetic fake-${dialect} (pid ${String(process.pid)})\n`, "utf8");
    process.stderr.write(`SYNTHETIC fake-${dialect}: test side-effect file written to ${target}\n`);
  }

  return runScenario({
    dialect,
    scenario,
    variant: parsed.variant,
    delayMs: parsed.delayMs,
    interruptOn: parsed.interruptOn,
    proposeWritePath: parsed.proposeWritePath
  });
}
