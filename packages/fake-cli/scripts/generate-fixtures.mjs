import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildScenarioFrames, framesToFixtureText, listFixtureSpecs } from "../dist/scenarios.js";

/**
 * Regenerates the pregenerated fixtures from the compiled engine. Run after
 * `pnpm build`:
 *
 *   pnpm --filter @role-orchestrator/fake-cli generate:fixtures
 *
 * Every file is a .synthetic.jsonl sample; manifest.json is the machine
 * readable registry consumed by cli-events tests.
 */
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.resolve(scriptDir, "..", "fixtures");
mkdirSync(fixturesDir, { recursive: true });

const specs = listFixtureSpecs();
for (const spec of specs) {
  const frames = buildScenarioFrames({
    dialect: spec.dialect,
    scenario: spec.scenario,
    variant: spec.variant === null ? undefined : spec.variant,
    delayMs: 0
  });
  const text = framesToFixtureText(frames);
  writeFileSync(path.join(fixturesDir, spec.file), text, "utf8");
  console.log(`wrote ${spec.file} (${text.split("\n").length} lines)`);
}

const manifest = {
  synthetic: true,
  note:
    "Pregenerated SYNTHETIC event samples produced by @role-orchestrator/fake-cli. " +
    "They are NOT captures of real claude/codex output; byte-level protocol " +
    "fidelity is only verified in M0-03/M0-04 against user-authenticated CLIs.",
  fixtures: specs
};
writeFileSync(path.join(fixturesDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`wrote manifest.json (${specs.length} fixtures)`);
