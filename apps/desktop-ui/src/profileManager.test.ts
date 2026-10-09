/**
 * M11-07 接入配置管理面 — the CRUD planner matrix (the ask's unit-test cell
 * list): 新建 / 编辑 / 删除 / 引用阻止 / 其他条目保留 / 409 人话 (the drift
 * refusal and the M9-04 same-id model refusal, both raised BEFORE any
 * write), plus the field-validation rules the frozen schema forces
 * (contracts/src/schema/profiles.ts: id pattern, 1..32, 30..86400, model ≤
 * 200, runtime claude|codex) and the delete-reference join.
 *
 * Every cell is pure — no fetch, no fs, no React (profileManager.ts imports
 * nothing but types). Each conflict/blocked cell names how the old behavior
 * would have been wrong (a write that the server or the NEXT serve start
 * would have to refuse).
 */
import { describe, expect, it } from "vitest";
import {
  CREDENTIAL_NOTE,
  EMPTY_PROFILE_DRAFT,
  PROFILES_FILE_MAX_ENTRIES,
  collectProfileReferences,
  composeProfileDelete,
  composeProfileSave,
  configDirStatVerdict,
  dirLabel,
  entriesEqual,
  executableIsStatCheckable,
  executableStatVerdict,
  gateProfileDeleteOnReferences,
  normalizeProfileId,
  profileLoadState,
  unreadableReferencesMessage,
  type ProfileDraft,
  type ProfileFullEntry
} from "./profileManager";
import { profilesFileContent } from "./profileUpsert";

const claudeDefault: ProfileFullEntry = {
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
const codexDefault: ProfileFullEntry = {
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

const FILE = [claudeDefault, codexDefault];

function draftOf(patch: Partial<ProfileDraft>): ProfileDraft {
  return { ...EMPTY_PROFILE_DRAFT, ...patch };
}

const VALID_CREATE = draftOf({
  id: "claude-glm",
  runtime: "claude",
  executable: "C:\\tools\\glm-wrapper.cmd",
  configDir: "C:\\Users\\me\\.glm",
  executionTarget: "windows-native"
});

describe("normalizeProfileId(名称规范化)", () => {
  it("lowercases and maps whitespace/dots to hyphens, reporting what changed", () => {
    expect(normalizeProfileId("GLM Compat")).toEqual({ id: "glm-compat", normalized: true });
    expect(normalizeProfileId("  claude-Glm.v2  ")).toEqual({ id: "claude-glm-v2", normalized: true });
    // Underscores ARE legal in the frozen id pattern — kept, not rewritten.
    expect(normalizeProfileId("glm_compat")).toEqual({ id: "glm_compat", normalized: false });
  });
  it("returns null for nothing usable or pattern-refusing values (never silently truncates)", () => {
    expect(normalizeProfileId("")).toBeNull();
    expect(normalizeProfileId("   ")).toBeNull();
    expect(normalizeProfileId("!!!")).toBeNull();
    expect(normalizeProfileId("1abc")).toBeNull(); // must start with a letter
    expect(normalizeProfileId("a".repeat(65))).toBeNull(); // over the 64 budget
  });
});

describe("composeProfileSave 新建(create)", () => {
  it("appends the normalized entry and preserves every other entry object-for-object", () => {
    const plan = composeProfileSave({ draft: VALID_CREATE, fileProfiles: FILE, editingId: null, loadedProfileIds: ["claude-default"] });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.changed).toBe(true);
    expect(plan.nextProfiles).toHaveLength(3);
    // Others survive untouched (same object contents, original order).
    expect(plan.nextProfiles[0]).toEqual(claudeDefault);
    expect(plan.nextProfiles[1]).toEqual(codexDefault);
    // Defaults filled in: model "" → null; credentialGroup "" → the id.
    expect(plan.entry).toEqual({
      id: "claude-glm",
      runtime: "claude",
      executable: "C:\\tools\\glm-wrapper.cmd",
      executionTarget: "windows-native",
      configDir: "C:\\Users\\me\\.glm",
      model: null,
      credentialGroup: "claude-glm",
      maxConcurrency: 4,
      timeoutSeconds: 1800
    });
    // The rebuilt set serializes into the exact frozen file shape.
    const parsed = JSON.parse(profilesFileContent(plan.nextProfiles)) as {
      schemaVersion: number;
      profiles: ReadonlyArray<Record<string, unknown>>;
    };
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.profiles[2]).toMatchObject({ id: "claude-glm", extraArgs: [] });
  });

  it("normalizes the typed id and stores the normalized form", () => {
    const plan = composeProfileSave({ draft: draftOf({ ...VALID_CREATE, id: "GLM Compat" }), fileProfiles: FILE, editingId: null, loadedProfileIds: [] });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.entry.id).toBe("glm-compat");
  });

  it("refuses a duplicate id with the 人话 conflict (zero bytes written)", () => {
    const plan = composeProfileSave({ draft: draftOf({ ...VALID_CREATE, id: "codex-default" }), fileProfiles: FILE, editingId: null, loadedProfileIds: [] });
    expect(plan.kind).toBe("conflict");
    if (plan.kind !== "conflict") return;
    expect(plan.message).toContain("codex-default");
    expect(plan.message).toContain("已经存在");
    expect(plan.message).toContain("没有写入");
  });

  it("collects per-field 人话 problems for invalid drafts", () => {
    const plan = composeProfileSave({
      // A VALID id: the id check short-circuits (the credentialGroup default
      // depends on it), so this cell exercises every field AFTER the id.
      draft: draftOf({ id: "glm-compat", runtime: "", executable: "", configDir: "", executionTarget: "", maxConcurrency: "33", timeoutSeconds: "29", model: "m".repeat(201), credentialGroup: "Bad Group!" }),
      fileProfiles: FILE,
      editingId: null,
      loadedProfileIds: []
    });
    expect(plan.kind).toBe("invalid");
    if (plan.kind !== "invalid") return;
    const joined = plan.problems.join("\n");
    expect(joined).toContain("请选择类型");
    expect(joined).toContain("可执行路径");
    expect(joined).toContain("凭据目录");
    expect(joined).toContain("模型名过长");
    expect(joined).toContain("凭据组");
    expect(joined).toContain("请选择执行目标");
    expect(joined).toContain("最大并发必须");
    expect(joined).toContain("超时必须");
  });

  it("refuses an unusable id on its own (the id gates the credentialGroup default)", () => {
    const plan = composeProfileSave({ draft: draftOf({ ...VALID_CREATE, id: "1bad id!" }), fileProfiles: FILE, editingId: null, loadedProfileIds: [] });
    expect(plan.kind).toBe("invalid");
    if (plan.kind !== "invalid") return;
    expect(plan.problems.join("\n")).toContain("配置名称");
  });

  it("accepts the boundary values the schema allows (1/32, 30/86400)", () => {
    for (const [concurrency, timeout] of [
      ["1", "30"],
      ["32", "86400"]
    ] as const) {
      const plan = composeProfileSave({
        draft: draftOf({ ...VALID_CREATE, id: `boundary-${timeout}`, maxConcurrency: concurrency, timeoutSeconds: timeout }),
        fileProfiles: FILE,
        editingId: null,
        loadedProfileIds: []
      });
      expect(plan.kind).toBe("ok");
    }
  });
});

describe("checkProfileDraft 文件容量预检(冻结 max(64),M11-07 返修补)", () => {
  const fullFile: ProfileFullEntry[] = Array.from({ length: PROFILES_FILE_MAX_ENTRIES }, (_, index) => ({
    ...claudeDefault,
    id: `entry-${String(index)}`
  }));

  it("refuses the 65th entry with 人话 BEFORE any write (the frozen schema would 422 it)", () => {
    // 旧实现怎么红:第 65 条一路走到 PUT,被冻结解析器 422 拒绝——一次注定
    // 失败的写入。修复后容量在规划期即拒(零字节)。
    expect(fullFile).toHaveLength(PROFILES_FILE_MAX_ENTRIES);
    const plan = composeProfileSave({ draft: VALID_CREATE, fileProfiles: fullFile, editingId: null, loadedProfileIds: [] });
    expect(plan.kind).toBe("conflict");
    if (plan.kind !== "conflict") return;
    expect(plan.message).toContain("64");
    expect(plan.message).toContain("已满");
    expect(plan.message).toContain("没有写入");
  });

  it("the boundary holds: the 64th entry (63 present) is accepted; an edit into a full file is not capacity-gated", () => {
    const ok = composeProfileSave({
      draft: VALID_CREATE,
      fileProfiles: fullFile.slice(0, PROFILES_FILE_MAX_ENTRIES - 1),
      editingId: null,
      loadedProfileIds: []
    });
    expect(ok.kind).toBe("ok");
    // An edit REPLACES its entry in place — the count never grows, so the
    // full file does not refuse it.
    const edit = composeProfileSave({
      draft: draftOf({ id: "entry-0", runtime: "claude", executable: "C:\\bin\\claude.cmd", configDir: "C:\\Users\\me\\.claude", executionTarget: "windows-native", credentialGroup: "claude-personal", maxConcurrency: "4", timeoutSeconds: "1800" }),
      fileProfiles: fullFile,
      editingId: "entry-0",
      loadedProfileIds: []
    });
    expect(edit.kind).toBe("ok");
  });
});

describe("composeProfileSave 编辑(edit)", () => {
  const unloadedEdit = draftOf({ ...VALID_CREATE, id: "claude-glm" });

  it("replaces the edited entry in place and preserves the others", () => {
    const withGlm: ProfileFullEntry[] = [
      ...FILE,
      { id: "claude-glm", runtime: "claude", executable: "C:\\tools\\old.cmd", executionTarget: "windows-native", configDir: "C:\\u\\.glm", model: "glm-4", credentialGroup: "claude-glm", maxConcurrency: 4, timeoutSeconds: 1800 }
    ];
    const plan = composeProfileSave({
      draft: draftOf({ id: "claude-glm", runtime: "claude", executable: "C:\\tools\\new-wrapper.cmd", configDir: "C:\\u\\.glm", executionTarget: "windows-native", model: "glm-4.6" }),
      fileProfiles: withGlm,
      editingId: "claude-glm",
      loadedProfileIds: [] // not loaded yet — free to edit
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.nextProfiles).toHaveLength(3);
    expect(plan.nextProfiles[0]).toEqual(claudeDefault);
    expect(plan.nextProfiles[1]).toEqual(codexDefault);
    expect(plan.nextProfiles[2]).toMatchObject({ id: "claude-glm", executable: "C:\\tools\\new-wrapper.cmd", model: "glm-4.6" });
  });

  it("refuses a seven-field change on a LOADED entry with the drift 人话 (the future 409, raised before any write)", () => {
    const plan = composeProfileSave({
      draft: draftOf({ id: "claude-default", runtime: "claude", executable: "C:\\bin\\claude.cmd", configDir: "C:\\Users\\me\\.claude-OTHER", executionTarget: "windows-native" }),
      fileProfiles: FILE,
      editingId: "claude-default",
      loadedProfileIds: ["claude-default"]
    });
    expect(plan.kind).toBe("conflict");
    if (plan.kind !== "conflict") return;
    expect(plan.message).toContain("claude-default");
    expect(plan.message).toContain("不一致");
    expect(plan.message).toContain("没有写入");
  });

  it("refuses a model change on a LOADED entry with the M9-04 人话 (same-id model edits never take effect)", () => {
    const plan = composeProfileSave({
      // Only the model differs — the seven drift fields (incl. credentialGroup)
      // match the loaded baseline exactly, so the M9-04 arm is the one hit.
      draft: draftOf({ id: "claude-default", runtime: "claude", executable: "C:\\bin\\claude.cmd", configDir: "C:\\Users\\me\\.claude", credentialGroup: "claude-personal", maxConcurrency: "4", timeoutSeconds: "1800", model: "opus", executionTarget: "windows-native" }),
      fileProfiles: FILE,
      editingId: "claude-default",
      loadedProfileIds: ["claude-default"]
    });
    expect(plan.kind).toBe("conflict");
    if (plan.kind !== "conflict") return;
    expect(plan.message).toContain("不会生效");
    expect(plan.message).toContain("没有写入");
  });

  it("an edit that changes nothing on a LOADED entry plans changed:false (no-write no-change)", () => {
    const plan = composeProfileSave({
      draft: draftOf({ id: "claude-default", runtime: "claude", executable: "C:\\bin\\claude.cmd", configDir: "C:\\Users\\me\\.claude", credentialGroup: "claude-personal", executionTarget: "windows-native", maxConcurrency: "4", timeoutSeconds: "1800" }),
      fileProfiles: FILE,
      editingId: "claude-default",
      loadedProfileIds: ["claude-default"]
    });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.changed).toBe(false);
  });

  it("refuses an id rename attempt and a vanished target with 人话", () => {
    const rename = composeProfileSave({
      draft: draftOf({ ...unloadedEdit, id: "claude-glm-renamed" }),
      fileProfiles: FILE,
      editingId: "claude-glm",
      loadedProfileIds: []
    });
    expect(rename.kind).toBe("invalid");
    if (rename.kind === "invalid") expect(rename.problems.join("\n")).toContain("名称不可修改");

    const vanished = composeProfileSave({ draft: unloadedEdit, fileProfiles: FILE, editingId: "claude-glm", loadedProfileIds: [] });
    expect(vanished.kind).toBe("invalid");
    if (vanished.kind === "invalid") expect(vanished.problems.join("\n")).toContain("已不在配置文件中");
  });
});

describe("composeProfileDelete 删除", () => {
  const withGlm: ProfileFullEntry[] = [
    ...FILE,
    { id: "claude-glm", runtime: "claude", executable: "C:\\tools\\glm-wrapper.cmd", executionTarget: "windows-native", configDir: "C:\\u\\.glm", model: "glm-4.6", credentialGroup: "glm-cred", maxConcurrency: 2, timeoutSeconds: 600 }
  ];

  it("deletes an unreferenced entry and preserves the remaining order and contents", () => {
    const plan = composeProfileDelete({ fileProfiles: withGlm, profileId: "claude-glm", references: [] });
    expect(plan.kind).toBe("ok");
    if (plan.kind !== "ok") return;
    expect(plan.nextProfiles).toEqual(FILE);
  });

  it("blocks when any project still binds the profile, listing the project and roles", () => {
    const plan = composeProfileDelete({
      fileProfiles: withGlm,
      profileId: "claude-glm",
      references: [{ repoRoot: "C:\\work\\demo", roles: ["developer", "reviewer"] }]
    });
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") return;
    expect(plan.message).toContain("删除被阻止");
    expect(plan.message).toContain("claude-glm");
    expect(plan.message).toContain("demo");
    expect(plan.message).toContain("开发");
    expect(plan.message).toContain("评审");
    expect(plan.message).toContain("Agent 团队");
    expect(plan.message).toContain("没有写入");
  });

  it("blocks deleting the LAST entry (the frozen schema needs ≥ 1 profile)", () => {
    const plan = composeProfileDelete({ fileProfiles: [claudeDefault], profileId: "claude-default", references: [] });
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") return;
    expect(plan.message).toContain("至少要保留一条");
  });

  it("blocks a vanished target honestly (already deleted / file changed elsewhere)", () => {
    const plan = composeProfileDelete({ fileProfiles: FILE, profileId: "claude-glm", references: [] });
    expect(plan.kind).toBe("blocked");
    if (plan.kind !== "blocked") return;
    expect(plan.message).toContain("已不在配置文件中");
  });
});

describe("gateProfileDeleteOnReferences(删除引用门,M11-07 返修 fail-closed)", () => {
  const withGlm: ProfileFullEntry[] = [
    ...FILE,
    { id: "claude-glm", runtime: "claude", executable: "C:\\tools\\glm-wrapper.cmd", executionTarget: "windows-native", configDir: "C:\\u\\.glm", model: "glm-4.6", credentialGroup: "glm-cred", maxConcurrency: 2, timeoutSeconds: 600 }
  ];

  it("null (the FRESH re-read failed) refuses fail-closed — the old degraded [] collapse would have permitted the delete", () => {
    // 旧实现怎么红:页面装载时 GET /projects 失败被 catch 塌缩成 [],删除
    // 引用检查看到"空注册表"直接放行——被引用配置可删、绑定悬空。修复后
    // 删除前重取,读取失败=null → 人话拒绝、零写入。
    const gate = gateProfileDeleteOnReferences({
      freshProjects: null,
      bindingsByRepoRoot: new Map(),
      fileProfiles: withGlm,
      profileId: "claude-glm"
    });
    expect(gate.kind).toBe("unreadable");
    if (gate.kind !== "unreadable") return;
    expect(gate.message).toContain("无法确认引用状态");
    expect(gate.message).toContain("claude-glm");
    expect(gate.message).toContain("本次没有写入任何内容");
    // The page's own refusal is the SAME sentence (single source).
    expect(unreadableReferencesMessage("claude-glm")).toBe(gate.message);
  });

  it("[] (the fresh read succeeded: genuinely no projects) plans the delete — nothing can reference it", () => {
    const gate = gateProfileDeleteOnReferences({
      freshProjects: [],
      bindingsByRepoRoot: new Map(),
      fileProfiles: withGlm,
      profileId: "claude-glm"
    });
    expect(gate.kind).toBe("planned");
    if (gate.kind !== "planned") return;
    expect(gate.plan.kind).toBe("ok");
    if (gate.plan.kind !== "ok") return;
    expect(gate.plan.nextProfiles.map((profile) => profile.id)).toEqual(["claude-default", "codex-default"]);
  });

  it("a fresh read WITH references still blocks, listing the project and roles (fresh data flows through)", () => {
    const gate = gateProfileDeleteOnReferences({
      freshProjects: [{ repoRoot: "C:\\work\\demo" }],
      bindingsByRepoRoot: new Map([["C:\\work\\demo", [{ roleId: "developer", profileId: "claude-glm" }]]]),
      fileProfiles: withGlm,
      profileId: "claude-glm"
    });
    expect(gate.kind).toBe("planned");
    if (gate.kind !== "planned") return;
    expect(gate.plan.kind).toBe("blocked");
    if (gate.plan.kind !== "blocked") return;
    expect(gate.plan.message).toContain("demo");
    expect(gate.plan.message).toContain("开发");
    expect(gate.plan.message).toContain("没有写入");
  });
});

describe("collectProfileReferences(引用聚合 join)", () => {
  const projects = [{ repoRoot: "C:\\w\\a" }, { repoRoot: "C:\\w\\b" }, { repoRoot: "C:\\w\\c" }];
  const bindings = new Map([
    [
      "C:\\w\\a",
      [
        { roleId: "developer" as const, profileId: "claude-glm" },
        { roleId: "coordinator" as const, profileId: "claude-default" },
        { roleId: "architect" as const, profileId: null }
      ]
    ],
    ["C:\\w\\b", [{ roleId: "reviewer" as const, profileId: "claude-default" }]],
    ["C:\\w\\c", [{ roleId: "developer" as const, profileId: "claude-glm" }]]
  ]);

  it("joins projects to their referencing roles and skips unbound/other rows", () => {
    const rows = collectProfileReferences({ projects, bindingsByRepoRoot: bindings, profileId: "claude-glm" });
    expect(rows).toEqual([
      { repoRoot: "C:\\w\\a", roles: ["developer"] },
      { repoRoot: "C:\\w\\c", roles: ["developer"] }
    ]);
  });

  it("returns nothing when no project references the profile", () => {
    expect(collectProfileReferences({ projects, bindingsByRepoRoot: bindings, profileId: "never-bound" })).toEqual([]);
  });
});

describe("stat verdicts(只读 stat 的人话翻译)", () => {
  it("executable: missing / not-a-file refuse the save; a file passes", () => {
    expect(executableStatVerdict("C:\\x\\w.cmd", { exists: false, isFile: false })).toMatch(/不存在/);
    expect(executableStatVerdict("C:\\x\\dir", { exists: true, isFile: false })).toMatch(/不是一个文件/);
    expect(executableStatVerdict("C:\\x\\w.cmd", { exists: true, isFile: true })).toBeNull();
  });
  it("configDir: notes are advisory — a missing dir is the normal pre-login case", () => {
    expect(configDirStatVerdict("C:\\u\\.glm", { exists: false, isDirectory: false })).toMatch(/不存在/);
    expect(configDirStatVerdict("C:\\u\\file.txt", { exists: true, isDirectory: false })).toMatch(/不是一个目录/);
    expect(configDirStatVerdict("C:\\u\\.glm", { exists: true, isDirectory: true })).toBeNull();
  });
  it("only separator-carrying executables are stat-checkable (bare names ride PATH)", () => {
    expect(executableIsStatCheckable("C:\\bin\\claude.cmd")).toBe(true);
    expect(executableIsStatCheckable("/usr/local/bin/claude")).toBe(true);
    expect(executableIsStatCheckable("claude")).toBe(false);
  });
});

describe("helpers", () => {
  it("entriesEqual compares all nine frozen fields", () => {
    expect(entriesEqual(claudeDefault, { ...claudeDefault })).toBe(true);
    expect(entriesEqual(claudeDefault, { ...claudeDefault, timeoutSeconds: 1801 })).toBe(false);
    expect(entriesEqual(claudeDefault, { ...claudeDefault, model: "sonnet" })).toBe(false);
  });
  it("profileLoadState maps the loaded set to the badge states", () => {
    expect(profileLoadState("claude-default", ["claude-default"])).toBe("loaded");
    expect(profileLoadState("claude-glm", ["claude-default"])).toBe("file-only");
  });
  it("dirLabel reads the last path segment on both separators", () => {
    expect(dirLabel("C:\\work\\demo")).toBe("demo");
    expect(dirLabel("/home/me/demo/")).toBe("demo");
  });
  it("the standing credential note rides the module (零密钥 by construction)", () => {
    expect(CREDENTIAL_NOTE).toContain("零接触");
    expect(CREDENTIAL_NOTE).toContain("API key");
  });
});
