/**
 * Shared plumbing for the M5-05 browser flow tests.
 *
 * Every test file builds its OWN harness: a fresh world (temp scratch +
 * fresh store + fresh git fixture), a live local-api server on an ephemeral
 * loopback port over that store, and a fresh headless Chromium (throwaway
 * profile). Cleanup closes the browser (killing the instance), closes the
 * server, closes the store and removes the whole scratch tree with the
 * review package's whitelisted primitive — never masking a test result.
 *
 * Discipline: the ONLY CLI ever executed is the built fake-cli dist bin; git
 * runs only inside the system-temp fixture repo; no real claude/codex and no
 * credential material is ever touched.
 */
import type { DatabaseSync } from "node:sqlite";
import { startLocalApiServer, type LocalApiServer } from "@role-orchestrator/local-api";
import {
  Evidence,
  createWorld,
  launchBrowser,
  removeScratchTree,
  WORLD_T0,
  type BrowserSession,
  type BrowserE2eWorld
} from "../src/index.js";

export { WORLD_T0 };
export { required } from "../src/index.js";

export interface FlowHarness {
  readonly world: BrowserE2eWorld;
  readonly server: LocalApiServer;
  readonly browser: BrowserSession;
  readonly evidence: Evidence;
  readonly db: () => DatabaseSync;
  close(summary: string): Promise<void>;
}

/**
 * Start one flow harness. `label` names the evidence directory
 * (packages/browser-e2e/evidence/<label>-<stamp>/).
 */
export async function startHarness(label: string): Promise<FlowHarness> {
  const evidence = Evidence.start(label, {
    "node.js": process.version,
    platform: `${process.platform} ${process.arch}`,
    "clock-base": WORLD_T0,
    note: "five-flow browser e2e (M5-05); every screenshot below is a real Chromium capture of the live local-api page"
  });
  const world = await createWorld(label);
  evidence.log(`world ready: db=${world.dbPath} repo=${world.repoPath} baseSha=${world.baseSha}`);
  evidence.log(`dogfood bins: claude=${world.claudeBin} codex=${world.codexBin}`);
  const server = await startLocalApiServer({ db: world.db });
  evidence.log(
    `local-api listening on http://${server.boundAddress}:${String(server.port)} (token in memory only)`
  );
  const browser = await launchBrowser(evidence);
  evidence.log(`browser engine: ${browser.version}`);

  return {
    world,
    server,
    browser,
    evidence,
    db: () => world.db,
    close: async (summary: string): Promise<void> => {
      await browser.close();
      await server.close();
      evidence.log("local-api server closed");
      world.close();
      await removeScratchTree(world.fixture.scratchDir);
      evidence.log(`scratch tree removed: ${world.fixture.scratchDir}`);
      evidence.close(summary);
    }
  };
}
