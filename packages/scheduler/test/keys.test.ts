import { describe, expect, it } from "vitest";
import {
  GLOBAL_RESOURCE_KEY,
  QuotaResourceKeySchema,
  credentialResourceKey,
  decomposeResourceKey,
  profileResourceKey,
  projectResourceKey
} from "../src/index.js";

describe("hierarchical resource keys", () => {
  it("accepts the four documented key forms", () => {
    expect(QuotaResourceKeySchema.parse("global")).toBe("global");
    expect(QuotaResourceKeySchema.parse("project:proj-1")).toBe("project:proj-1");
    expect(QuotaResourceKeySchema.parse("profile:claude-main")).toBe("profile:claude-main");
    expect(QuotaResourceKeySchema.parse("credential:personal")).toBe("credential:personal");
  });

  it("rejects unknown dimensions, malformed components and bare words", () => {
    expect(QuotaResourceKeySchema.safeParse("cluster").success).toBe(false);
    expect(QuotaResourceKeySchema.safeParse("tenant:proj-1").success).toBe(false);
    expect(QuotaResourceKeySchema.safeParse("project:").success).toBe(false);
    // Components reuse the contracts IdSchema vocabulary — no colons inside,
    // no uppercase, so the dimension prefix stays unambiguous.
    expect(QuotaResourceKeySchema.safeParse("project:proj:1").success).toBe(false);
    expect(QuotaResourceKeySchema.safeParse("project:Proj-1").success).toBe(false);
    expect(QuotaResourceKeySchema.safeParse("").success).toBe(false);
  });

  it("builders produce exactly the parsed canonical forms", () => {
    expect(GLOBAL_RESOURCE_KEY).toBe("global");
    expect(projectResourceKey("proj-1")).toBe("project:proj-1");
    expect(profileResourceKey("claude-main")).toBe("profile:claude-main");
    expect(credentialResourceKey("personal")).toBe("credential:personal");
  });

  it("decomposes back into dimension + component", () => {
    expect(decomposeResourceKey("global")).toEqual({ dimension: "global", component: null });
    expect(decomposeResourceKey("project:proj-1")).toEqual({ dimension: "project", component: "proj-1" });
    expect(decomposeResourceKey("profile:claude-main")).toEqual({
      dimension: "profile",
      component: "claude-main"
    });
    expect(decomposeResourceKey("credential:personal")).toEqual({
      dimension: "credential",
      component: "personal"
    });
  });
});
