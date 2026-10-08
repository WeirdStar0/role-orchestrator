/**
 * M11-06 角色×模型选择 — the pure (CLI, model) → profile upsert planner.
 *
 * Everything here is a PURE function over plain data: no fetch, no React, no
 * server knowledge beyond the shapes the EXISTING endpoints serve. The pages
 * (SettingsPage / NewTaskPage) wire the plan to the existing primitives:
 *
 *   GET  /api/v1/profiles/full   → the file's current full set (diff base)
 *   PUT  /api/v1/profiles/full   → atomic write-back of the merged FULL set
 *   GET  /api/v1/profiles        → the LOADED set (binding feasibility)
 *   PUT  /api/v1/projects/:id/role-bindings → the transactional binding write
 *
 * Design (registered in the batch report §8):
 *
 * 1. ADD-ONLY merge. The plan NEVER rewrites an existing file entry's fields
 *    — it only appends newly minted profiles. Rewriting a definition is the
 *    drift gate's human decision (409 PROFILE_DEFINITION_CONFLICT compares
 *    seven fields, run-creation.ts), not an upsert; the same discipline is
 *    applied client-side, so the user's other profiles always survive a save
 *    byte-for-byte.
 *
 * 2. Combo reuse before id convention. A selection (runtime, model) first
 *    looks for ANY existing entry with the same (runtime, model) pair and
 *    reuses ITS id — first-run's `claude-default` keeps working as the target
 *    of (claude, CLI 默认), which is what "同 (runtime,模型) 组合共用一
 *    profile" means. Only a combo with no existing entry mints a new profile.
 *
 * 3. Id convention (the M11-06 ask): default selection (model "") →
 *    `<runtime>`; a custom model → `<runtime>-<model>` with the model token
 *    normalized (lowercase, whitespace/underscore/dot runs → hyphen) so the
 *    id satisfies the frozen IdSchema /^[a-z][a-z0-9_-]{0,63}$/ (contracts
 *    src/schema/shared.ts:9 — note: NO dots in ids). The model VALUE itself
 *    is stored verbatim (the schema allows 1..200 chars; the CLI receives it
 *    verbatim; normalization is an id-surface concern only).
 *
 * 4. Collision honesty. A minted id that already exists with a DIFFERENT
 *    (runtime, model) is a hard refusal (kind "conflict"): writing it would
 *    create exactly the same-id/different-definition shape whose restart-time
 *    semantics are either a 409 (seven-field drift) or — the M9-04 trap — a
 *    silent no-op (same seven fields, model edited: no new revision is ever
 *    minted, run-creation.ts:455). The UI refuses and states the case instead
 *    of pretending the save would work.
 *
 * 5. ONE COMBO, ONE PROFILE — within a single save, not just against the
 *    file (M11-06 review round 1, blocker B1). The combo registry is seeded
 *    from the file's entries and extended with every entry the save mints,
 *    so the SECOND role choosing a brand-new combo reuses the FIRST one's
 *    minted entry instead of minting the same id again. The old lookup saw
 *    only the file-at-start, so two roles on the same new combo each pushed
 *    a `claude-sonnet` entry and the PUT wrote a duplicated id — which the
 *    frozen ProfilesFileSchema accepts (no id-uniqueness constraint) but the
 *    next serve start rejects ("profile X is defined more than once",
 *    orchestrator.ts:138), bricking the desktop app right after a message
 *    told the user to restart and save again. Belt and braces: before the
 *    plan is returned AND again before teamSave fires the PUT, the merged
 *    set's ids are asserted unique — a duplicate refuses with a sentence and
 *    ZERO bytes are written, never a brick on disk.
 *
 * 6. Restart semantics ride with the data: a minted profile is by definition
 *    not in the running process's loaded set (loaded ⊆ file-at-startup), so
 *    the caller checks the plan's targets against GET /api/v1/profiles and
 *    defers the binding PUT with an honest restart-and-resave message rather
 *    than firing a PUT the server must refuse (422 UNKNOWN_PROFILE — the
 *    humanizer arm stays as belt-and-braces).
 */
import type { SetupRoleId } from "./api";

/** The two runtimes the frozen contract knows (RuntimeSchema). */
export type RuntimeId = "claude" | "codex";

export const RUNTIME_IDS: readonly RuntimeId[] = ["claude", "codex"];

/** Narrow a free string to a RuntimeId (null for anything else) — the same
 * defensive shape the api.ts template parser uses. */
export function runtimeIdOf(value: string): RuntimeId | null {
  return value === "claude" || value === "codex" ? value : null;
}

/** One role's (CLI × model) selection; `model: ""` = CLI 默认 (no model flag
 * ever reaches the CLI — engine invocation.ts:74/77), any other string is
 * used verbatim as the profile's `model` value. `runtime: ""` = not chosen.
 *
 * `custom` is the EXPLICIT UI state "the 自定义… branch is active" (M11-06
 * review round 1, blocker B2). It is never DERIVED from the model value: the
 * transient state right after picking 自定义… has `model: ""` AND `custom:
 * true`, which a value-derived predicate cannot express — the old editor
 * mapped 自定义… to `model: ""` and revealed the input only when model was
 * non-empty and off-list, so the input could never appear at all. */
export interface ModelSelection {
  readonly runtime: "" | RuntimeId;
  readonly model: string;
  readonly custom: boolean;
}

export const EMPTY_MODEL_SELECTIONS: Readonly<Record<SetupRoleId, ModelSelection>> = {
  coordinator: { runtime: "", model: "", custom: false },
  architect: { runtime: "", model: "", custom: false },
  developer: { runtime: "", model: "", custom: false },
  reviewer: { runtime: "", model: "", custom: false }
};

/**
 * The curated per-CLI model suggestions — UI ADVICE ONLY, never a contract
 * (contracts/src/schema/profiles.ts:8-9: the schema accepting a model string
 * never means a provider supports it). Every surface that renders these also
 * renders MODEL_CHOICES_NOTE.
 *
 * - claude: the ask's prescription (opus / sonnet / haiku — the Claude Code
 *   short aliases).
 * - codex: the two model names with IN-REPO real-CLI evidence:
 *   `gpt-6-astra` verified successful via `codex exec -m` (reports/
 *   M0-04-codex-capability.md:36,54 — the account's session model), and
 *   `gpt-6-sol` observed in real M8-04 model-stats buckets
 *   (reports/M8-04-BATCH.md:130). The same M0-04 evidence shows names that
 *   exist in the binary's model directory (`gpt-5-codex`) can still be
 *   account-refused — exactly why the list is advice plus a free-text input.
 */
export const CURATED_MODELS: Readonly<Record<RuntimeId, readonly string[]>> = {
  claude: ["opus", "sonnet", "haiku"],
  codex: ["gpt-6-astra", "gpt-6-sol"]
};

/** The honesty note rendered beside every curated model list (the ask). */
export const MODEL_CHOICES_NOTE = "模型清单只是常用建议,以 CLI 实际支持为准;不在清单中的模型可用「自定义」填写。";

/** The model-select sentinel meaning "type a custom model id". Never a valid
 * model value (the schema's model has no underscore-only semantics we need). */
export const CUSTOM_MODEL_VALUE = "__custom__";

/**
 * Normalize a custom model token for the PROFILE ID surface (not the model
 * value): lowercase; runs of whitespace/underscore/dot → one hyphen; drop
 * anything outside [a-z0-9-]; trim edge hyphens. Returns null when nothing
 * usable remains or the token would overflow the id budget
 * (64 − `${runtime}-`), or when the frozen IdSchema still wouldn't accept the
 * full id (defensive — the caller composes the message).
 */
export function normalizeModelToken(raw: string, runtime: RuntimeId): string | null {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_.]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (collapsed === "") return null;
  const budget = 64 - (runtime.length + 1);
  if (collapsed.length > budget) return null;
  const id = `${runtime}-${collapsed}`;
  if (!/^[a-z][a-z0-9_-]{0,63}$/.test(id)) return null;
  return collapsed;
}

/** The convention id for a selection (default → `<runtime>`; custom →
 * `<runtime>-<token>`). `model` must already be normalized for the custom
 * arm (normalizeModelToken's output); an empty custom token is invalid. */
export function conventionProfileId(runtime: RuntimeId, model: string): string {
  return model === "" ? runtime : `${runtime}-${model}`;
}

/** One profile entry as the file (GET /api/v1/profiles/full) carries it —
 * the FULL frozen shape, unlike the reduced GET /api/v1/profiles summary. */
export interface ProfileFileEntry {
  readonly id: string;
  readonly runtime: string;
  readonly executable: string;
  readonly executionTarget: string;
  readonly configDir: string;
  readonly model: string | null;
  readonly credentialGroup: string;
  readonly maxConcurrency: number;
  readonly timeoutSeconds: number;
}

/** True when the entry serves exactly the selection's (runtime, model) pair
 * (null model ≡ "" selection). */
export function servesCombo(profile: ProfileFileEntry, runtime: RuntimeId, model: string): boolean {
  return profile.runtime === runtime && (profile.model ?? "") === model;
}

export interface UpsertSelectionInput {
  readonly roleId: SetupRoleId;
  readonly runtime: "" | RuntimeId;
  readonly model: string;
}

export interface UpsertBindingInput {
  readonly roleId: SetupRoleId;
  readonly profileId: string | null;
}

/**
 * A loaded summary (GET /api/v1/profiles) lifted into the file-entry shape so
 * combo REUSE can also see it. Only meaningful when the profiles FILE is not
 * readable (in-process composition roots, unwired serve): the placeholder
 * fields can never survive into a write because the caller pairs this with
 * `mintable: false` — reuse resolves, minting refuses. The empty strings are
 * never rendered; the ids and (runtime, model) pairs are the real data.
 */
export function loadedAsComboSource(profiles: readonly { readonly id: string; readonly runtime: string; readonly model: string | null }[]): ProfileFileEntry[] {
  return profiles.map((profile) => ({
    id: profile.id,
    runtime: profile.runtime,
    executable: "",
    executionTarget: "",
    configDir: "",
    model: profile.model,
    credentialGroup: "",
    maxConcurrency: 0,
    timeoutSeconds: 0
  }));
}

export type UpsertPlan =
  | {
      readonly kind: "ok";
      /** roleId → target profile id (combo reuse or minted convention id). */
      readonly targets: Readonly<Record<SetupRoleId, string>>;
      /** Entries the plan ADDS to the file (empty = nothing to write). */
      readonly addedProfiles: readonly ProfileFileEntry[];
      /** The full next file set: existing entries UNTOUCHED + additions. */
      readonly nextFileProfiles: readonly ProfileFileEntry[];
      readonly fileChanged: boolean;
      /** True when any target differs from the role's current binding. */
      readonly bindingsChanged: boolean;
    }
  | { readonly kind: "invalid"; readonly message: string }
  | { readonly kind: "conflict"; readonly message: string };

/** The first duplicated id in a merged file set, or null when every id is
 * unique (pure). The frozen ProfilesFileSchema has no id-uniqueness
 * constraint, so the WRITE side is the last line of defense: a duplicated id
 * parses fine today and bricks the NEXT serve start ("profile X is defined
 * more than once", local-api orchestrator.ts:138). */
export function firstDuplicateProfileId(profiles: readonly ProfileFileEntry[]): string | null {
  const seen = new Set<string>();
  for (const profile of profiles) {
    if (seen.has(profile.id)) return profile.id;
    seen.add(profile.id);
  }
  return null;
}

/** The 人话 sentence for a duplicate-id refusal (the UI writes ZERO bytes). */
export function duplicateProfileIdMessage(duplicateId: string): string {
  return `检测到重复的配置标识「${duplicateId}」:本次保存不会写出重复条目。如果这是配置文件里已有的重复(同名条目出现多次),请先到旧工作台「配置」页清理后再试;本次没有写入任何内容。`;
}

/**
 * Plan the save (pure). Order of refusals:
 *   1. a role with no CLI chosen / a custom model that normalizes to nothing
 *      usable → invalid (the editor usually prevents this; the server-side
 *      schema stays the authority);
 *   2. no existing same-runtime entry to clone the non-model fields from →
 *      invalid (the UI never invents executable/configDir — 初始设置 or the
 *      old config page creates the base);
 *   3. a minted id colliding with an existing entry of a different
 *      (runtime, model) → conflict;
 *   4. two selections whose custom models normalize to the same minted id
 *      while their model VALUES differ → conflict (one id cannot carry two
 *      models);
 *   5. the write-guard: the merged set must carry every id exactly ONCE —
 *      a duplicate (a pre-bricked input file, or an internal planning bug)
 *      refuses with zero bytes written.
 */
export function composeProfileUpsert(input: {
  readonly fileProfiles: readonly ProfileFileEntry[];
  readonly selections: readonly UpsertSelectionInput[];
  readonly currentBindings: readonly UpsertBindingInput[];
  /**
   * false = the profiles FILE is not writable/readable here (unwired serve,
   * in-process composition roots): combo reuse still resolves against the provided
   * entries (the caller passes the loaded set via loadedAsComboSource), but a
   * combo with no existing entry is refused with the honest "cannot add"
   * sentence instead of minting. Default true.
   */
  readonly mintable?: boolean;
}): UpsertPlan {
  const bindingByRole = new Map(input.currentBindings.map((entry) => [entry.roleId, entry.profileId]));
  const nextFileProfiles: ProfileFileEntry[] = [...input.fileProfiles];
  const targets: Record<SetupRoleId, string> = { coordinator: "", architect: "", developer: "", reviewer: "" };
  const addedProfiles: ProfileFileEntry[] = [];
  // The COMBO REGISTRY (B1 fix): every (runtime, model) pair this save knows
  // about — seeded with the file's entries (first entry in file order wins,
  // exactly what the old find()-based reuse did) and EXTENDED with every
  // entry minted during this same save. A minted entry is stored under its
  // verbatim model value, so a second role selecting the SAME new combo hits
  // the registry and reuses the minted id instead of minting a duplicate.
  const comboRegistry = new Map<string, ProfileFileEntry>();
  const comboKey = (runtime: string, model: string): string => `${runtime}\n${model}`;
  for (const profile of input.fileProfiles) {
    const key = comboKey(profile.runtime, profile.model ?? "");
    if (!comboRegistry.has(key)) comboRegistry.set(key, profile);
  }

  for (const selection of input.selections) {
    if (selection.runtime === "") {
      return { kind: "invalid", message: "请为四个角色各选择一个命令行(CLI)。" };
    }
    const runtime: RuntimeId = selection.runtime;
    const model = selection.model;
    // 1. Combo reuse: ANY entry already serving this exact pair — from the
    //    file at start OR minted earlier in this same save — donates its id
    //    (同组合共用一 profile, within one save too: B1).
    const reused = comboRegistry.get(comboKey(runtime, model));
    if (reused !== undefined) {
      targets[selection.roleId] = reused.id;
      continue;
    }
    // 2. Mint: normalize the custom token ("" model needs no token).
    let token: string | null = model === "" ? "" : normalizeModelToken(model, runtime);
    if (input.mintable === false) {
      return {
        kind: "invalid",
        message:
          "本服务没有接入 AI 配置文件,无法新增 AI 配置——请从桌面应用启动后再试,或只选择已载入的命令行与模型组合;本次没有写入任何内容。"
      };
    }
    if (model !== "" && token === null) {
      return {
        kind: "invalid",
        message: `自定义模型「${model}」无法生成合法的配置标识(只允许字母、数字、连字符,且总长不能超限)。请换一个写法。`
      };
    }
    const mintedId = conventionProfileId(runtime, token ?? "");
    // 3. Collision: the convention id already exists but serves a different
    //    pair — refuse (never rewrite, never silently shadow).
    const collision = input.fileProfiles.find((profile) => profile.id === mintedId);
    if (collision !== undefined) {
      const differs = collision.runtime !== runtime || (collision.model ?? "") !== model;
      if (differs) {
        return {
          kind: "conflict",
          message:
            `AI 配置标识「${mintedId}」已被另一个模型或命令行的配置占用(它是 ${collision.runtime === runtime ? `CLI 相同但模型是 ${collision.model ?? "CLI 默认"}` : "其他命令行"} 的配置)。修改既有配置是人的决定,本页不会覆盖——请换个模型写法,或先到旧工作台「配置」页处理那条配置;本次没有写入任何内容。`
        };
      }
    }
    // Two selections minting the same id with different model values (e.g.
    // "Sonnet 4.5" vs "sonnet-4-5"): one id cannot carry two models.
    const sameIdDifferentValue = addedProfiles.find(
      (profile) => profile.id === mintedId && (profile.model ?? "") !== model
    );
    if (sameIdDifferentValue !== undefined) {
      return {
        kind: "conflict",
        message: `两个角色选择的自定义模型会生成同一个配置标识「${mintedId}」但模型名不同(${sameIdDifferentValue.model ?? "CLI 默认"} 与 ${model})。请统一写法后重试;本次没有写入任何内容。`
      };
    }
    // 4. Clone base: prefer the entry the role is CURRENTLY bound to (when it
    //    is the same runtime — the role keeps its executable/configDir), else
    //    the file's first same-runtime entry.
    const currentId = bindingByRole.get(selection.roleId) ?? null;
    const base =
      input.fileProfiles.find((profile) => profile.id === currentId && profile.runtime === runtime) ??
      input.fileProfiles.find((profile) => profile.runtime === runtime);
    if (base === undefined) {
      return {
        kind: "invalid",
        message: "本机还没有这个命令行的 AI 配置(配置文件里没有任何同名 CLI 的条目)。请先到初始设置生成推荐配置,或在旧工作台「配置」页手动添加。"
      };
    }
    const minted: ProfileFileEntry = {
      id: mintedId,
      runtime: base.runtime,
      executable: base.executable,
      executionTarget: base.executionTarget,
      configDir: base.configDir,
      model: model === "" ? null : model,
      credentialGroup: base.credentialGroup,
      maxConcurrency: base.maxConcurrency,
      timeoutSeconds: base.timeoutSeconds
    };
    addedProfiles.push(minted);
    nextFileProfiles.push(minted);
    // Register the mint under its combo so later roles in this same save
    // REUSE it (one combo, one profile — B1).
    comboRegistry.set(comboKey(runtime, model), minted);
    targets[selection.roleId] = mintedId;
  }

  // Write-guard (defense in depth, B1): the merged set must never carry a
  // duplicated id. After the registry fix this is unreachable for planning
  // bugs — but a pre-bricked INPUT file (duplicates already on disk from an
  // earlier buggy save) lands here too, and the refusal keeps the UI from
  // round-tripping the brick; the server's frozen schema would accept it and
  // the next serve start would die on orchestrator.ts:138.
  const duplicateId = firstDuplicateProfileId(nextFileProfiles);
  if (duplicateId !== null) {
    return { kind: "conflict", message: duplicateProfileIdMessage(duplicateId) };
  }

  const bindingsChanged = input.selections.some(
    (selection) => (bindingByRole.get(selection.roleId) ?? null) !== targets[selection.roleId]
  );
  return {
    kind: "ok",
    targets,
    addedProfiles,
    nextFileProfiles,
    fileChanged: addedProfiles.length > 0,
    bindingsChanged
  };
}

/** Serialize the merged set to the exact file shape the frozen parser and the
 * first-run generator emit (setup.ts JSON.stringify(…, 2) + trailing LF).
 * `extraArgs` is always present and always empty (the schema's v1 rule). */
export function profilesFileContent(profiles: readonly ProfileFileEntry[]): string {
  return (
    JSON.stringify(
      {
        schemaVersion: 1,
        profiles: profiles.map((profile) => ({
          id: profile.id,
          runtime: profile.runtime,
          executable: profile.executable,
          executionTarget: profile.executionTarget,
          configDir: profile.configDir,
          model: profile.model,
          credentialGroup: profile.credentialGroup,
          maxConcurrency: profile.maxConcurrency,
          timeoutSeconds: profile.timeoutSeconds,
          extraArgs: [] as never[]
        }))
      },
      null,
      2
    ) + "\n"
  );
}

/**
 * Models already in use (the file set first, the loaded list filling gaps) —
 * the pure basis for the editor's "already pickable" options ABOVE 自定义 and
 * for the prefill's explicit custom marker (a bound combo whose model is in
 * neither the curated list nor this set renders as an active 自定义 input).
 */
export function knownModelsOf(
  entries: readonly { readonly runtime: string; readonly model: string | null }[]
): Readonly<Record<RuntimeId, readonly string[]>> {
  const models: Record<RuntimeId, string[]> = { claude: [], codex: [] };
  for (const entry of entries) {
    if (entry.runtime !== "claude" && entry.runtime !== "codex") continue;
    if (entry.model !== null && entry.model !== "" && !models[entry.runtime].includes(entry.model)) {
      models[entry.runtime].push(entry.model);
    }
  }
  return models;
}

/** True when `model` renders as a LISTED option for the runtime (curated
 * advice or already-in-use) — i.e. the select can carry it without the
 * 自定义 branch. */
export function isListedModel(model: string, runtime: RuntimeId, knownModels?: Readonly<Record<RuntimeId, readonly string[]>>): boolean {
  if (model === "") return false;
  if (CURATED_MODELS[runtime].includes(model)) return true;
  return knownModels?.[runtime]?.includes(model) === true;
}

/**
 * The prefill (pure): a role that is bound AND loaded reflects its CURRENT
 * combo; otherwise the recommended template's runtime with the CLI 默认 model
 * on top (the M11-06 ask: "defaults 之上可选模型"); a role with neither gets
 * an empty runtime (the select shows its placeholder; save stays blocked).
 * A bound combo whose model is OFF every list (curated + knownModels) prefills
 * with the EXPLICIT custom marker so the editor reveals the free-text input
 * carrying that value (B2: the marker is state, never derived from the value
 * at render time).
 */
export function initialModelSelections(
  template:
    | readonly { readonly roleId: SetupRoleId; readonly runtime: string }[]
    | null
    | undefined,
  resolved: readonly { readonly roleId: SetupRoleId; readonly profileId: string | null; readonly notLoaded: boolean }[],
  loadedById: ReadonlyMap<string, { readonly runtime: string; readonly model: string | null }>,
  knownModels?: Readonly<Record<RuntimeId, readonly string[]>>
): Readonly<Record<SetupRoleId, ModelSelection>> {
  const selections: Record<SetupRoleId, ModelSelection> = {
    coordinator: { runtime: "", model: "", custom: false },
    architect: { runtime: "", model: "", custom: false },
    developer: { runtime: "", model: "", custom: false },
    reviewer: { runtime: "", model: "", custom: false }
  };
  for (const roleId of Object.keys(selections) as SetupRoleId[]) {
    const entry = resolved.find((candidate) => candidate.roleId === roleId);
    if (entry !== undefined && entry.profileId !== null && !entry.notLoaded) {
      const profile = loadedById.get(entry.profileId);
      if (profile !== undefined && (profile.runtime === "claude" || profile.runtime === "codex")) {
        const model = profile.model ?? "";
        selections[roleId] = {
          runtime: profile.runtime,
          model,
          // CLI 默认 (model "") is never custom; an off-list model prefills
          // with the EXPLICIT custom marker (B2).
          custom: model !== "" && !isListedModel(model, profile.runtime, knownModels)
        };
        continue;
      }
    }
    const suggestion = template?.find((candidate) => candidate.roleId === roleId);
    if (suggestion !== undefined && (suggestion.runtime === "claude" || suggestion.runtime === "codex")) {
      selections[roleId] = { runtime: suggestion.runtime, model: "", custom: false };
    }
  }
  return selections;
}
