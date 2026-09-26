/**
 * A34 regression — 原 run 不隐式更换: drift DURING a run's life is a finding,
 * never a silent re-target. With the frozen snapshot semantics pinned by the
 * REAL service read path and the REAL scheduling path:
 *
 * - after the host config file changes, the developer binding is re-pointed
 *   at a different profile, and a newer profile revision appears, the run's
 *   frozen snapshot (and its config hash) is byte-identical on every read;
 * - the drift queries REPORT the drift (binding-changed, external hash
 *   change, newer revision available) without applying it;
 * - enqueueing the run's READY node still resolves the FROZEN profile (queue
 *   row + dispatch outbox payload), and the dispatch claim consumes the
 *   frozen profile's quota keys;
 * - a tampered snapshot row fails its integrity check instead of reading.
 */
import { describe, expect, test } from "vitest";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { getTaskRun, listPendingOutboxMessages } from "@role-orchestrator/store";
import { getNodeState } from "@role-orchestrator/dag";
import { enqueueReadyNodes, pollQueue } from "@role-orchestrator/scheduler";
import {
  SnapshotIntegrityError,
  checkRunProfileDrift,
  createProfileRevision,
  getLatestProfileRevision,
  getProfileRevision,
  getRunBindingDrift,
  readRunRoleProfile,
  setRoleBinding
} from "@role-orchestrator/runtime-profile";
import { evaluatePreStartDriftGate } from "../src/index.js";
import {
  createImplicitVerifyDb,
  iso,
  makeFixtureConfigDir,
  pollInput,
  seedProfile,
  seedProject,
  seedReadyRun
} from "./helpers.js";

/** Re-point the developer role binding at prof-b (binding drift injection). */
function rebindDeveloperToB(db: Awaited<ReturnType<typeof createImplicitVerifyDb>>["db"]): void {
  setRoleBinding(db, {
    projectId: "proj-1",
    roleId: "developer",
    profileId: "prof-b",
    canCreateSubtasks: false,
    now: iso(1_500)
  });
}

/** Create prof-a revision 2 with a different model (model drift injection). */
async function createRevisionA2(db: Awaited<ReturnType<typeof createImplicitVerifyDb>>["db"]): Promise<void> {
  await createProfileRevision(db, {
    profileId: "prof-a",
    model: "claude-sonnet-verify",
    externalConfigFiles: ["settings.json", "mcp.json"],
    now: iso(2_000)
  });
}

async function makeTwoProfileRig(): Promise<{
  db: Awaited<ReturnType<typeof createImplicitVerifyDb>>["db"];
  close(): void;
  dirA: string;
  runId: string;
  initialSnapshotHash: string;
  initialConfigHash: string;
}> {
  const { db, close } = createImplicitVerifyDb("frozen");
  const configA = makeFixtureConfigDir("prof-a");
  const configB = makeFixtureConfigDir("prof-b");
  await seedProfile(db, {
    profileId: "prof-a",
    runtime: "claude",
    credentialGroup: "personal",
    maxConcurrency: 2,
    configDir: configA.dir
  });
  await seedProfile(db, {
    profileId: "prof-b",
    runtime: "claude",
    credentialGroup: "team",
    maxConcurrency: 2,
    configDir: configB.dir
  });
  seedProject(db, { projectId: "proj-1", profileId: "prof-a" });
  const seeded = await seedReadyRun(db, { projectId: "proj-1", runId: "run-1", nodeIds: ["n1"] });
  const frozen = readRunRoleProfile(db, { runId: "run-1", roleId: "developer" });
  const runRow = getTaskRun(db, "run-1");
  if (runRow === null) throw new Error("rig error: run row missing");
  expect(seeded.run.configSnapshotHash).toBe(runRow.configSnapshotHash);
  return {
    db,
    close,
    dirA: configA.dir,
    runId: "run-1",
    initialSnapshotHash: frozen.snapshotHash,
    initialConfigHash: runRow.configSnapshotHash
  };
}

describe("mid-run drift never implicitly swaps the run's frozen configuration", () => {
  test("frozen snapshot reads stay byte-identical across config/binding/revision drift", async () => {
    const rig = await makeTwoProfileRig();
    const { db, runId } = rig;
    try {
      // --- drift injections (what "执行中变化" looks like) -------------
      writeFileSync(
        join(rig.dirA, "settings.json"),
        '{"permissions":{"allow":["bash"]},"synthetic":true}\n',
        "utf8"
      );
      rebindDeveloperToB(db);
      await createRevisionA2(db);

      // --- the run reads NOTHING of it --------------------------------
      const frozen = readRunRoleProfile(db, { runId, roleId: "developer" });
      expect(frozen.snapshot.id).toBe("prof-a");
      expect(frozen.profileRevision).toBe(1);
      expect(frozen.snapshotHash).toBe(rig.initialSnapshotHash);
      expect(frozen.snapshot.requestedModel).toBeNull();
      const runRow = getTaskRun(db, runId);
      expect(runRow?.configSnapshotHash).toBe(rig.initialConfigHash);
    } finally {
      rig.close();
    }
  });

  test("drift is REPORTED as findings while the frozen read path stays frozen", async () => {
    const rig = await makeTwoProfileRig();
    const { db, runId } = rig;
    try {
      writeFileSync(join(rig.dirA, "settings.json"), '{"tampered":true}\n', "utf8");
      rebindDeveloperToB(db);
      await createRevisionA2(db);

      const bindingDrift = getRunBindingDrift(db, runId);
      expect(bindingDrift.drifted).toBe(true);
      const developerEntry = bindingDrift.entries.find((entry) => entry.roleId === "developer");
      expect(developerEntry?.kind).toBe("binding-changed");
      expect(developerEntry?.frozen).toMatchObject({ profileId: "prof-a", revision: 1, model: null });
      expect(developerEntry?.current).toMatchObject({ profileId: "prof-b", revision: 1 });
      // latestRevision tracks the CURRENT binding's profile (prof-b @ 1);
      // the newer revision of the FROZEN profile is visible separately and
      // is informational only — the run never auto-adopts either.
      expect(developerEntry?.latestRevision).toBe(1);
      expect(getLatestProfileRevision(db, "prof-a")?.revision).toBe(2);

      const fullDrift = await checkRunProfileDrift(db, runId);
      expect(fullDrift.drifted).toBe(true);
      const externalA = fullDrift.externalConfig.find((entry) => entry.profileId === "prof-a");
      expect(externalA?.result?.drifted).toBe(true);

      // The composed pre-start gate refuses a NEW start of this run.
      const decision = await evaluatePreStartDriftGate(db, runId);
      expect(decision.allowed).toBe(false);
      expect(decision.reasons.join("\n")).toContain("prof-a");
    } finally {
      rig.close();
    }
  });

  test("enqueue + dispatch consume the FROZEN profile (queue row, outbox, quota keys)", async () => {
    const rig = await makeTwoProfileRig();
    const { db, runId } = rig;
    try {
      writeFileSync(join(rig.dirA, "settings.json"), '{"tampered":true}\n', "utf8");
      rebindDeveloperToB(db);

      // The queue consumes the frozen snapshot read path (A34), never the
      // current binding that now points at prof-b.
      const enqueued = enqueueReadyNodes(db, { runId, now: iso(1_000), requiredCapability: null });
      expect(enqueued.enqueued).toHaveLength(1);
      expect(enqueued.enqueued[0]?.profileId).toBe("prof-a");
      expect(enqueued.enqueued[0]?.credentialGroup).toBe("personal");

      const result = pollQueue(db, pollInput(iso(2_000)));
      expect(result.dispatched).toHaveLength(1);
      const dispatched = result.dispatched[0];
      if (!dispatched) throw new Error("expected a dispatch");

      const pending = listPendingOutboxMessages(db);
      const claimMessage = pending.find((message) => message.type === "scheduler.dispatch");
      expect(JSON.parse(claimMessage?.payload ?? "{}")).toMatchObject({
        executionId: dispatched.executionId,
        profileId: "prof-a"
      });

      // The claim's quota keys name the FROZEN profile scope.
      const fencingKeys = dispatched.fencing.map((record) => record.resourceKey).sort();
      expect(fencingKeys).toEqual(["credential:personal", "global", "profile:prof-a", "project:proj-1"]);
      expect(getNodeState(db, { runId, nodeId: "n1" })?.state).toBe("RUNNING");
    } finally {
      rig.close();
    }
  });

  test("a tampered snapshot row fails its integrity check instead of reading", async () => {
    const rig = await makeTwoProfileRig();
    const { db, runId } = rig;
    try {
      db.prepare(
        "UPDATE run_profile_snapshots SET snapshot_json = ? WHERE run_id = ? AND role_id = 'developer'"
      ).run('{"id":"prof-a","revision":9}', runId);
      expect(() => readRunRoleProfile(db, { runId, roleId: "developer" })).toThrow(
        SnapshotIntegrityError
      );
    } finally {
      rig.close();
    }
  });

  test("the frozen revision row itself is untouched by the drift scenario", async () => {
    const rig = await makeTwoProfileRig();
    const { db } = rig;
    try {
      writeFileSync(join(rig.dirA, "settings.json"), '{"tampered":true}\n', "utf8");
      await createRevisionA2(db);
      const rev1 = getProfileRevision(db, "prof-a", 1);
      const latest = getLatestProfileRevision(db, "prof-a");
      expect(rev1?.model).toBeNull();
      expect(rev1?.externalConfigFiles).toEqual(["mcp.json", "settings.json"]);
      expect(latest?.revision).toBe(2);
      expect(latest?.model).toBe("claude-sonnet-verify");
      // Revision 1's baseline hash is unchanged — the run keeps drifting
      // against ITS OWN frozen baseline, not the new revision's.
      const drift = await checkRunProfileDrift(db, "run-1");
      const externalA = drift.externalConfig.find((entry) => entry.revision === 1);
      expect(externalA?.result?.expectedHash).toBe(rev1?.externalConfigHash);
    } finally {
      rig.close();
    }
  });
});
