/**
 * M11-07 接入配置管理面 — the pure (create / edit / delete) planners behind
 * the Settings「接入配置(AI 供应商)」section. Everything here is a PURE
 * function over plain data: no fetch, no React, no stat — exactly like
 * profileUpsert.ts (M11-06), whose primitives this module REUSES
 * (profilesFileContent serialization; the RuntimeId vocabulary). The page
 * wires the plans to the existing primitives and the ONE new read-only
 * endpoint:
 *
 *   GET  /api/v1/profiles/full                        → the file's current full set (diff base)
 *   PUT  /api/v1/profiles/full                        → atomic write-back of the rebuilt FULL set
 *   GET  /api/v1/profiles                             → the LOADED set (载入状态 / drift pre-check)
 *   GET  /api/v1/projects                             → all registered projects (delete reference check)
 *   GET  /api/v1/projects/role-bindings?projectDir=   → per-project bindings (delete reference check)
 *   GET  /api/v1/profiles/path-check?path=            → read-only stat (executable/configDir existence ONLY)
 *
 * Semantics, stated exactly (registered in the batch report):
 *
 * 1. REBUILD, not patch. A save/delete rebuilds the FULL entry list
 *    (existing entries carried over object-for-object, in file order) and
 *    the page writes it through the EXISTING atomic PUT /api/v1/profiles/full
 *    — temp file + rename, validated by the frozen parser before any
 *    filesystem mutation. The user's other profiles survive byte-for-byte.
 *
 * 2. The seven-field drift gate is a HUMAN decision, mirrored client-side.
 *    Editing an entry whose id is in the LOADED set (= it has been frozen
 *    into the running service) so that any of runtime / executable /
 *    executionTarget / configDir / credentialGroup / maxConcurrency /
 *    timeoutSeconds differs → refusal with the drift sentence (the same
 *    shape run-creation.ts answers 409 PROFILE_DEFINITION_CONFLICT for at
 *    the next task). Writing it would only move the 409 past a restart.
 *
 * 3. Same-id model edits never take effect (M9-04): a profile's revision is
 *    minted at its FIRST creation; a later same-id edit — model included —
 *    mints no new revision and never reaches new tasks. The management face
 *    refuses a model edit on a LOADED entry and points at creating a new
 *    profile with a different id (the M11-06 save flow's own discipline).
 *
 * 4. Delete safety, FAIL-CLOSED on the reference data (M11-07 返修): the
 *    reference check RE-FETCHES GET /api/v1/projects at delete time — the
 *    page-load copy can be stale, and a failed read must never stand in for
 *    "no projects" (the old degraded catch collapsed it to [], which would
 *    let a referenced profile delete with dangling bindings). fresh === null
 *    (the read failed) refuses the deletion outright; [] (genuinely no
 *    registered project) cannot reference anything and proceeds. A profile
 *    still referenced by ANY project's role bindings is refused with the
 *    referencing projects (and roles) listed, guiding to 设置 → Agent 团队
 *    first. The reference set is the composition of the EXISTING GET
 *    /api/v1/projects and the per-project EXISTING binding lookup — no
 *    aggregate endpoint is added. Deleting the LAST entry is refused
 *    outright (the frozen ProfilesFileSchema requires at least one profile;
 *    writing the empty set would be a guaranteed 422).
 *
 * 5. Zero secrets, by construction: the draft carries NO API key / token /
 *    base-URL field — the contract has none (packages/contracts/src/schema/
 *    profiles.ts), and none is invented here. configDir renders with the
 *    standing note: credentials are managed by the CLI's own login inside
 *    that directory; this product never touches them. A third-party
 *    compatible endpoint is wired by pointing `executable` at a user-supplied
 *    wrapper script; the product checks the path's EXISTENCE only (read-only
 *    stat through the new GET /api/v1/profiles/path-check) and never reads
 *    or validates script content.
 */
import type { ProfileFullEntry, SetupRoleId } from "./api";
import { runtimeIdOf, type RuntimeId } from "./profileUpsert";

/** Re-exported for the pages/tests that speak the file-entry shape through
 * this module's planners. */
export type { ProfileFullEntry };

/** The four execution targets (contracts shared.ts EXECUTION_TARGETS). */
export const EXECUTION_TARGET_IDS = ["windows-native", "wsl", "linux-native", "macos-native"] as const;
export type ExecutionTargetId = (typeof EXECUTION_TARGET_IDS)[number];

/** The frozen id pattern (contracts/src/schema/shared.ts:9 — lowercase start,
 * then [a-z0-9_-], ≤ 64 chars; NO dots). */
export const PROFILE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

/** Schema bounds (contracts/src/schema/profiles.ts:22-23). */
export const MAX_CONCURRENCY_MIN = 1;
export const MAX_CONCURRENCY_MAX = 32;
export const TIMEOUT_MIN = 30;
export const TIMEOUT_MAX = 86400;

/** The frozen entry cap of the profiles file (contracts/src/schema/
 * profiles.ts:24 — `profiles: z.array(...).min(1).max(64)`): a 65th entry
 * would be a guaranteed 422 at the atomic write-back, so the create flow
 * pre-checks it client-side (人话, zero bytes) instead of shipping a doomed
 * PUT. */
export const PROFILES_FILE_MAX_ENTRIES = 64;

/** The standing credential note (the ask's 零接触 sentence) — rendered beside
 * every configDir input and in the entry list. */
export const CREDENTIAL_NOTE = "凭据由命令行工具(CLI)在该目录自行登录管理,本产品零接触——这里没有任何 API key、令牌或接口地址输入。";

/** The wrapper note: how a third-party compatible endpoint is wired. */
export const WRAPPER_NOTE =
  "第三方兼容端点的接入方式:可执行路径指向一个 wrapper 脚本(由您自备)。本产品不查看、不校验脚本内容,只检查路径是否存在。";

/** The honest sentence for a bare (no-separator) executable value. */
export const EXECUTABLE_BARE_NAME_NOTE =
  "可执行路径不含目录分隔符——运行时将按系统 PATH 解析,本页无法验证;推荐填写完整路径或 wrapper 脚本的绝对路径。";

/** True when the executable value can be stat-checked at all: a value with a
 * directory separator is a concrete filesystem path; a bare name is resolved
 * via PATH at spawn time and only gets the honest un-verifiable note. */
export function executableIsStatCheckable(executable: string): boolean {
  return /[\\/]/.test(executable);
}

/** The 人话 verdict for the EXECUTABLE stat probe (pure over the probe
 * result; null = pass). Existence + regular-file only — never content. */
export function executableStatVerdict(
  executable: string,
  probe: { readonly exists: boolean; readonly isFile: boolean }
): string | null {
  if (!probe.exists) {
    return `可执行路径不存在:${executable}。请核对路径拼写(或先创建该 wrapper 脚本);本次没有写入任何内容。`;
  }
  if (!probe.isFile) {
    return `可执行路径不是一个文件(可能是目录):${executable}。请填写 CLI 本体或 wrapper 脚本的文件路径;本次没有写入任何内容。`;
  }
  return null;
}

/** The advisory verdict for the CONFIGDIR stat probe (pure; null = nothing
 * to note). Advisory, never blocking: credentials are the CLI's own domain —
 * a not-yet-existing directory is the normal "will log in here later" case.
 * The note DOES state the binding-time truth: the role-binding write
 * baselines the revision's external-config manifest FROM this directory, so
 * the directory must exist by the time the profile is bound to a role. */
export function configDirStatVerdict(
  configDir: string,
  probe: { readonly exists: boolean; readonly isDirectory: boolean }
): string | null {
  if (!probe.exists) {
    return `提示:凭据目录当前不存在(${configDir})。请先创建这个目录(或届时让 CLI 在登录时自行创建),再把本配置绑定到角色——绑定写入会读取该目录;如果您想使用已有登录,请核对路径拼写。`;
  }
  if (!probe.isDirectory) {
    return `提示:凭据目录路径不是一个目录(${configDir})。凭据由 CLI 在该目录自行登录管理,请确认这就是您想要的目录。`;
  }
  return null;
}

/** Local 人话 role labels (kept here so the module stays React-free; same
 * meanings as components/RoleBindingSection.tsx ROLE_LABELS). */
const ROLE_HUMAN: Readonly<Record<SetupRoleId, string>> = {
  coordinator: "协调",
  architect: "架构",
  developer: "开发",
  reviewer: "评审"
};

/** Last path segment of a repo root (both separators) — the readable project
 * name for the delete-blocked sentence. */
export function dirLabel(repoRoot: string): string {
  const parts = repoRoot.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? repoRoot;
}

/**
 * Normalize a user-typed profile id for the frozen id surface: trim,
 * lowercase, whitespace/dot runs → one hyphen (dots are NOT legal in ids),
 * collapse hyphen runs. Returns null when nothing usable remains or the
 * frozen pattern still refuses (e.g. starts with a digit, over 64 chars) —
 * never a silent truncate. `normalized` says whether the typed value changed
 * (the form shows the 规范化 hint when it did).
 */
export function normalizeProfileId(raw: string): { readonly id: string; readonly normalized: boolean } | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "") return null;
  const collapsed = trimmed.replace(/[\s.]+/g, "-").replace(/-{2,}/g, "-");
  if (!PROFILE_ID_PATTERN.test(collapsed)) return null;
  return { id: collapsed, normalized: collapsed !== raw };
}

/** One draft as the form holds it (strings — every field round-trips through
 * the DOM; numbers are parsed at validation time). */
export interface ProfileDraft {
  /** Edit mode: the page pins this to the entry being edited and renders the
   * field read-only (id 是配置的标识,改名=删旧建新,删除有引用检查). */
  readonly id: string;
  readonly runtime: "" | RuntimeId;
  readonly executable: string;
  /** "" = CLI 默认 (stored as null). */
  readonly model: string;
  readonly configDir: string;
  /** "" = 与配置同名 (the per-profile default; first-run's per-CLI convention
   * stays for its own generated entries). */
  readonly credentialGroup: string;
  readonly executionTarget: "" | ExecutionTargetId;
  readonly maxConcurrency: string;
  readonly timeoutSeconds: string;
}

/** The create-form defaults: the safe first-run bounds (setup.ts
 * FIRST_RUN_MAX_CONCURRENCY / FIRST_RUN_TIMEOUT_SECONDS); the page pre-fills
 * executionTarget from an existing entry (the UI never invents the machine's
 * platform — it clones what already works on it). */
export const EMPTY_PROFILE_DRAFT: ProfileDraft = {
  id: "",
  runtime: "",
  executable: "",
  model: "",
  configDir: "",
  credentialGroup: "",
  executionTarget: "",
  maxConcurrency: "4",
  timeoutSeconds: "1800"
};

export type DraftCheck =
  | { readonly kind: "ok"; readonly entry: ProfileFullEntry }
  | { readonly kind: "invalid"; readonly problems: readonly string[] }
  | { readonly kind: "conflict"; readonly message: string };

/**
 * Validate + normalize one draft (pure). Field order is stable so tests (and
 * the rendered problem list) stay deterministic. The cross-record checks
 * here: the FILE CAPACITY pre-check (a create into a full 64-entry file is
 * refused before any write — the frozen schema would 422 it), the
 * id-uniqueness conflict (create with an existing id), and an edit whose
 * (fixed) id vanished from the file.
 */
export function checkProfileDraft(input: {
  readonly draft: ProfileDraft;
  readonly fileProfiles: readonly ProfileFullEntry[];
  /** null = create; otherwise the id being edited (the id itself is immutable
   * in edit mode — the form renders it read-only). */
  readonly editingId: string | null;
}): DraftCheck {
  const problems: string[] = [];

  // ---- file capacity (create only — an edit replaces its entry in place) -
  // The frozen ProfilesFileSchema caps the file at 64 entries; the create
  // flow refuses the 65th BEFORE building any doomed write (zero bytes).
  if (input.editingId === null && input.fileProfiles.length >= PROFILES_FILE_MAX_ENTRIES) {
    return {
      kind: "conflict",
      message:
        `配置文件最多容纳 ${String(PROFILES_FILE_MAX_ENTRIES)} 条 AI 配置,当前已满——请先删除不再使用的配置,再新增;本次没有写入任何内容。`
    };
  }

  // ---- id --------------------------------------------------------------
  let id: string;
  if (input.editingId === null) {
    if (input.draft.id.trim() === "") {
      return { kind: "invalid", problems: ["请填写配置名称(只允许小写字母、数字、连字符或下划线,以字母开头,最长 64 字符),例如 claude-glm。"] };
    }
    const normalized = normalizeProfileId(input.draft.id);
    if (normalized === null) {
      return {
        kind: "invalid",
        problems: [
          "配置名称只能用小写字母、数字、连字符或下划线,以字母开头,最长 64 字符(不允许空格和点号),例如 claude-glm。"
        ]
      };
    }
    id = normalized.id;
    if (input.fileProfiles.some((profile) => profile.id === id)) {
      return {
        kind: "conflict",
        message: `AI 配置标识「${id}」已经存在——请直接在列表里对它点「编辑」,或换一个名称;本次没有写入任何内容。`
      };
    }
  } else {
    if (input.draft.id !== "" && input.draft.id !== input.editingId) {
      return { kind: "invalid", problems: ["配置名称不可修改(它是绑定的标识)。要改名请新增一条配置,再删除旧的——删除时会自动检查引用。"] };
    }
    if (!input.fileProfiles.some((profile) => profile.id === input.editingId)) {
      return {
        kind: "invalid",
        problems: [`要编辑的配置「${input.editingId}」已不在配置文件中(可能已被删除或文件已变更)。请刷新页面后重试;本次没有写入任何内容。`]
      };
    }
    id = input.editingId;
  }

  // ---- runtime -----------------------------------------------------------
  const runtime = runtimeIdOf(input.draft.runtime);
  if (runtime === null) {
    problems.push("请选择类型(Claude Code 或 Codex)。");
  }

  // ---- executable --------------------------------------------------------
  const executable = input.draft.executable.trim();
  if (executable === "") {
    problems.push("请填写可执行路径(CLI 本体或 wrapper 脚本的完整路径)。");
  } else if (executable.length > 2048) {
    problems.push("可执行路径过长(上限 2048 字符)。");
  }

  // ---- configDir ---------------------------------------------------------
  const configDir = input.draft.configDir.trim();
  if (configDir === "") {
    problems.push("请填写凭据目录(凭据由 CLI 在该目录自行登录管理;可以是一个尚不存在、准备给 CLI 登录的新目录)。");
  } else if (configDir.length > 2048) {
    problems.push("凭据目录路径过长(上限 2048 字符)。");
  }

  // ---- model ("" = CLI 默认) ----------------------------------------------
  const model = input.draft.model.trim();
  if (model.length > 200) {
    problems.push("模型名过长(上限 200 字符);留空表示使用 CLI 默认模型。");
  }

  // ---- credentialGroup ("" = 同名默认) ------------------------------------
  const credentialGroup = input.draft.credentialGroup.trim() === "" ? id : input.draft.credentialGroup.trim();
  if (!PROFILE_ID_PATTERN.test(credentialGroup) || credentialGroup.length > 64) {
    problems.push("凭据组只能用小写字母、数字、连字符或下划线,以字母开头,最长 64 字符;留空表示与配置名称相同。");
  }

  // ---- executionTarget ---------------------------------------------------
  const executionTarget = input.draft.executionTarget;
  if (executionTarget === "" || !EXECUTION_TARGET_IDS.includes(executionTarget)) {
    problems.push("请选择执行目标(通常与本机一致;绑定到项目时平台不一致会被拒绝)。");
  }

  // ---- bounds ------------------------------------------------------------
  const maxConcurrency = Number(input.draft.maxConcurrency);
  if (
    input.draft.maxConcurrency.trim() === "" ||
    !Number.isInteger(maxConcurrency) ||
    maxConcurrency < MAX_CONCURRENCY_MIN ||
    maxConcurrency > MAX_CONCURRENCY_MAX
  ) {
    problems.push(`最大并发必须是 ${String(MAX_CONCURRENCY_MIN)} 到 ${String(MAX_CONCURRENCY_MAX)} 之间的整数。`);
  }
  const timeoutSeconds = Number(input.draft.timeoutSeconds);
  if (
    input.draft.timeoutSeconds.trim() === "" ||
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < TIMEOUT_MIN ||
    timeoutSeconds > TIMEOUT_MAX
  ) {
    problems.push(`超时必须是 ${String(TIMEOUT_MIN)} 到 ${String(TIMEOUT_MAX)} 秒之间的整数。`);
  }

  if (problems.length > 0) return { kind: "invalid", problems };
  if (runtime === null) return { kind: "invalid", problems: ["请选择类型(Claude Code 或 Codex)。"] };
  return {
    kind: "ok",
    entry: {
      id,
      runtime,
      executable,
      executionTarget,
      configDir,
      model: model === "" ? null : model,
      credentialGroup,
      maxConcurrency,
      timeoutSeconds
    }
  };
}

/** Field-for-field equality of two file entries (all nine; `extraArgs` is a
 * pinned constant the serializer always writes empty). */
export function entriesEqual(a: ProfileFullEntry, b: ProfileFullEntry): boolean {
  return (
    a.id === b.id &&
    a.runtime === b.runtime &&
    a.executable === b.executable &&
    a.executionTarget === b.executionTarget &&
    a.configDir === b.configDir &&
    a.model === b.model &&
    a.credentialGroup === b.credentialGroup &&
    a.maxConcurrency === b.maxConcurrency &&
    a.timeoutSeconds === b.timeoutSeconds
  );
}

export type ProfileSavePlan =
  | {
      readonly kind: "ok";
      /** The rebuilt FULL set: existing entries carried over object-for-object
       * in file order, the draft's entry appended (create) or replacing the
       * baseline in place (edit). */
      readonly nextProfiles: readonly ProfileFullEntry[];
      readonly changed: boolean;
      readonly entry: ProfileFullEntry;
    }
  | { readonly kind: "invalid"; readonly problems: readonly string[] }
  | { readonly kind: "conflict"; readonly message: string };

/**
 * Plan a create-or-edit save (pure). Order of refusals:
 *   1. draft validation / id conflict (checkProfileDraft);
 *   2. the DRIFT refusal: editing a LOADED entry so that any of the seven
 *      drift-gate fields differs — the human-decision sentence, zero bytes;
 *   3. the M9-04 refusal: editing a LOADED entry's model — same-id model
 *      edits never mint a revision, so the honest move is a new profile.
 * A save that passes plans the rebuilt FULL set; nothing here writes.
 */
export function composeProfileSave(input: {
  readonly draft: ProfileDraft;
  readonly fileProfiles: readonly ProfileFullEntry[];
  readonly editingId: string | null;
  readonly loadedProfileIds: readonly string[];
}): ProfileSavePlan {
  const check = checkProfileDraft(input);
  if (check.kind !== "ok") return check;
  const entry = check.entry;
  const index = input.editingId === null ? -1 : input.fileProfiles.findIndex((profile) => profile.id === input.editingId);
  if (input.editingId === null) {
    return { kind: "ok", nextProfiles: [...input.fileProfiles, entry], changed: true, entry };
  }
  const baseline = input.fileProfiles[index];
  if (baseline === undefined) {
    return { kind: "invalid", problems: [`要编辑的配置「${input.editingId}」已不在配置文件中。请刷新页面后重试;本次没有写入任何内容。`] };
  }
  const loaded = input.loadedProfileIds.includes(input.editingId);
  if (loaded) {
    // The drift gate's seven fields (run-creation.ts ensureProfileRow):
    // runtime/executable/executionTarget/configDir/credentialGroup/
    // maxConcurrency/timeoutSeconds. `model` is deliberately NOT one of them.
    const driftField = (
      [
        ["类型", baseline.runtime, entry.runtime],
        ["可执行路径", baseline.executable, entry.executable],
        ["执行目标", baseline.executionTarget, entry.executionTarget],
        ["凭据目录", baseline.configDir, entry.configDir],
        ["凭据组", baseline.credentialGroup, entry.credentialGroup],
        ["最大并发", String(baseline.maxConcurrency), String(entry.maxConcurrency)],
        ["超时", String(baseline.timeoutSeconds), String(entry.timeoutSeconds)]
      ] as const
    ).find(([, before, after]) => before !== after);
    if (driftField !== undefined) {
      return {
        kind: "conflict",
        message:
          `AI 配置「${entry.id}」已被本服务载入并记录,修改「${driftField[0]}」会让它与记录不一致` +
          "(下次创建任务时会被 409 拒绝——修改既有配置的定义是人的决定,系统不会自动覆盖)。" +
          "请改为新增一条配置(用一个新的名称),再在「Agent 团队」里切换绑定;本次没有写入任何内容。"
      };
    }
    if (baseline.model !== entry.model) {
      return {
        kind: "conflict",
        message:
          `AI 配置「${entry.id}」已被本服务载入:同一配置上修改模型不会生效(运行版本在配置首次创建时已冻结,` +
          "之后同名修改不会产生新版本)。请改为新增一条配置(用一个新的名称、填想要的模型),再在「Agent 团队」里切换绑定;" +
          "本次没有写入任何内容。"
      };
    }
  }
  const changed = !entriesEqual(baseline, entry);
  const nextProfiles = [...input.fileProfiles];
  nextProfiles[index] = entry;
  return { kind: "ok", nextProfiles, changed, entry };
}

/** One referencing project: the repo root + which roles point at the profile. */
export interface ProfileReferenceRow {
  readonly repoRoot: string;
  readonly roles: readonly SetupRoleId[];
}

/**
 * Join the registered projects with their binding rows (pure): every project
 * where at least one role binds `profileId`, with the role list in ROLE_IDS
 * order. Null/unbound rows and other profiles are ignored.
 */
export function collectProfileReferences(input: {
  readonly projects: readonly { readonly repoRoot: string }[];
  readonly bindingsByRepoRoot: ReadonlyMap<string, readonly { readonly roleId: SetupRoleId; readonly profileId: string | null }[]>;
  readonly profileId: string;
}): readonly ProfileReferenceRow[] {
  const rows: ProfileReferenceRow[] = [];
  for (const project of input.projects) {
    const bindings = input.bindingsByRepoRoot.get(project.repoRoot) ?? [];
    const roles = bindings
      .filter((binding) => binding.profileId === input.profileId)
      .map((binding) => binding.roleId);
    if (roles.length > 0) rows.push({ repoRoot: project.repoRoot, roles });
  }
  return rows;
}

export type ProfileDeletePlan =
  | { readonly kind: "ok"; readonly nextProfiles: readonly ProfileFullEntry[] }
  | { readonly kind: "blocked"; readonly message: string };

/**
 * Plan a delete (pure). Refusals (zero bytes either way):
 *   1. the id is not in the file any more (already deleted / file changed);
 *   2. ANY registered project still binds it — the referencing projects and
 *      roles are listed, guiding to 设置 → Agent 团队 first;
 *   3. it is the LAST entry in the file (the frozen ProfilesFileSchema
 *      requires at least one profile — writing the empty set would be a
 *      guaranteed 422 at the atomic write-back).
 */
export function composeProfileDelete(input: {
  readonly fileProfiles: readonly ProfileFullEntry[];
  readonly profileId: string;
  readonly references: readonly ProfileReferenceRow[];
}): ProfileDeletePlan {
  if (!input.fileProfiles.some((profile) => profile.id === input.profileId)) {
    return {
      kind: "blocked",
      message: `要删除的配置「${input.profileId}」已不在配置文件中(可能已被删除,或文件在别处被修改)。请刷新页面后重试;本次没有写入任何内容。`
    };
  }
  if (input.references.length > 0) {
    const listed = input.references
      .map((reference) => `项目「${dirLabel(reference.repoRoot)}」(${reference.roles.map((role) => ROLE_HUMAN[role]).join("、")})`)
      .join(";");
    return {
      kind: "blocked",
      message:
        `删除被阻止:AI 配置「${input.profileId}」仍被角色绑定引用——${listed}。` +
        "请先到「设置 → Agent 团队」把这些项目的角色改绑到其他 AI 配置并保存,再回来删除;本次没有写入任何内容。"
    };
  }
  if (input.fileProfiles.length <= 1) {
    return {
      kind: "blocked",
      message: `删除被阻止:配置文件至少要保留一条 AI 配置(系统约束)。请先新增另一条配置,再删除「${input.profileId}」;本次没有写入任何内容。`
    };
  }
  return {
    kind: "ok",
    nextProfiles: input.fileProfiles.filter((profile) => profile.id !== input.profileId)
  };
}

export type DeleteReferenceGate =
  | { readonly kind: "unreadable"; readonly message: string }
  | { readonly kind: "planned"; readonly plan: ProfileDeletePlan };

/** The fail-closed refusal for a delete whose FRESH projects re-read failed
 * (single source shared by the gate below and the page). */
export function unreadableReferencesMessage(profileId: string): string {
  return (
    `无法确认引用状态(项目清单读取失败)——无法核实是否仍有项目把角色绑定到「${profileId}」。` +
    "为避免删除后角色绑定悬空,本次没有写入任何内容;请稍后重试。"
  );
}

/**
 * The delete-time reference gate (pure; M11-07 返修 fail-closed). `freshProjects`
 * is the FRESH GET /api/v1/projects result re-read at delete time — never the
 * page-load copy. The two list states mean OPPOSITE things and must never be
 * conflated:
 *
 * - `null` = the read FAILED: whether any project still binds the profile is
 *   UNKNOWN. The deletion is refused outright (fail-closed) — deleting on a
 *   guess could orphan role bindings. The old degraded wiring collapsed a
 *   failed read to `[]`, which let exactly that happen.
 * - `[]` = the read SUCCEEDED and there is genuinely no registered project:
 *   nothing can reference the profile, so the plan proceeds (composeProfileDelete's
 *   own guards — vanished target, last-entry — still apply).
 *
 * Otherwise the fresh list is joined with the per-project binding lookups and
 * the delete is planned over that fresh data.
 */
export function gateProfileDeleteOnReferences(input: {
  readonly freshProjects: readonly { readonly repoRoot: string }[] | null;
  readonly bindingsByRepoRoot: ReadonlyMap<
    string,
    readonly { readonly roleId: SetupRoleId; readonly profileId: string | null }[]
  >;
  readonly fileProfiles: readonly ProfileFullEntry[];
  readonly profileId: string;
}): DeleteReferenceGate {
  if (input.freshProjects === null) {
    return { kind: "unreadable", message: unreadableReferencesMessage(input.profileId) };
  }
  const references = collectProfileReferences({
    projects: input.freshProjects,
    bindingsByRepoRoot: input.bindingsByRepoRoot,
    profileId: input.profileId
  });
  return {
    kind: "planned",
    plan: composeProfileDelete({
      fileProfiles: input.fileProfiles,
      profileId: input.profileId,
      references
    })
  };
}

/** The 载入状态 of one file entry: "loaded" = in the running service's set
 * (GET /api/v1/profiles); "file-only" = written but not loaded yet (待重启).
 * The page adds the two list-level states the entry cannot know: "checking"
 * (the loaded-set read is still in flight) and "unknown" (the read FAILED —
 * M11-07 返修: unknown is rendered as 载入状态未知, never as the 伪「待重启
 * 载入」 the old empty-set degradation fabricated). */
export function profileLoadState(profileId: string, loadedProfileIds: readonly string[]): "loaded" | "file-only" {
  return loadedProfileIds.includes(profileId) ? "loaded" : "file-only";
}

/** The load-state 人话 labels (the list face; the four badge states). */
export const LOAD_STATE_LABELS: Readonly<Record<"loaded" | "file-only" | "unknown" | "checking", string>> = {
  loaded: "已载入",
  "file-only": "待重启载入",
  unknown: "载入状态未知",
  checking: "载入状态读取中…"
};
