import { describe, expect, it } from "vitest";
import { COST_UNKNOWN, UNKNOWN_MODEL_ID, UsageEventSchema, isUnknownModelId, totalTokens } from "../src/index.js";
import { makeEvent } from "./helpers.js";

describe("UsageEventSchema (M8-02 strict output contract)", () => {
  it("accepts a fully-formed event", () => {
    const parsed = UsageEventSchema.parse(makeEvent({ durationMs: 3533 }));
    expect(parsed.costUsd).toBe(COST_UNKNOWN);
    expect(parsed.modelId).toBe("test-model");
  });

  it("rejects unknown top-level fields (strictObject: no smuggled cost, no extras)", () => {
    const smuggledCost = { ...makeEvent(), totalCostUsd: 0.111661 };
    expect(UsageEventSchema.safeParse(smuggledCost).success).toBe(false);
    const extraField = { ...makeEvent(), serviceTier: "standard" };
    expect(UsageEventSchema.safeParse(extraField).success).toBe(false);
  });

  it("rejects every cost representation except the literal unknown (contract-level unknown)", () => {
    for (const costUsd of [0, 0.11, "0.11", "free", null, true]) {
      const attempt = { ...makeEvent(), costUsd };
      expect(UsageEventSchema.safeParse(attempt).success).toBe(false);
    }
    expect(UsageEventSchema.safeParse(makeEvent()).success).toBe(true);
  });

  it("rejects negative and fractional token counts", () => {
    expect(UsageEventSchema.safeParse({ ...makeEvent(), inputTokens: -1 }).success).toBe(false);
    expect(UsageEventSchema.safeParse({ ...makeEvent(), outputTokens: 1.5 }).success).toBe(false);
    expect(UsageEventSchema.safeParse({ ...makeEvent(), cacheReadTokens: -0.5 }).success).toBe(false);
    expect(UsageEventSchema.safeParse(makeEvent({ inputTokens: 0 })).success).toBe(true);
  });

  it("rejects empty model ids and non-string model ids", () => {
    expect(UsageEventSchema.safeParse({ ...makeEvent(), modelId: "" }).success).toBe(false);
    expect(UsageEventSchema.safeParse({ ...makeEvent(), modelId: 42 }).success).toBe(false);
  });

  it("durationMs null is explicit absence; non-integer and negative durations rejected", () => {
    expect(UsageEventSchema.safeParse(makeEvent({ durationMs: null })).success).toBe(true);
    expect(UsageEventSchema.safeParse(makeEvent({ durationMs: 3.2 })).success).toBe(false);
    expect(UsageEventSchema.safeParse(makeEvent({ durationMs: -5 })).success).toBe(false);
  });

  it("totalTokens sums all four token buckets", () => {
    const event = makeEvent({ inputTokens: 2, outputTokens: 12, cacheReadTokens: 36352, cacheCreationTokens: 14908 });
    expect(totalTokens(event)).toBe(2 + 12 + 36352 + 14908);
  });

  it("the unknown-model sentinel is a distinct, checkable bucket", () => {
    expect(UNKNOWN_MODEL_ID).toBe("unknown");
    expect(isUnknownModelId("claude-opus-5[1m]")).toBe(false);
    expect(isUnknownModelId(UNKNOWN_MODEL_ID)).toBe(true);
  });
});
