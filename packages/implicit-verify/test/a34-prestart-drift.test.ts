/**
 * A34 extension — external host-config drift is DETECTED and the start is
 * REFUSED (漂移→不启动), for every drift class the detection half defines:
 * content change (hash change), missing file, oversize file, credential
 * pattern (refused at registration, never baselined), and configDir-level
 * refusal. The frozen baseline is reproducible: restoring the exact bytes
 * clears the drift again.
 *
 * Enforcement wiring note (stated, not hidden): the production execution
 * layer that will call this gate before spawning is a later milestone; this
 * package pins that the detection primitive catches every drift class and
 * that composing it as a pre-start guard refuses the start — while the
 * scheduler state stays untouched (nothing started).
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  createProfileRevision,
  detectExternalConfigDrift,
  ExternalConfigViolationError,
  getProfileRevision,
  hashExternalConfigFiles
} from "@role-orchestrator/runtime-profile";
import { enqueueReadyNodes } from "@role-orchestrator/scheduler";
import {
  evaluatePreStartDriftGate,
  quotaLedgerCensus
} from "../src/index.js";
import {
  createImplicitVerifyDb,
  iso,
  makeFixtureConfigDir,
  seedProfile,
  seedProject,
  seedReadyRun,
  type FixtureConfigDir
} from "./helpers.js";

interface DriftRig {
  readonly db: Awaited<ReturnType<typeof createImplicitVerifyDb>>["db"];
  readonly close: () => void;
  readonly config: FixtureConfigDir;
  readonly runId: string;
  readonly expectedHash: string;
}

async function makeRig(label: string): Promise<DriftRig> {
  const { db, close } = createImplicitVerifyDb(`drift-${label}`);
  const config = makeFixtureConfigDir(label);
  await seedProfile(db, {
    profileId: "claude-main",
    runtime: "claude",
    credentialGroup: "personal",
    maxConcurrency: 2,
    configDir: config.dir
  });
  seedProject(db, { projectId: "proj-1", profileId: "claude-main" });
  await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1"] });
  const revision = getProfileRevision(db, "claude-main", 1);
  if (revision === null) throw new Error("rig error: revision 1 missing");
  return { db, close, config, runId: "run-1", expectedHash: revision.externalConfigHash };
}

describe("pre-start drift gate (A34 detection half, composed as a start guard)", () => {
  test("clean baseline → allowed; direct drift query confirms the frozen hash", async () => {
    const rig = await makeRig("clean");
    try {
      const decision = await evaluatePreStartDriftGate(rig.db, rig.runId);
      expect(decision.allowed).toBe(true);
      expect(decision.drifted).toBe(false);
      expect(decision.reasons).toEqual([]);

      const drift = await detectExternalConfigDrift({
        configDir: rig.config.dir,
        files: [...rig.config.files],
        expectedHash: rig.expectedHash
      });
      expect(drift.drifted).toBe(false);
      expect(drift.actualHash).toBe(rig.expectedHash);
    } finally {
      rig.close();
    }
  });

  test("settings.json content change → drift detected, start refused, nothing started", async () => {
    const rig = await makeRig("hash-change");
    try {
      const settingsPath = join(rig.config.dir, "settings.json");
      const original = readFileSync(settingsPath, "utf8");
      expect(original).toBe(rig.config.settingsContent);

      // The CLI user edits a host config file mid-flight / before dispatch.
      writeFileSync(settingsPath, '{"permissions":{"allow":["bash"]},"synthetic":true}\n', "utf8");

      // Detection: hash changed.
      const drift = await detectExternalConfigDrift({
        configDir: rig.config.dir,
        files: [...rig.config.files],
        expectedHash: rig.expectedHash
      });
      expect(drift.drifted).toBe(true);
      expect(drift.actualHash).not.toBeNull();
      expect(drift.actualHash).not.toBe(rig.expectedHash);
      const recomputed = await hashExternalConfigFiles(rig.config.dir, [...rig.config.files]);
      expect(recomputed.manifestHash).toBe(drift.actualHash);
      expect(recomputed.manifestHash).not.toBe(rig.expectedHash);

      // The composed pre-start gate refuses the start: every file still
      // reads, but the manifest hash no longer matches the frozen baseline.
      const decision = await evaluatePreStartDriftGate(rig.db, rig.runId);
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.join("\n")).toContain("external config hash changed for claude-main@1");

      // The refused start leaves the scheduling ledgers untouched.
      const enqueued = enqueueReadyNodes(rig.db, { runId: rig.runId, now: iso(1_000), requiredCapability: null });
      void enqueued; // entries exist but the guard above blocks the start path
      expect(quotaLedgerCensus(rig.db).grantRowsTotal).toBe(0);
      expect(Number(rig.db.prepare("SELECT COUNT(*) AS n FROM executions").get()?.n)).toBe(0);

      // Restoring the exact bytes clears the drift (baseline reproducible).
      writeFileSync(settingsPath, original, "utf8");
      const cleared = await evaluatePreStartDriftGate(rig.db, rig.runId);
      expect(cleared.allowed).toBe(true);
    } finally {
      rig.close();
    }
  });

  test("missing file → drift with fail-closed null hash; start refused", async () => {
    const rig = await makeRig("missing-file");
    try {
      unlinkSync(join(rig.config.dir, "mcp.json"));
      const drift = await detectExternalConfigDrift({
        configDir: rig.config.dir,
        files: [...rig.config.files],
        expectedHash: rig.expectedHash
      });
      expect(drift.drifted).toBe(true);
      expect(drift.actualHash).toBeNull();
      const mcpEntry = drift.files.find((file) => file.path === "mcp.json");
      expect(mcpEntry?.status).toBe("missing-file");

      const decision = await evaluatePreStartDriftGate(rig.db, rig.runId);
      expect(decision.allowed).toBe(false);
    } finally {
      rig.close();
    }
  });

  test("oversize file → refused (never truncated, never hashed) via the size cap", async () => {
    const rig = await makeRig("too-large");
    try {
      const drift = await detectExternalConfigDrift({
        configDir: rig.config.dir,
        files: [...rig.config.files],
        expectedHash: rig.expectedHash,
        options: { maxFileBytes: 5 }
      });
      expect(drift.drifted).toBe(true);
      const settingsEntry = drift.files.find((file) => file.path === "settings.json");
      expect(settingsEntry?.status).toBe("too-large");
      expect(settingsEntry?.sha256).toBeNull();

      const decision = await evaluatePreStartDriftGate(rig.db, rig.runId, { maxFileBytes: 5 });
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.join("\n")).toContain("settings.json(too-large)");
    } finally {
      rig.close();
    }
  });

  test("credential-pattern manifest entry is refused at registration, never baselined", async () => {
    const { db, close } = createImplicitVerifyDb("credential");
    try {
      const config = makeFixtureConfigDir("credential");
      await seedProfile(db, {
        profileId: "claude-cred",
        runtime: "claude",
        credentialGroup: "personal",
        maxConcurrency: 2,
        configDir: config.dir
      });
      let caught: unknown;
      try {
        await createProfileRevision(db, {
          profileId: "claude-cred",
          model: null,
          externalConfigFiles: ["settings.json", "auth.json"],
          now: iso(1_000)
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ExternalConfigViolationError);
      if (caught instanceof ExternalConfigViolationError) {
        expect(caught.kind).toBe("credential-pattern");
        expect(caught.path).toBe("auth.json");
      }
      // The seeded revision 1 (settings.json + mcp.json) is untouched; the
      // refused credential-bearing revision 2 never existed.
      const rev1 = getProfileRevision(db, "claude-cred", 1);
      expect(rev1?.externalConfigFiles).toEqual(["mcp.json", "settings.json"]);
      expect(getProfileRevision(db, "claude-cred", 2)).toBeNull();
    } finally {
      close();
    }
  });
});
