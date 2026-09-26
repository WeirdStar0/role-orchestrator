/**
 * Baseline repeatability (M2-06 deliverable 3): the SAME deterministic
 * pipeline, run twice from scratch in two independent temp worlds, produces
 * the SAME world — identical base commit, identical accepted output SHAs,
 * identical candidateSha chain, identical quota behavior, identical review
 * verdicts and byte-identical candidate content — because every input that
 * feeds a SHA (content, commit identity, ordered parents) is fixed, and every
 * DB identity the driver controls comes from the fixed sequence clock.
 *
 * Cleanup is also exercised: each world's scratch tree is removed afterwards.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  BACKEND_FILE_REL,
  FRONTEND_FILE_REL
} from "../src/index.js";
import { runFullBaseline, type BaselineHarness } from "./helpers.js";

const harnesses: BaselineHarness[] = [];

afterAll(() => {
  for (const harness of harnesses) harness.cleanup();
});

describe("基准可重复：两次独立世界的 SHA 链与判定完全一致", () => {
  it("第一轮基准", async () => {
    const harness = await runFullBaseline("repeat-1");
    harnesses.push(harness);
    expect(harness.result.candidates["integrate"]).toMatch(/^[0-9a-f]{40}$/);
  });

  it("第二轮独立基准与第一轮逐字段一致", async () => {
    const first = harnesses[0];
    const second = await runFullBaseline("repeat-2");
    harnesses.push(second);
    if (first === undefined) throw new Error("first baseline not initialised");
    const a = first.result;
    const b = second.result;

    // Same base commit: identical fixture content + fixed commit identity.
    expect(second.world.baseSha).toBe(first.world.baseSha);
    // Same accepted outputs per writer node.
    for (const nodeId of ["frontend", "backend", "followup"]) {
      expect(b.nodes[nodeId]?.outputSha).toEqual(a.nodes[nodeId]?.outputSha);
    }
    // Same candidate chain and same ordered inputSha sets.
    expect(b.candidates["integrate"]).toBe(a.candidates["integrate"]);
    expect(b.candidates["integrate-followup"]).toBe(a.candidates["integrate-followup"]);
    const traceOf = (harness: BaselineHarness, nodeId: string): unknown =>
      harness.result.trace.find((entry) => entry.nodeId === nodeId)?.integration?.inputShaSet;
    expect(traceOf(second, "integrate")).toEqual(traceOf(first, "integrate"));
    expect(traceOf(second, "integrate-followup")).toEqual(traceOf(first, "integrate-followup"));

    // Same scheduler behavior (deterministic id-order dispatch + credential
    // lock rejection of the second sibling).
    expect(b.quotaRejections.length).toBe(a.quotaRejections.length);
    expect(b.quotaRejections.map((entry) => entry.nodeId)).toEqual(
      a.quotaRejections.map((entry) => entry.nodeId)
    );
    expect(b.trace.map((entry) => entry.nodeId)).toEqual(a.trace.map((entry) => entry.nodeId));

    // Same review outcomes.
    expect(
      b.trace.find((entry) => entry.nodeId === "review")?.review?.verdict
    ).toBe("pass");
    expect(
      b.trace.find((entry) => entry.nodeId === "review")?.review?.candidateSha
    ).toBe(a.trace.find((entry) => entry.nodeId === "review")?.review?.candidateSha);

    // Byte-identical candidate content.
    const c1 = a.candidates["integrate"] as string;
    expect(await second.fileAt(c1, FRONTEND_FILE_REL)).toBe(await first.fileAt(c1, FRONTEND_FILE_REL));
    expect(await second.fileAt(c1, BACKEND_FILE_REL)).toBe(await first.fileAt(c1, BACKEND_FILE_REL));
  });

  it("清理真实生效：两个世界的 scratch 目录都被移除", () => {
    if (harnesses.length < 2) throw new Error("repeatable harnesses not ready");
    for (const harness of harnesses) {
      // Explicit cleanup here (afterAll is only the safety net): the scratch
      // tree and the store file must really disappear.
      harness.cleanup();
      expect(existsSync(harness.world.fixture.scratchDir)).toBe(false);
      expect(existsSync(harness.world.dbPath)).toBe(false);
    }
  });
});
