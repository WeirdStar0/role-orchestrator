import { describe, expect, it } from "vitest";
import { formatTimestamp, runHumanStatus } from "./runStatus";

/** The ask's frozen vocabulary: 执行中 / 已完成 / 失败 / 等待审批. */
describe("runHumanStatus (M11-01 人话状态, outcome first)", () => {
  it("maps the outcome overlay first — a failed RUNNING run is 失败, never a fake 执行中", () => {
    expect(runHumanStatus("RUNNING", "failed")).toEqual({ label: "失败", tone: "error" });
    expect(runHumanStatus("RUNNING", "blocked")).toEqual({ label: "等待审批", tone: "warning" });
    expect(runHumanStatus("RUNNING", "cancelled")).toEqual({ label: "已取消", tone: "neutral" });
    expect(runHumanStatus("RUNNING", "success")).toEqual({ label: "已完成", tone: "success" });
  });

  it("falls back to the durable status vocabulary when outcome is NULL", () => {
    expect(runHumanStatus("PLANNED", null)).toEqual({ label: "排队中", tone: "neutral" });
    expect(runHumanStatus("RUNNING", null)).toEqual({ label: "执行中", tone: "running" });
    expect(runHumanStatus("READY_FOR_DELIVERY", null)).toEqual({ label: "已完成", tone: "success" });
    expect(runHumanStatus("DELIVERED", null)).toEqual({ label: "已完成", tone: "success" });
    expect(runHumanStatus("CANCELLED", null)).toEqual({ label: "已取消", tone: "neutral" });
  });

  it("surfaces unknown values verbatim (honest, never silently remapped)", () => {
    expect(runHumanStatus("TOTALLY-NEW-STATUS", null)).toEqual({ label: "TOTALLY-NEW-STATUS", tone: "neutral" });
    expect(runHumanStatus(null, null)).toEqual({ label: "未知状态", tone: "neutral" });
    expect(runHumanStatus("", "")).toEqual({ label: "未知状态", tone: "neutral" });
  });

  it("formats timestamps or keeps raw unfuzzable text", () => {
    expect(formatTimestamp("2026-10-07T02:30:00.000Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(formatTimestamp("not-a-date")).toBe("not-a-date");
    expect(formatTimestamp(null)).toBe("");
  });
});
