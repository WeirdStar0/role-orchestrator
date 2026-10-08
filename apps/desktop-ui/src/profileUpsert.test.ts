/**
 * M11-06 — the (CLI, model) upsert planner's matrix (the ask's unit-test
 * cell list): 共用 (same combo shared) / 分化 (same CLI, two models → two
 * profiles) / 同 id 冲突 (minted id collides with a different combo) /
 * 幂等 (already-current selection → no change) / 既有保留 (other existing
 * entries survive byte-for-byte). Plus the normalization rules the frozen
 * IdSchema forces (contracts shared.ts:9: /^[a-z][a-z0-9_-]{0,63}$/ — NO
 * dots) and the prefill semantics.
 */
import { describe, expect, it } from "vitest";
import {
  composeProfileUpsert,
  conventionProfileId,
  initialModelSelections,
  normalizeModelToken,
  profilesFileContent,
  servesCombo,
  type ProfileFileEntry
} from "./profileUpsert";
import type { SetupRoleId } from "./api";

const claudeDefault: ProfileFileEntry = {
  id: "claude-default",
  runtime: "claude",
  executable: "C:\\bin\\claude.cmd",
  executionTarget: "windows-native",
  configDir: "C:\\Users\\me\\.claude",
  model: null,
  credentialGroup: "claude-personal",
  maxConcurrency: 4,
  timeoutSeconds: 1800
};
const codexDefault: ProfileFileEntry = {
  id: "codex-default",
  runtime: "codex",
  executable: "C:\\bin\\codex.cmd",
  executionTarget: "windows-native",
  configDir: "C:\\Users\\me\\.codex",
  model: null,
  credentialGroup: "codex-personal",
  maxConcurrency: 4,
  timeoutSeconds: 1800
};

const FOUR = ["coordinator", "architect", "developer", "reviewer"] as const;

function selectionsOf(
  perRole: Partial<Record<SetupRoleId, { runtime: "claude" | "codex" | ""; model: string }>>
): { roleId: SetupRoleId; runtime: "claude" | "codex" | ""; model: string }[] {
  // The pages always submit EXACTLY four selections (the save flow's own
  // completeness gate); an unspecified role in a test cell carries a valid
  // neutral default so the cell under test stays the deciding input.
  return FOUR.map((roleId) => ({
    roleId,
    runtime: perRole[roleId]?.runtime ?? "claude",
    model: perRole[roleId]?.model ?? ""
  }));
}

describe("normalizeModelToken", () => {
  it("lowercases and maps whitespace/underscore/dot runs to single hyphens", () => {
    expect(normalizeModelToken("Sonnet 4.5", "claude")).toBe("sonnet-4-5");
    expect(normalizeModelToken("GPT_6  ASTRA", "codex")).toBe("gpt-6-astra");
    expect(normalizeModelToken("  --Opus--  ", "claude")).toBe("opus");
  });
  it("returns null for nothing-left or over-budget tokens (never silently truncates)", () => {
    expect(normalizeModelToken("!!!", "claude")).toBeNull();
    expect(normalizeModelToken("   ", "claude")).toBeNull();
    expect(normalizeModelToken("a".repeat(64), "claude")).toBeNull();
    // exactly at the budget: 64 - "claude-".length = 56 chars
    expect(normalizeModelToken("a".repeat(56), "claude")).toBe("a".repeat(56));
  });
});

describe("conventionProfileId + servesCombo", () => {
  it("default → <runtime>; custom → <runtime>-<token>", () => {
    expect(conventionProfileId("claude", "")).toBe("claude");
    expect(conventionProfileId("codex", "gpt-6-astra")).toBe("codex-gpt-6-astra");
  });
  it("combo match treats a null stored model as the '' selection", () => {
    expect(servesCombo(claudeDefault, "claude", "")).toBe(true);
    expect(servesCombo(claudeDefault, "claude", "opus")).toBe(false);
    expect(servesCombo(claudeDefault, "codex", "")).toBe(false);
  });
});

describe("composeProfileUpsert", () => {
  it("共用: two roles on the same (runtime, model) share ONE profile id", () => {
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault, codexDefault],
      selections: selectionsOf({
        coordinator: { runtime: "claude", model: "" },
        architect: { runtime: "claude", model: "" }
      }),
      currentBindings: []
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.targets.coordinator).toBe("claude-default");
    expect(plan.targets.architect).toBe("claude-default");
    expect(plan.fileChanged).toBe(false);
  });

  it("分化: same CLI, two models → two minted profiles (combo reuse misses)", () => {
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault, codexDefault],
      selections: selectionsOf({
        developer: { runtime: "claude", model: "opus" },
        reviewer: { runtime: "claude", model: "sonnet" }
      }),
      currentBindings: []
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.targets.developer).toBe("claude-opus");
    expect(plan.targets.reviewer).toBe("claude-sonnet");
    expect(plan.addedProfiles.map((profile) => profile.id)).toEqual(["claude-opus", "claude-sonnet"]);
    expect(plan.addedProfiles.every((profile) => profile.runtime === "claude")).toBe(true);
    // the minted entries clone the same-runtime base's non-model fields
    expect(plan.addedProfiles[0]?.executable).toBe(claudeDefault.executable);
    expect(plan.addedProfiles[0]?.configDir).toBe(claudeDefault.configDir);
    expect(plan.addedProfiles[0]?.credentialGroup).toBe(claudeDefault.credentialGroup);
    expect(plan.addedProfiles[0]?.model).toBe("opus");
  });

  it("minted ids clone from the role's CURRENT binding when it is the same runtime", () => {
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault, codexDefault],
      selections: selectionsOf({ developer: { runtime: "claude", model: "opus" } }),
      currentBindings: [{ roleId: "developer", profileId: "claude-default" }]
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.addedProfiles[0]?.executable).toBe(claudeDefault.executable);
  });

  it("同 id 冲突: a minted id that already exists with a DIFFERENT model refuses (never rewrites)", () => {
    const claudeOpusElsewhere: ProfileFileEntry = { ...claudeDefault, id: "claude-opus", model: "sonnet" };
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault, claudeOpusElsewhere],
      selections: selectionsOf({ developer: { runtime: "claude", model: "opus" } }),
      currentBindings: []
    });
    expect(plan.kind).toBe("conflict");
    if (plan.kind !== "conflict") return;
    expect(plan.message).toContain("claude-opus");
    expect(plan.message).toContain("不会覆盖");
  });

  it("同 id 冲突: the same combo found under a DIFFERENT id is reused (share wins over convention)", () => {
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault],
      selections: selectionsOf({ coordinator: { runtime: "claude", model: "" } }),
      currentBindings: []
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.targets.coordinator).toBe("claude-default");
    expect(plan.fileChanged).toBe(false);
  });

  it("同 id 冲突: two custom spellings collapsing to one id with different model VALUES refuse", () => {
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault],
      selections: selectionsOf({
        developer: { runtime: "claude", model: "Sonnet 4.5" },
        reviewer: { runtime: "claude", model: "sonnet 4-5" }
      }),
      currentBindings: []
    });
    // both normalize to claude-sonnet-4-5 but the stored VALUES differ
    expect(plan.kind).toBe("conflict");
    if (plan.kind !== "conflict") return;
    expect(plan.message).toContain("claude-sonnet-4-5");
  });

  it("幂等: selections matching the current bindings and the file's combos change nothing", () => {
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault, codexDefault],
      selections: selectionsOf({
        coordinator: { runtime: "claude", model: "" },
        architect: { runtime: "claude", model: "" },
        developer: { runtime: "codex", model: "" },
        reviewer: { runtime: "claude", model: "" }
      }),
      currentBindings: [
        { roleId: "coordinator", profileId: "claude-default" },
        { roleId: "architect", profileId: "claude-default" },
        { roleId: "developer", profileId: "codex-default" },
        { roleId: "reviewer", profileId: "claude-default" }
      ]
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.fileChanged).toBe(false);
    expect(plan.bindingsChanged).toBe(false);
  });

  it("既有保留: the next file set keeps unrelated existing entries UNTOUCHED (add-only merge)", () => {
    const handEdited: ProfileFileEntry = { ...codexDefault, id: "codex-gpt-6-sol", model: "gpt-6-sol" };
    const plan = composeProfileUpsert({
      fileProfiles: [claudeDefault, handEdited],
      selections: selectionsOf({ developer: { runtime: "claude", model: "opus" } }),
      currentBindings: []
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.nextFileProfiles).toHaveLength(3);
    expect(plan.nextFileProfiles[0]).toEqual(claudeDefault);
    expect(plan.nextFileProfiles[1]).toEqual(handEdited);
    expect(plan.nextFileProfiles[2]?.id).toBe("claude-opus");
    // serialized content round-trips the untouched entries with the same fields
    const content = profilesFileContent(plan.nextFileProfiles);
    expect(content.endsWith("\n")).toBe(true);
    const reparsed = JSON.parse(content) as { schemaVersion: number; profiles: ProfileFileEntry[] };
    expect(reparsed.schemaVersion).toBe(1);
    // the file shape always carries the v1 pinned empty extraArgs
    expect(reparsed.profiles[0]).toEqual({ ...claudeDefault, extraArgs: [] });
    expect(reparsed.profiles[1]).toEqual({ ...handEdited, extraArgs: [] });
    expect(reparsed.profiles[2]).toMatchObject({ id: "claude-opus", model: "opus", extraArgs: [] });
  });

  it("invalid: an unchosen CLI, an unnormalizable custom token, and a missing same-runtime base each refuse with a sentence", () => {
    const unchosen = composeProfileUpsert({
      fileProfiles: [claudeDefault],
      selections: selectionsOf({ developer: { runtime: "", model: "" } }),
      currentBindings: []
    });
    expect(unchosen.kind).toBe("invalid");
    const badToken = composeProfileUpsert({
      fileProfiles: [claudeDefault],
      selections: selectionsOf({ developer: { runtime: "claude", model: "!!!" } }),
      currentBindings: []
    });
    expect(badToken.kind).toBe("invalid");
    const noBase = composeProfileUpsert({
      fileProfiles: [codexDefault],
      selections: selectionsOf({ developer: { runtime: "claude", model: "opus" } }),
      currentBindings: []
    });
    expect(noBase.kind).toBe("invalid");
    if (noBase.kind !== "invalid") return;
    expect(noBase.message).toContain("初始设置");
  });
});

describe("initialModelSelections (prefill)", () => {
  const loaded = new Map([
    [claudeDefault.id, claudeDefault],
    [codexDefault.id, codexDefault]
  ]);
  const template = [
    { roleId: "coordinator" as SetupRoleId, runtime: "claude" },
    { roleId: "architect" as SetupRoleId, runtime: "claude" },
    { roleId: "developer" as SetupRoleId, runtime: "codex" },
    { roleId: "reviewer" as SetupRoleId, runtime: "claude" }
  ];

  it("bound+loaded roles reflect their CURRENT combo; unbound roles take the template + CLI 默认", () => {
    const resolved = [
      { roleId: "developer" as SetupRoleId, profileId: "codex-gpt-6-sol", notLoaded: false },
      { roleId: "coordinator" as SetupRoleId, profileId: null, notLoaded: false }
    ];
    const loadedWithModel = new Map(loaded);
    loadedWithModel.set("codex-gpt-6-sol", { ...codexDefault, id: "codex-gpt-6-sol", model: "gpt-6-sol" });
    const selections = initialModelSelections(template, resolved, loadedWithModel);
    expect(selections.developer).toEqual({ runtime: "codex", model: "gpt-6-sol" });
    expect(selections.coordinator).toEqual({ runtime: "claude", model: "" });
    // roles with neither binding nor template entry stay unselected
    expect(selections.architect).toEqual({ runtime: "claude", model: "" });
  });

  it("a NOT-loaded binding does NOT prefill its combo (falls to the template)", () => {
    const resolved = [
      { roleId: "developer" as SetupRoleId, profileId: "ghost-profile", notLoaded: true }
    ];
    const selections = initialModelSelections(template, resolved, loaded);
    expect(selections.developer).toEqual({ runtime: "codex", model: "" });
  });

  it("null template + no bindings = all-empty selections (nothing invented)", () => {
    const selections = initialModelSelections(null, [], loaded);
    expect(Object.values(selections).every((selection) => selection.runtime === "")).toBe(true);
  });
});
