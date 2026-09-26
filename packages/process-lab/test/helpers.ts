/**
 * Shared test plumbing: a scratch directory with the fake-cli dist copy and
 * an npm-style `.cmd` shim, plus a per-fixture TreeRegistry. Callers use
 * try/finally with `teardownLabFixture` so no hanging fake-cli tree can
 * survive a failing assertion.
 */
import { installFakeCli, type FakeCliInstall } from "../src/fakecli.js";
import { TreeRegistry } from "../src/registry.js";
import { makeScratchDir, removeScratch } from "../src/scratch.js";
import { writeCmdShim, type CmdShim } from "../src/shim.js";

export interface LabFixture {
  readonly scratchDir: string;
  readonly fake: FakeCliInstall;
  readonly shim: CmdShim;
  readonly registry: TreeRegistry;
}

/** Sets up a scratch dir with the fake-cli dist + a `.cmd` shim. */
export function setupLabFixture(label: string): LabFixture {
  const scratchDir = makeScratchDir(label);
  const fake = installFakeCli(scratchDir);
  const shim = writeCmdShim(scratchDir, "fake-claude.cmd", "fake-cli-dist\\bin\\fake-claude.js");
  return { scratchDir, fake, shim, registry: new TreeRegistry() };
}

/** Reaps every registered tree, then removes the scratch directory. */
export async function teardownLabFixture(fixture: LabFixture): Promise<void> {
  await fixture.registry.reapAll();
  removeScratch(fixture.scratchDir);
}
