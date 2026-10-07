/**
 * M11-03 — the Agent timeline's pure layer and the node-state 人话. Each
 * cell names what would make it red: the wave leveling (轮内并行 = same
 * generation on one row), the honest no-「等待集成」state mapping (unknown
 * node states surface verbatim), durations that refuse to fabricate, and
 * event lines that keep unknown types verbatim.
 */
import { describe, expect, it } from "vitest";
import { eventLines, nodeAttemptSpans, timelineWaves } from "./timeline";
import { formatDuration, nodeHumanState } from "./runStatus";

describe("timelineWaves (轮内并行:同代节点同排)", () => {
  it("levels a declared chain into one wave per generation", () => {
    const waves = timelineWaves([
      { nodeId: "plan", dependencies: [] },
      { nodeId: "impl-a", dependencies: ["plan"] },
      { nodeId: "impl-b", dependencies: ["plan"] },
      { nodeId: "review", dependencies: ["impl-a", "impl-b"] }
    ]);
    expect(waves.map((wave) => wave.nodeIds)).toEqual([["plan"], ["impl-a", "impl-b"], ["review"]]);
    // The parallel face: wave 2 carries BOTH developers on ONE row.
    expect(waves[1]?.nodeIds.length).toBe(2);
  });

  it("is order-insensitive over the input list", () => {
    const waves = timelineWaves([
      { nodeId: "c", dependencies: ["b"] },
      { nodeId: "a", dependencies: [] },
      { nodeId: "b", dependencies: ["a"] }
    ]);
    expect(waves.map((wave) => wave.nodeIds)).toEqual([["a"], ["b"], ["c"]]);
  });

  it("a cycle cannot level: survivors land in an honest final wave (never dropped, never looping)", () => {
    const waves = timelineWaves([
      { nodeId: "x", dependencies: ["y"] },
      { nodeId: "y", dependencies: ["x"] },
      { nodeId: "root", dependencies: [] }
    ]);
    expect(waves[0]?.nodeIds).toEqual(["root"]);
    expect(waves).toHaveLength(2);
    expect([...(waves[1]?.nodeIds ?? [])].sort()).toEqual(["x", "y"]);
  });

  it("empty graph → no waves", () => {
    expect(timelineWaves([])).toEqual([]);
  });
});

describe("nodeHumanState (dag 冻结节点状态 → 人话;无「等待集成」杜撰)", () => {
  it("maps the frozen NODE_STATES vocabulary to the product words", () => {
    expect(nodeHumanState("RUNNING")).toEqual({ label: "运行中", tone: "running" });
    expect(nodeHumanState("WAITING_APPROVAL")).toEqual({ label: "等待审批", tone: "warning" });
    expect(nodeHumanState("SUCCEEDED")).toEqual({ label: "已完成", tone: "success" });
    expect(nodeHumanState("FAILED")).toEqual({ label: "失败", tone: "error" });
    expect(nodeHumanState("PENDING")).toEqual({ label: "等待前置", tone: "neutral" });
    expect(nodeHumanState("READY")).toEqual({ label: "待执行", tone: "neutral" });
    expect(nodeHumanState("BLOCKED")).toEqual({ label: "已阻塞", tone: "warning" });
    expect(nodeHumanState("RETRY_PENDING")).toEqual({ label: "等待重试", tone: "warning" });
    expect(nodeHumanState("CANCELLED")).toEqual({ label: "已取消", tone: "neutral" });
    expect(nodeHumanState("INTERRUPTED")).toEqual({ label: "已中断", tone: "error" });
    expect(nodeHumanState("RECOVERY_REQUIRED")).toEqual({ label: "需要恢复", tone: "error" });
  });

  it("unknown/absent states surface verbatim (red if a future state is silently bent into a wrong 人话)", () => {
    expect(nodeHumanState("SOME_FUTURE_STATE")).toEqual({ label: "SOME_FUTURE_STATE", tone: "neutral" });
    expect(nodeHumanState(null)).toEqual({ label: "未知状态", tone: "neutral" });
    // The invented 「等待集成」 label must never appear for any state.
    for (const state of ["RUNNING", "SUCCEEDED", "READY", "PENDING", "WAITING_APPROVAL"]) {
      expect(nodeHumanState(state).label).not.toBe("等待集成");
    }
  });
});

describe("durations and event lines (可得则示,不可得不编造)", () => {
  it("formatDuration computes only from parseable, ordered stamps; null otherwise", () => {
    expect(formatDuration("2026-10-08T00:00:00.000Z", "2026-10-08T00:00:42.000Z")).toBe("42 秒");
    expect(formatDuration("2026-10-08T00:00:00.000Z", "2026-10-08T00:03:05.000Z")).toBe("3 分 5 秒");
    expect(formatDuration("2026-10-08T00:03:00.000Z", "2026-10-08T00:05:00.000Z")).toBe("2 分");
    expect(formatDuration("not-a-date", "2026-10-08T00:00:00.000Z")).toBeNull();
    // End before start is not a duration; it is never rendered as 0 秒.
    expect(formatDuration("2026-10-08T00:05:00.000Z", "2026-10-08T00:00:00.000Z")).toBeNull();
  });

  it("nodeAttemptSpans joins attempts per node, sorted by attempt, durations honest", () => {
    const spans = nodeAttemptSpans([
      {
        id: "exec-1",
        nodeId: "b",
        attempt: 1,
        phase: "FAILED",
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:01:00.000Z"
      },
      {
        id: "exec-2",
        nodeId: "a",
        attempt: 1,
        phase: "SUCCEEDED",
        createdAt: "2026-10-08T00:00:00.000Z",
        updatedAt: "2026-10-08T00:00:30.000Z"
      }
    ]);
    expect(spans.map((entry) => entry.nodeId)).toEqual(["a", "b"]);
    expect(spans[0]?.attempts[0]?.duration).toBe("30 秒");
    expect(spans[1]?.attempts[0]?.duration).toBe("1 分");
  });

  it("eventLines prefer string summary/text payloads; unknown types stay verbatim", () => {
    const lines = eventLines([
      {
        eventId: "evt-1",
        seq: 1,
        type: "execution.attempt-finished",
        occurredAt: "2026-10-08T00:00:00.000Z",
        payload: { summary: "attempt ended" }
      },
      {
        eventId: "evt-2",
        seq: 2,
        type: "some.future.type",
        occurredAt: "2026-10-08T00:00:01.000Z",
        payload: { nested: { deep: true } }
      }
    ]);
    expect(lines[0]?.text).toBe("attempt ended");
    expect(lines[0]?.type).toBe("execution.attempt-finished");
    expect(lines[1]?.type).toBe("some.future.type");
    expect(lines[1]?.text).toBeNull();
  });
});
