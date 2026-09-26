/**
 * ACCEPTANCE A09 — 多父依赖修改不同文件：后继 inputSha 同时包含父输出。
 *
 * Asserted against the REAL integration record + REAL git state of the
 * baseline run: the recorded inputSha set is the ordered pair of accepted
 * sibling outputs; each output is an ancestor of the candidateSha; the
 * candidate tree contains both files with the exact declared content; the
 * second (follow-up) integration stacks the new output ON TOP of the old
 * candidate (C1 is an ancestor of C2), and the merge commits carry the
 * deterministic identity the integration package documents.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getIntegrationRecord } from "@role-orchestrator/integration";
import {
  BACKEND_FILE_CONTENT,
  BACKEND_FILE_REL,
  BACKEND_NODE,
  FRONTEND_FILE_CONTENT,
  FRONTEND_FILE_REL,
  FRONTEND_NODE,
  FOLLOWUP_FILE_CONTENT,
  FOLLOWUP_FILE_REL
} from "../src/index.js";
import { required, runFullBaseline, type BaselineHarness } from "./helpers.js";

/**
 * The driver executes through the engine launcher, which is implemented for
 * the windows-native world only and refuses other targets
 * (UnsupportedExecutionTargetError). These end-to-end cells are therefore
 * win32-gated; on other platforms the decision/scan units they compose stay
 * covered by the per-package unit suites.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[e2e-baseline] non-Windows platform — launcher-driven e2e cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}


let harness: BaselineHarness | undefined;

beforeAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  harness = await runFullBaseline("a09");
});

afterAll(() => {
  if (!LAUNCHER_APPLIES) return;
  harness?.cleanup();
});

function h(): BaselineHarness {
  if (harness === undefined) throw new Error("baseline harness not initialised");
  return harness;
}

describe.skipIf(!LAUNCHER_APPLIES)("A09: 后继 inputSha 同时包含全部父输出", () => {
  it("集成记录的 inputSha 集合等于两个并行父的已接受输出（有序）", () => {
    const record = required(
      getIntegrationRecord(h().world.db, { runId: h().runId, nodeId: "integrate" }),
      "integration record (integrate)"
    );
    expect(record.state).toBe("COMPLETED");

    const frontendSha = required(h().result.nodes["frontend"]?.outputSha, "frontend outputSha");
    const backendSha = required(h().result.nodes["backend"]?.outputSha, "backend outputSha");
    expect(frontendSha).toMatch(/^[0-9a-f]{40}$/);
    expect(backendSha).toMatch(/^[0-9a-f]{40}$/);
    expect(frontendSha).not.toBe(backendSha);

    expect(record.inputShaSet).toEqual([
      {
        nodeId: FRONTEND_NODE.id,
        branch: `exec/${h().runId}/frontend/1`,
        headSha: frontendSha
      },
      {
        nodeId: BACKEND_NODE.id,
        branch: `exec/${h().runId}/backend/1`,
        headSha: backendSha
      }
    ]);
    // The trace mirrors the durable record (same structured set).
    const trace = required(
      h().result.trace.find((entry) => entry.nodeId === "integrate"),
      "integrate trace"
    );
    const integrationDetail = required(trace.integration, "integrate integration detail");
    expect(integrationDetail.kind).toBe("integrated");
    expect(integrationDetail.inputShaSet).toEqual(record.manifest.parents);
  });

  it("candidateSha 在 git 祖先与内容两个层面同时包含全部父输出", async () => {
    const record = required(
      getIntegrationRecord(h().world.db, { runId: h().runId, nodeId: "integrate" }),
      "integration record (integrate)"
    );
    const candidateSha = required(record.candidateSha, "candidateSha C1");
    const frontendSha = required(h().result.nodes["frontend"]?.outputSha, "frontend outputSha");
    const backendSha = required(h().result.nodes["backend"]?.outputSha, "backend outputSha");
    const baseSha = h().world.baseSha;

    // Ancestry: every parent output (and the run base) is reachable from the
    // candidate — the git-level statement of "后继包含全部父输出".
    expect(await h().isAncestor(frontendSha, candidateSha)).toBe(true);
    expect(await h().isAncestor(backendSha, candidateSha)).toBe(true);
    expect(await h().isAncestor(baseSha, candidateSha)).toBe(true);
    expect(await h().isAncestor(frontendSha, backendSha)).toBe(false);

    // Content: the different files of the two parallel branches are both IN
    // the candidate tree, byte-for-byte as declared.
    expect(await h().fileAt(candidateSha, FRONTEND_FILE_REL)).toBe(FRONTEND_FILE_CONTENT);
    expect(await h().fileAt(candidateSha, BACKEND_FILE_REL)).toBe(BACKEND_FILE_CONTENT);
  });

  it("集成是 (基线, 有序父集合) 的纯函数：确定性 identity 可追溯", () => {
    const record = required(
      getIntegrationRecord(h().world.db, { runId: h().runId, nodeId: "integrate" }),
      "integration record (integrate)"
    );
    expect(record.integrationBranch).toBe(`task/${h().runId}`);
    expect(record.integrationId).toMatch(/^integ-[0-9a-f]{40}$/);
    expect(record.baseSha).toBe(h().world.baseSha);
    expect(record.manifest.parents.map((parent) => parent.nodeId)).toEqual(["frontend", "backend"]);
  });

  it("后续集成把新输出叠加在旧候选之上（C1 是 C2 的祖先）", async () => {
    const first = required(
      getIntegrationRecord(h().world.db, { runId: h().runId, nodeId: "integrate" }),
      "integration record (integrate)"
    );
    const second = required(
      getIntegrationRecord(h().world.db, { runId: h().runId, nodeId: "integrate-followup" }),
      "integration record (integrate-followup)"
    );
    const c1 = required(first.candidateSha, "candidateSha C1");
    const c2 = required(second.candidateSha, "candidateSha C2");
    expect(c2).not.toBe(c1);

    expect(await h().isAncestor(c1, c2)).toBe(true);
    const followupSha = required(h().result.nodes["followup"]?.outputSha, "followup outputSha");
    expect(await h().isAncestor(followupSha, c2)).toBe(true);
    expect(await h().fileAt(c2, FOLLOWUP_FILE_REL)).toBe(FOLLOWUP_FILE_CONTENT);
    // The follow-up candidate still contains the ORIGINAL parallel outputs.
    expect(await h().fileAt(c2, FRONTEND_FILE_REL)).toBe(FRONTEND_FILE_CONTENT);
    expect(await h().fileAt(c2, BACKEND_FILE_REL)).toBe(BACKEND_FILE_CONTENT);
  });

  it("各 writer 的输出提交只包含其声明文件（受控提交边界）", async () => {
    // Each writer exec branch carries exactly the seed + its own output.
    expect(await h().commitCount(`exec/${h().runId}/frontend/1`)).toBe(2);
    expect(await h().commitCount(`exec/${h().runId}/backend/1`)).toBe(2);
    const frontendTip = required(h().result.nodes["frontend"]?.outputSha, "frontend outputSha");
    expect(await h().fileAt(frontendTip, FRONTEND_FILE_REL)).toBe(FRONTEND_FILE_CONTENT);
    const backendTip = required(h().result.nodes["backend"]?.outputSha, "backend outputSha");
    expect(await h().fileAt(backendTip, BACKEND_FILE_REL)).toBe(BACKEND_FILE_CONTENT);
  });
});
