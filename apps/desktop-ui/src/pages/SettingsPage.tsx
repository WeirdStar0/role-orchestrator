/**
 * M11-05 设置页(/app/settings): the real settings surface replaces the
 * M11-01 placeholder. Four sections, per the frozen product baseline
 * (docs/BACKLOG.md M11 节: 设置=AI 模型+Agent 团队;Profile/credentialGroup/
 * timeout/maxConcurrency 收进「高级设置」;观测台移出一级导航,归 设置>开发者):
 *
 * - AI 模型: the setup/status detection result (Claude Code ✓ / Codex ✓)
 *   plus every LOADED profile's model — `model: null` renders as CLI 默认
 *   (the schema's own meaning, contracts/src/schema/profiles.ts:8; the UI
 *   never invents a model name).
 * - Agent 团队: the four-role mapping as readable cards — for a SELECTED
 *   registered project the project's real bindings (read through the
 *   EXISTING GET /api/v1/projects/role-bindings?projectDir= lookup), with a
 *   修改 editor. M11-06: the editor upgrades to per-role (CLI × model)
 *   selection — CLI options from the setup/status detection, model options
 *   the curated advice list (M11-06 ask: opus/sonnet/haiku; codex's real-
 *   evidence names) plus CLI 默认 plus a 自定义 free-text input, always with
 *   the 以 CLI 实际支持为准 note. Saving goes through the SAME primitives as
 *   before, composed (teamSave.ts): diff-merge the target profiles into the
 *   file's full set via the EXISTING atomic PUT /api/v1/profiles/full
 *   (existing entries are never rewritten — add-only), then the EXISTING
 *   transactional PUT /api/v1/projects/:id/role-bindings (all four land or
 *   none do) — the binding PUT only fires when every target is LOADED; a
 *   freshly minted profile is not loaded until the desktop app restarts, and
 *   the page says exactly that (重启后再保存一次完成切换) instead of firing a
 *   PUT the server must refuse.
 * - 高级设置 (collapsed): per-profile credentialGroup / timeoutSeconds /
 *   maxConcurrency, read-only. These fields are part of the profiles FILE,
 *   so editing them means editing that file's JSON — this page POINTS there
 *   (the old workbench 配置 page's editor writes through the EXISTING
 *   atomic PUT /api/v1/profiles/full) instead of adding a write surface.
 * - 开发者模式 (collapsed): the diagnostic console's positioning — Runtime /
 *   DAG Inspector / 执行事件 / Context / Memory / 原始 API live on the old
 *   workbench's 高级(观测台) tab today (a tabbed page — there are no deep
 *   anchors to link); the relocation to /debug happens when the new UI takes
 *   over / (the frozen M11 baseline), so the copy states today's truth and
 *   the plan without pretending either already happened.
 *
 * 保存动作全部经既有原语 (M11-06): the writes this page performs are the
 * EXISTING atomic PUT /api/v1/profiles/full (via the add-only diff-merge in
 * teamSave.ts) and the transactional role-bindings PUT — no new endpoint, no
 * new server surface. Effect timing is stated EXACTLY: a completed binding
 * applies to the project's NEW tasks immediately (the server reads bindings
 * per task creation); the profiles FILE side needs a DESKTOP APP RESTART to
 * reach the running service — never hot-reloaded (serveProfilesFullPut's own
 * note) — and a binding whose target profile is not loaded yet is honestly
 * deferred (重启后再保存一次) rather than fired into a guaranteed 422.
 *
 * M11-07 接入配置管理面 adds the「接入配置(AI 供应商)」Card between AI 模型
 * and Agent 团队 — the ask offered 「/app/settings 内新折叠区或独立路由
 * /app/providers」and the batch decision is: a REGULAR (non-collapsed)
 * section on this page. Rationale: the section is the primary management
 * face now (hiding it behind a collapse or a nav-free extra route both bury
 * it); the page already owns the two datasets every CRUD action needs (the
 * loaded set + the file's full set), and no navigation/route surface
 * changes. The CRUD planners live in profileManager.ts (pure, unit-tested):
 * create/edit rebuild the FULL entry list and write it through the EXISTING
 * atomic PUT /api/v1/profiles/full (other entries carried object-for-object;
 * 409-drift and M9-04 same-id-model-edit refusals happen BEFORE any write);
 * delete first joins the EXISTING projects list with the EXISTING per-
 * project binding lookups and refuses while any project still binds the
 * profile. The ONLY new server surface is the read-only stat probe
 * GET /api/v1/profiles/path-check (the browser cannot stat the filesystem):
 * it checks path EXISTENCE only — executable paths of user-supplied wrapper
 * scripts are never read or validated for content. There is deliberately NO
 * API key / token / base-URL input anywhere: credentials stay with the
 * CLI's own login inside configDir (the standing 零接触 note rides the form
 * and the list).
 *
 * 人话 discipline: the AI 模型/团队 sections render product names only
 * (profile ids ride as the select values / PUT handles, exactly like the
 * wizard's editor); the collapsed 高级设置 rows carry the id as a
 * configuration-surface suffix (the RoleBindingEditor precedent — ids are
 * configuration facts, not default-view identifiers). The old-workbench
 * link stays a NATIVE <a href="/"> (M11-02 review handover A: a router
 * <Link> would resolve to /app under the basename).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Bot, Cpu, LoaderCircle, Plus, Plug, Save, Trash2, Users } from "lucide-react";
import {
  ApiError,
  checkProfilePath,
  fetchAllProjectBindings,
  fetchCsrfToken,
  fetchProfiles,
  fetchProfilesFull,
  fetchProjects,
  fetchRoleBindings,
  fetchSetupStatus,
  putProfilesFull,
  type ProfileFullEntry,
  type ProfileSummary,
  type ProjectSummary,
  type RoleBindingsView,
  type SetupRoleId,
  type SetupStatus
} from "../api";
import { bindingFailureText, profilesFullFailureText } from "../runErrors";
import {
  RoleBindingCards,
  RoleComboEditor,
  bindingsComplete,
  resolveRoleBindings,
  roleHumanLabel,
  runtimeName
} from "../components/RoleBindingSection";
import {
  EMPTY_MODEL_SELECTIONS,
  initialModelSelections,
  knownModelsOf,
  loadedAsComboSource,
  profilesFileContent,
  runtimeIdOf,
  type ModelSelection,
  type RuntimeId
} from "../profileUpsert";
import {
  CREDENTIAL_NOTE,
  EMPTY_PROFILE_DRAFT,
  EXECUTION_TARGET_IDS,
  EXECUTABLE_BARE_NAME_NOTE,
  LOAD_STATE_LABELS,
  WRAPPER_NOTE,
  collectProfileReferences,
  composeProfileDelete,
  composeProfileSave,
  configDirStatVerdict,
  executableIsStatCheckable,
  executableStatVerdict,
  profileLoadState,
  type ExecutionTargetId,
  type ProfileDraft
} from "../profileManager";
import { saveAgentTeamSelections } from "../teamSave";
import { dirNameFromPath } from "./ProjectsPage";
import { createOneShotGate, type OneShotGate } from "../oneShotGate";
import { Card, FormStatus } from "../components/ui";

/** 『CLI 默认』: the honest rendering of `model: null` (the schema defines
 * null as "use the CLI default model"; the UI does not guess a name). */
export function profileModelLine(model: string | null): string {
  return model === null ? "CLI 默认" : model;
}

/** The per-runtime ordinal for the model list (two Claude profiles read
 * 「Claude Code ·配置 2」; a lone profile carries no ordinal — nothing
 * invented, just position). */
export function profileDisplayName(profile: ProfileSummary, sameRuntimeIndex: number): string {
  const name = runtimeName(profile.runtime);
  return sameRuntimeIndex === 0 ? name : `${name} ·配置 ${String(sameRuntimeIndex + 1)}`;
}

/** The AI 模型 list face (pure): one row per loaded profile; a refused
 * profiles list renders the honest UNKNOWN sentence — never an empty list
 * dressed up as "no profiles". */
export function AiModelRows(props: {
  readonly profiles: readonly ProfileSummary[] | null;
}): ReactNode {
  if (props.profiles === null) {
    return <p className="form-status form-status-error">AI 配置状态未知(拉取失败)。请重试或重启桌面应用后再查看。</p>;
  }
  if (props.profiles.length === 0) {
    return <p className="form-status">还没有已载入的 AI 配置。</p>;
  }
  const seen = new Map<string, number>();
  return (
    <div className="settings-model-list">
      {props.profiles.map((profile) => {
        const index = seen.get(profile.runtime) ?? 0;
        seen.set(profile.runtime, index + 1);
        return (
          <p key={profile.id} className="settings-model-row">
            <span className="settings-model-name">{profileDisplayName(profile, index)}</span>
            <span className="settings-model-value">模型:{profileModelLine(profile.model)}</span>
          </p>
        );
      })}
    </div>
  );
}

/** The profile file-state line (pure): what the detection actually saw, with
 * the restart truth kept exact (生成 ≠ 生效). */
export function profilesStateLine(status: SetupStatus): string {
  const { fileState, loadedProfiles } = status.profiles;
  if (fileState === "configured") {
    return loadedProfiles > 0
      ? `配置文件已接入,本服务已载入 ${String(loadedProfiles)} 个 AI 配置。`
      : "配置文件已生成,但本服务还没有载入它——重启桌面应用后生效。";
  }
  if (fileState === "unparseable") return "配置文件存在,但内容无法解析——请在旧工作台的「配置」页修复。";
  if (fileState === "unwired") return "本服务没有接入配置文件(未传 --profiles)——请从桌面应用启动。";
  return "还没有 AI 配置文件——可到初始设置生成推荐配置,或在旧工作台的「配置」页手动配置。";
}

/** The default-template face (pure): the recommended division as four
 * readable role lines. A null template (probe refused / neither CLI found)
 * states exactly that — no fabricated suggestion. */
export function TemplateCards(props: {
  readonly template: readonly { readonly roleId: SetupRoleId; readonly runtime: "claude" | "codex" }[] | null;
}): ReactNode {
  if (props.template === null) {
    return <p className="form-status">暂无推荐分工(未完成 CLI 检测,或本机没有检测到 Claude Code / Codex)。</p>;
  }
  return (
    <div className="role-cards">
      {props.template.map((entry) => (
        <div key={entry.roleId} className="role-card role-card-ok">
          <p className="role-card-role">{roleHumanLabel(entry.roleId)}(建议)</p>
          <p className="role-card-runtime">{runtimeName(entry.runtime)}</p>
        </div>
      ))}
    </div>
  );
}

/** The 高级设置 table face (pure): read-only per-profile operation caps.
 * Unknown values render 未知, never an invented number. */
export function AdvancedProfileRows(props: {
  readonly profiles: readonly ProfileSummary[] | null;
}): ReactNode {
  if (props.profiles === null) {
    return <p className="form-status form-status-error">AI 配置状态未知(拉取失败),无法显示高级属性。</p>;
  }
  if (props.profiles.length === 0) {
    return <p className="form-status">没有已载入的 AI 配置,没有可显示的高级属性。</p>;
  }
  return (
    <div className="settings-adv">
      {props.profiles.map((profile) => (
        <p key={profile.id} className="settings-adv-row">
          {runtimeName(profile.runtime)}({profile.id}) · 凭据组:{profile.credentialGroup ?? "未知"} · 超时:
          {profile.timeoutSeconds === null ? "未知" : `${String(profile.timeoutSeconds)} 秒`} · 最大并发:
          {profile.maxConcurrency === null ? "未知" : String(profile.maxConcurrency)}
        </p>
      ))}
    </div>
  );
}

/** The 接入配置 list badge (pure): 已载入 (in the running service's set) vs
 * 待重启载入 (written to the file, hot reload does not exist). */
export function ProviderLoadBadge(props: { readonly state: "loaded" | "file-only" }): ReactNode {
  return props.state === "loaded" ? (
    <span className="status-badge status-success">{LOAD_STATE_LABELS.loaded}</span>
  ) : (
    <span className="status-badge status-warning">{LOAD_STATE_LABELS["file-only"]}</span>
  );
}

/** One 接入配置 list row (pure): the summary face (名称/类型/模型/载入状态)
 * plus the FULL frozen fields from GET /api/v1/profiles/full — the reduced
 * GET /api/v1/profiles projection deliberately withholds some of them
 * (M11-05), so this management face reads the file view. The configDir line
 * carries the standing 零接触 suffix. All callbacks are optional so the
 * render tests can mount the row bare. */
export function ProviderConfigRow(props: {
  readonly entry: ProfileFullEntry;
  readonly loadState: "loaded" | "file-only";
  readonly editing?: boolean;
  readonly deleteArmed?: boolean;
  readonly busy?: boolean;
  readonly onEdit?: () => void;
  readonly onArmDelete?: () => void;
  readonly onCancelDelete?: () => void;
  readonly onConfirmDelete?: () => void;
}): ReactNode {
  return (
    <div className="provider-row">
      <p className="provider-row-head">
        <span className="provider-row-name">{props.entry.id}</span>
        <ProviderLoadBadge state={props.loadState} />
      </p>
      <p className="provider-row-line">
        类型:{runtimeName(props.entry.runtime)} · 模型:{profileModelLine(props.entry.model)}
      </p>
      <p className="provider-row-line">可执行路径:{props.entry.executable}</p>
      <p className="provider-row-line">
        凭据目录:{props.entry.configDir}
        <span className="provider-row-note">(凭据由 CLI 自行登录管理,本产品零接触)</span>
      </p>
      <p className="provider-row-line">
        凭据组:{props.entry.credentialGroup} · 执行目标:{props.entry.executionTarget} · 最大并发:
        {String(props.entry.maxConcurrency)} · 超时:{String(props.entry.timeoutSeconds)} 秒
      </p>
      <div className="provider-row-actions">
        {props.onEdit !== undefined ? (
          <button type="button" className="btn" onClick={props.onEdit} disabled={props.busy === true || props.editing === true}>
            编辑
          </button>
        ) : null}
        {props.onArmDelete !== undefined ? (
          props.deleteArmed === true ? (
            <>
              <button
                type="button"
                className="btn btn-provider-danger"
                onClick={props.onConfirmDelete}
                disabled={props.busy === true}
              >
                <Trash2 size={14} /> 确认删除
              </button>
              <button type="button" className="btn" onClick={props.onCancelDelete} disabled={props.busy === true}>
                取消
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn"
              onClick={props.onArmDelete}
              disabled={props.busy === true || props.editing === true}
            >
              删除
            </button>
          )
        ) : null}
      </div>
    </div>
  );
}

/** The create/edit form (pure, controlled): 名称(id; read-only in edit
 * mode — 改名=删旧建新)/类型单选/可执行路径/模型(空=CLI 默认)/凭据目录+
 * 零接触提示/高级折叠(凭据组、执行目标、并发、超时——后两者即 schema 的
 * 1..32 与 30..86400)。NO secret-shaped field exists anywhere on it. */
export function ProviderConfigForm(props: {
  readonly draft: ProfileDraft;
  readonly editingId: string | null;
  readonly knownModels: Readonly<Record<RuntimeId, readonly string[]>>;
  readonly onField: (patch: Partial<ProfileDraft>) => void;
}): ReactNode {
  const draft = props.draft;
  const modelOptions = draft.runtime === "" ? [] : props.knownModels[draft.runtime] ?? [];
  return (
    <div className="provider-form">
      <label className="field-label" htmlFor="provider-id">
        名称(配置的唯一标识)
      </label>
      {props.editingId !== null ? (
        <>
          <p className="provider-row-line" data-testid="provider-id-fixed">
            {props.editingId}
          </p>
          <p className="form-status">名称不可修改(它是绑定的标识)。要改名请新增一条配置,再删除旧的——删除时会自动检查引用。</p>
        </>
      ) : (
        <input
          id="provider-id"
          className="input"
          value={draft.id}
          onChange={(event) => props.onField({ id: event.target.value })}
          placeholder="例如 claude-glm(小写字母开头,可用字母/数字/连字符/下划线)"
          maxLength={80}
        />
      )}

      <span className="field-label">类型</span>
      <div className="provider-radios" role="radiogroup" aria-label="类型">
        <label className="provider-radio">
          <input
            id="provider-runtime-claude"
            type="radio"
            name="provider-runtime"
            value="claude"
            checked={draft.runtime === "claude"}
            onChange={() => props.onField({ runtime: "claude" })}
          />
          Claude Code
        </label>
        <label className="provider-radio">
          <input
            id="provider-runtime-codex"
            type="radio"
            name="provider-runtime"
            value="codex"
            checked={draft.runtime === "codex"}
            onChange={() => props.onField({ runtime: "codex" })}
          />
          Codex
        </label>
      </div>

      <label className="field-label" htmlFor="provider-executable">
        可执行路径(CLI 本体,或第三方兼容端点的 wrapper 脚本)
      </label>
      <input
        id="provider-executable"
        className="input"
        value={draft.executable}
        onChange={(event) => props.onField({ executable: event.target.value })}
        placeholder="例如 C:\\tools\\my-cli-wrapper.cmd"
        maxLength={2048}
      />
      <p className="form-status">{WRAPPER_NOTE}</p>

      <label className="field-label" htmlFor="provider-model">
        模型(留空 = 使用 CLI 默认模型)
      </label>
      <input
        id="provider-model"
        className="input"
        value={draft.model}
        onChange={(event) => props.onField({ model: event.target.value })}
        placeholder="留空 = CLI 默认"
        maxLength={200}
        list="provider-model-options"
      />
      <datalist id="provider-model-options">
        {modelOptions.map((model) => (
          <option key={model} value={model} />
        ))}
      </datalist>

      <label className="field-label" htmlFor="provider-config-dir">
        凭据目录
      </label>
      <input
        id="provider-config-dir"
        className="input"
        value={draft.configDir}
        onChange={(event) => props.onField({ configDir: event.target.value })}
        placeholder="例如 C:\\Users\\me\\.my-cli"
        maxLength={2048}
      />
      <p className="form-status">{CREDENTIAL_NOTE}</p>

      <details className="advanced-box">
        <summary>高级(凭据组 / 执行目标 / 并发 / 超时)</summary>
        <label className="field-label" htmlFor="provider-credential-group">
          凭据组(留空 = 与名称相同,即每个配置独立的配额组)
        </label>
        <input
          id="provider-credential-group"
          className="input"
          value={draft.credentialGroup}
          onChange={(event) => props.onField({ credentialGroup: event.target.value })}
          placeholder="留空 = 与名称相同"
          maxLength={64}
        />
        <label className="field-label" htmlFor="provider-execution-target">
          执行目标(与本机一致;绑定到平台不一致的项目会被拒绝)
        </label>
        <select
          id="provider-execution-target"
          className="select"
          value={draft.executionTarget}
          onChange={(event) => props.onField({ executionTarget: event.target.value as ProfileDraft["executionTarget"] })}
        >
          <option value="">选择执行目标…</option>
          {EXECUTION_TARGET_IDS.map((target) => (
            <option key={target} value={target}>
              {target}
            </option>
          ))}
        </select>
        <label className="field-label" htmlFor="provider-max-concurrency">
          最大并发(1–32)
        </label>
        <input
          id="provider-max-concurrency"
          className="input"
          type="number"
          min={1}
          max={32}
          value={draft.maxConcurrency}
          onChange={(event) => props.onField({ maxConcurrency: event.target.value })}
        />
        <label className="field-label" htmlFor="provider-timeout">
          超时(秒,30–86400)
        </label>
        <input
          id="provider-timeout"
          className="input"
          type="number"
          min={30}
          max={86400}
          value={draft.timeoutSeconds}
          onChange={(event) => props.onField({ timeoutSeconds: event.target.value })}
        />
      </details>
    </div>
  );
}

export function SettingsPage(): ReactNode {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  /** null = the profiles list itself could not be read (UNKNOWN — never
   * presented as an empty list). */
  const [profiles, setProfiles] = useState<readonly ProfileSummary[] | null>(null);
  /** M11-06: the profiles FILE's current full set — the diff base of the
   * (CLI, model) upsert. null = the read failed (unwired/absent/unreadable);
   * parseError !== null = the file exists but does not parse (repair first).
   */
  const [fileFull, setFileFull] = useState<readonly ProfileFullEntry[] | null>(null);
  const [fileFullError, setFileFullError] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [selectedDir, setSelectedDir] = useState("");
  const [bindings, setBindings] = useState<RoleBindingsView | null>(null);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [editingTeam, setEditingTeam] = useState(false);
  const [modelSelections, setModelSelections] =
    useState<Readonly<Record<SetupRoleId, ModelSelection>>>(EMPTY_MODEL_SELECTIONS);
  const [savingTeam, setSavingTeam] = useState(false);
  const [teamMessage, setTeamMessage] = useState<string | null>(null);
  /** The M11-06 pending-restart state: the file was written but the binding
   * PUT was deliberately skipped — info styling, not a success claim. */
  const [teamNotice, setTeamNotice] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  // The synchronous double-fire gate (the M11-03 handover-C pattern): a
  // rapid double-click on 保存 must not walk the PUT twice.
  const saveGate = useRef<OneShotGate | null>(null);
  if (saveGate.current === null) {
    saveGate.current = createOneShotGate();
  }
  // ---- M11-07 接入配置管理面 state ------------------------------------------
  /** null = the form is closed; otherwise the draft plus whether it edits an
   * existing entry (editingId) or creates one (null). */
  const [providerForm, setProviderForm] = useState<
    { readonly editingId: string | null; readonly draft: ProfileDraft } | null
  >(null);
  /** Per-field validation problems (the form's 人话 list). */
  const [providerProblems, setProviderProblems] = useState<readonly string[]>([]);
  const [providerMessage, setProviderMessage] = useState<string | null>(null);
  /** Advisory (non-blocking) stat notes — e.g. a configDir that does not
   * exist yet, which is the normal "CLI will log in here later" case. */
  const [providerWarning, setProviderWarning] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<string | null>(null);
  const [savingProvider, setSavingProvider] = useState(false);
  /** The two-step delete confirm: the armed row's id (null = none armed). */
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const [deletingProvider, setDeletingProvider] = useState(false);
  const providerGate = useRef<OneShotGate | null>(null);
  if (providerGate.current === null) {
    providerGate.current = createOneShotGate();
  }

  useEffect(() => {
    let cancelled = false;
    // The detection status, the loaded profiles, the file's full set and the
    // project list are independent reads; a refused profiles list lands as
    // null (UNKNOWN) and must not take the page down. The FILE read failing
    // lands as an honest sentence (the editor needs it; the read-only faces
    // do not).
    fetchSetupStatus()
      .then((view) => {
        if (!cancelled) setStatus(view);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setStatusError(cause instanceof ApiError ? cause.message : "检测状态不可用。");
      });
    fetchProfiles()
      .then((rows) => {
        if (!cancelled) setProfiles(rows);
      })
      .catch(() => {
        if (!cancelled) setProfiles(null);
      });
    fetchProfilesFull()
      .then((view) => {
        if (cancelled) return;
        if (view.parseError !== null) {
          setFileFull(null);
          setFileFullError("配置文件存在,但内容无法解析——请先到旧工作台(/)的「配置」页修复,再在这里调整角色模型。");
        } else {
          setFileFull(view.profiles ?? []);
          setFileFullError(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileFull(null);
          setFileFullError("AI 配置文件不可读(可能尚未生成)——请先完成初始设置,或从桌面应用重新启动。");
        }
      });
    fetchProjects()
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The selected project's bindings load through the EXISTING lookup (the
  // same surface the wizard and the projects page use).
  useEffect(() => {
    if (selectedDir === "") {
      setBindings(null);
      setBindingsError(null);
      setEditingTeam(false);
      return;
    }
    let cancelled = false;
    setBindings(null);
    setBindingsError(null);
    setEditingTeam(false);
    setTeamMessage(null);
    setTeamNotice(null);
    setTeamError(null);
    fetchRoleBindings(selectedDir)
      .then((view) => {
        if (!cancelled) setBindings(view);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setBindingsError(bindingFailureText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDir]);

  const resolved = bindings === null ? null : resolveRoleBindings(bindings, profiles ?? []);
  // M11-06: 保存 is enabled only when every role has a CLI chosen (the
  // model may be "" = CLI 默认; the server re-validates everything).
  const selectionsReady = (["coordinator", "architect", "developer", "reviewer"] as const).every(
    (roleId) => modelSelections[roleId]!.runtime !== ""
  );
  /** The loaded ids (binding feasibility pre-check) — null profiles list =
   * no pre-check basis (editing is blocked below anyway). */
  const loadedProfileIds = (profiles ?? []).map((profile) => profile.id);
  const detected =
    status === null
      ? null
      : { claude: status.claudeFound, codex: status.codexFound };
  /** Models already in use per runtime (file set first, loaded list fills
   * gaps) — they render as pickable options above 自定义, and the prefill
   * uses the same set to decide the explicit custom marker. */
  const knownModels = knownModelsOf([...(fileFull ?? []), ...(profiles ?? [])]);

  const saveTeam = (): void => {
    // Handover-C gate: the claim is synchronous — a double-click's second
    // press is refused before any state update can re-render.
    if (saveGate.current === null || !saveGate.current.take()) return;
    if (bindings === null || !editingTeam || savingTeam) {
      saveGate.current?.release();
      return;
    }
    if (profiles === null) {
      setTeamError("AI 配置状态未知(拉取失败),暂时无法修改绑定。");
      saveGate.current?.release();
      return;
    }
    if (!selectionsReady) {
      setTeamError("请为四个角色各选择一个命令行(CLI);模型可以保持「CLI 默认」。");
      saveGate.current?.release();
      return;
    }
    setSavingTeam(true);
    setTeamError(null);
    setTeamMessage(null);
    setTeamNotice(null);
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return saveAgentTeamSelections({
          csrfToken: csrf,
          projectId: bindings.projectId,
          selections: modelSelections,
          currentBindings: (bindings.bindings ?? []).map((entry) => ({
            roleId: entry.roleId,
            profileId: entry.profileId
          })),
          // The FILE's full set is the diff base; when it is not readable
          // here the loaded set substitutes as the combo source and minting
          // is refused (bind-only against existing combos — honest, and the
          // same semantics the wizard had before the model upgrade).
          fileProfiles: fileFull ?? loadedAsComboSource(profiles),
          loadedProfileIds,
          mintable: fileFull !== null
        });
      })
      .then((outcome) => {
        if (outcome.kind === "refused") {
          setTeamError(outcome.message);
          return;
        }
        if (outcome.kind === "no-change") {
          setTeamMessage("当前选择与既有配置和绑定一致,没有需要保存的修改。");
          setEditingTeam(false);
          return;
        }
        if (outcome.kind === "bind-pending") {
          setTeamNotice(
            (outcome.addedCount > 0
              ? `已把 ${String(outcome.addedCount)} 个新 AI 配置写入配置文件。`
              : "所需的 AI 配置已在配置文件中。") +
              "运行中的服务还没有载入它——请重启桌面应用;重启后回到本页再点一次「保存」,绑定即会切换到新模型。本次没有改动该项目的绑定。"
          );
          return;
        }
        setTeamMessage(
          "已保存四个角色的分工(一次保存,全部生效或全部不生效),对该项目的新建任务立即生效。" +
            (outcome.fileChanged ? "AI 配置文件已同步更新(其载入需重启桌面应用)。" : "")
        );
        setEditingTeam(false);
        return fetchRoleBindings(selectedDir).then((view) => {
          setBindings(view);
        });
      })
      .catch((cause: unknown) => {
        // A write refusal (atomic: the file is untouched) and a binding
        // refusal (transactional: previous bindings untouched) each carry
        // their own honest sentence.
        setTeamError(
          cause instanceof ApiError && (cause.status === 409 || cause.status === 422) && cause.code !== "UNKNOWN_PROFILE" && cause.code !== "PROFILE_DEFINITION_CONFLICT"
            ? profilesFullFailureText(cause)
            : bindingFailureText(cause)
        );
      })
      .finally(() => {
        setSavingTeam(false);
        saveGate.current?.release();
      });
  };

  const selectModel = (roleId: SetupRoleId, selection: ModelSelection): void => {
    setModelSelections((current) => ({ ...current, [roleId]: selection }));
  };

  // ---- M11-07 接入配置管理面 actions -----------------------------------------
  /** Open the create form. The execution target prefills from an existing
   * entry (the UI never invents this machine's platform — it clones what
   * already works on it); everything else starts at the safe defaults. */
  const openProviderCreate = (): void => {
    const base = fileFull?.[0] ?? null;
    setProviderProblems([]);
    setProviderError(null);
    setProviderMessage(null);
    setProviderWarning(null);
    setDeleteArmedId(null);
    setProviderForm({
      editingId: null,
      draft: {
        ...EMPTY_PROFILE_DRAFT,
        executionTarget:
          base !== null && (EXECUTION_TARGET_IDS as readonly string[]).includes(base.executionTarget)
            ? (base.executionTarget as ExecutionTargetId)
            : ""
      }
    });
  };

  const openProviderEdit = (entry: ProfileFullEntry): void => {
    setProviderProblems([]);
    setProviderError(null);
    setProviderMessage(null);
    setProviderWarning(null);
    setDeleteArmedId(null);
    setProviderForm({
      editingId: entry.id,
      draft: {
        id: entry.id,
        runtime: runtimeIdOf(entry.runtime) ?? "",
        executable: entry.executable,
        model: entry.model ?? "",
        configDir: entry.configDir,
        credentialGroup: entry.credentialGroup,
        executionTarget: (EXECUTION_TARGET_IDS as readonly string[]).includes(entry.executionTarget)
          ? (entry.executionTarget as ExecutionTargetId)
          : "",
        maxConcurrency: String(entry.maxConcurrency),
        timeoutSeconds: String(entry.timeoutSeconds)
      }
    });
  };

  const patchProviderDraft = (patch: Partial<ProfileDraft>): void => {
    setProviderForm((current) =>
      current === null ? current : { ...current, draft: { ...current.draft, ...patch } }
    );
  };

  const closeProviderForm = (): void => {
    setProviderForm(null);
    setProviderProblems([]);
    setProviderWarning(null);
  };

  /**
   * Save a create-or-edit: plan (pure) → read-only stat checks → the
   * EXISTING atomic PUT /api/v1/profiles/full with the rebuilt FULL set.
   * Refusal order: draft validation → id conflict → (edit of a LOADED
   * entry) the seven-field drift refusal and the M9-04 model refusal — all
   * BEFORE any write; then executable existence (hard gate) and configDir
   * existence (advisory) through the read-only path probe; the probe itself
   * failing refuses the save fail-closed.
   */
  const saveProvider = (): void => {
    if (providerGate.current === null || !providerGate.current.take()) return;
    if (providerForm === null || savingProvider) {
      providerGate.current?.release();
      return;
    }
    if (fileFull === null) {
      setProviderError(
        fileFullError ?? "AI 配置文件不可读,无法在这里新增或修改配置。请从桌面应用启动,或先到旧工作台(/)的「配置」页处理。"
      );
      providerGate.current?.release();
      return;
    }
    const wasCreate = providerForm.editingId === null;
    const plan = composeProfileSave({
      draft: providerForm.draft,
      fileProfiles: fileFull,
      editingId: providerForm.editingId,
      loadedProfileIds
    });
    if (plan.kind === "invalid") {
      setProviderProblems(plan.problems);
      providerGate.current?.release();
      return;
    }
    if (plan.kind === "conflict") {
      setProviderProblems([]);
      setProviderError(plan.message);
      providerGate.current?.release();
      return;
    }
    setProviderProblems([]);
    setSavingProvider(true);
    setProviderError(null);
    setProviderMessage(null);
    setProviderWarning(null);
    const executableForStat = plan.entry.executable;
    const configDirForStat = plan.entry.configDir;
    const executableCheck: Promise<string | null> = executableIsStatCheckable(executableForStat)
      ? checkProfilePath(executableForStat).then(
          (probe) => executableStatVerdict(executableForStat, probe),
          (cause: unknown) =>
            `路径检查暂时不可用(${cause instanceof ApiError ? cause.message : "网络错误"})——没有确认可执行文件存在,本次没有写入任何内容。`
        )
      : Promise.resolve(null);
    const configDirCheck: Promise<string | null> = checkProfilePath(configDirForStat).then(
      (probe) => configDirStatVerdict(configDirForStat, probe),
      () => null
    );
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return Promise.all([executableCheck, configDirCheck]).then(
          ([executableProblem, configDirNote]) => ({ csrf, executableProblem, configDirNote })
        );
      })
      .then(({ csrf, executableProblem, configDirNote }) => {
        if (executableProblem !== null) {
          // The hard gate: without a confirmed-existing executable file,
          // nothing is written.
          if (configDirNote !== null) setProviderWarning(configDirNote);
          setProviderError(executableProblem);
          return;
        }
        if (configDirNote !== null) setProviderWarning(configDirNote);
        if (!plan.changed) {
          setProviderMessage("与现有配置一致,没有需要保存的修改。");
          return;
        }
        return putProfilesFull(csrf, profilesFileContent(plan.nextProfiles)).then((nowEntries) => {
          setFileFull(nowEntries);
          setProviderForm(null);
          const bareNameNote = executableIsStatCheckable(executableForStat) ? "" : `另外:${EXECUTABLE_BARE_NAME_NOTE}`;
          setProviderMessage(
            `配置「${plan.entry.id}」已${wasCreate ? "写入" : "更新到"}配置文件,你的其他 AI 配置逐条保留。` +
              "运行中的服务还没有载入它——请重启桌面应用;重启后它即生效,并可在角色绑定中选择(列表中会从「待重启载入」变为「已载入」)。" +
              bareNameNote
          );
        });
      })
      .catch((cause: unknown) => {
        setProviderError(
          cause instanceof ApiError
            ? profilesFullFailureText(cause)
            : `AI 配置保存失败: ${cause instanceof Error ? cause.message : String(cause)}`
        );
      })
      .finally(() => {
        setSavingProvider(false);
        providerGate.current?.release();
      });
  };

  /**
   * Confirm the delete of an armed row: the reference set is the EXISTING
   * projects list joined with the EXISTING per-project binding lookups; any
   * referencing project blocks the deletion with the list (pure planner).
   * Fail-closed: if the reference data cannot be read, nothing is deleted.
   */
  const confirmProviderDelete = (profileId: string): void => {
    if (providerGate.current === null || !providerGate.current.take()) return;
    if (deletingProvider) {
      providerGate.current?.release();
      return;
    }
    if (fileFull === null) {
      setProviderError(fileFullError ?? "AI 配置文件不可读,无法在这里删除配置。");
      providerGate.current?.release();
      return;
    }
    if (projects === null) {
      setProviderError("项目清单还没有读取完成,无法确认角色绑定引用。请稍后再试;本次没有写入任何内容。");
      providerGate.current?.release();
      return;
    }
    setDeletingProvider(true);
    setProviderError(null);
    setProviderMessage(null);
    setProviderWarning(null);
    let phase: "references" | "write" = "references";
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return fetchAllProjectBindings(projects.map((project) => project.repoRoot)).then((rows) => {
          const bindingsByRepoRoot = new Map(rows.map((row) => [row.repoRoot, row.bindings]));
          const references = collectProfileReferences({ projects, bindingsByRepoRoot, profileId });
          const plan = composeProfileDelete({ fileProfiles: fileFull, profileId, references });
          return { csrf, plan };
        });
      })
      .then(({ csrf, plan }) => {
        if (plan.kind === "blocked") {
          setProviderError(plan.message);
          return;
        }
        phase = "write";
        return putProfilesFull(csrf, profilesFileContent(plan.nextProfiles)).then((nowEntries) => {
          setFileFull(nowEntries);
          setDeleteArmedId(null);
          setProviderMessage(
            `配置「${profileId}」已从配置文件移除,其余配置逐条保留。运行中的服务在重启前仍持有它的旧载入(不影响已创建的任务);重启桌面应用后,它将不再出现。`
          );
        });
      })
      .catch((cause: unknown) => {
        setProviderError(
          phase === "write" && cause instanceof ApiError
            ? profilesFullFailureText(cause)
            : cause instanceof ApiError
              ? `无法完成引用检查(${cause.message})——为避免误删仍被引用的配置,本次没有写入任何内容。`
              : `删除失败: ${cause instanceof Error ? cause.message : String(cause)};本次没有写入任何内容。`
        );
      })
      .finally(() => {
        setDeletingProvider(false);
        providerGate.current?.release();
      });
  };

  return (
    <div className="app-main-inner">
      <h1 className="page-title">设置</h1>
      <p className="page-subtitle">
        本机的 AI 检测结果与各项目的团队分工。改动从哪里来、何时生效,页面上都有说明。
      </p>

      <Card>
        <h2 className="section-title">
          <Cpu size={18} /> AI 模型
        </h2>
        {statusError !== null ? (
          <FormStatus kind="error">无法读取检测状态:{statusError}</FormStatus>
        ) : null}
        {status === null && statusError === null ? <p className="form-status">正在读取检测结果…</p> : null}
        {status !== null ? (
          <>
            <p className="form-status">
              Claude Code:{status.claudeFound ? "✓ 已检测" : "未检测到"} · Codex:{status.codexFound ? "✓ 已检测" : "未检测到"}
            </p>
            <p className="form-status">{profilesStateLine(status)}</p>
          </>
        ) : null}
        <AiModelRows profiles={profiles} />
        <p className="form-status">
          模型显示为「CLI 默认」表示该配置没有指定模型,由命令行工具自行选择——这里不会猜测具体型号。新增、修改或删除
          AI 配置请使用下方「接入配置(AI 供应商)」区;推荐配置可回
          <Link className="inline-link" to="/setup">初始设置</Link>
          重新生成(保存后需重启桌面应用才能生效)。
        </p>
      </Card>

      <Card>
        <h2 className="section-title">
          <Plug size={18} /> 接入配置(AI 供应商)
        </h2>
        <p className="form-status">
          这是 AI 配置文件条目的管理面:新增、编辑、删除接入配置,不必手改 JSON。每次保存都是整文件的原子重写——你的其他配置逐条保留;修改需重启桌面应用后才生效(没有热重载)。凭据始终由
          CLI 自行登录管理——本页没有任何 API key、令牌或接口地址输入;第三方兼容端点经可执行路径指向您自备的 wrapper
          脚本接入,产品只检查脚本路径存在,不查看脚本内容。
        </p>
        {fileFull === null ? (
          <FormStatus kind="error">
            {fileFullError ?? "AI 配置文件不可读(可能尚未生成)——请先完成初始设置,或从桌面应用重新启动。"}
          </FormStatus>
        ) : (
          <>
            {fileFull.length === 0 ? (
              <p className="form-status">配置文件中暂时没有任何条目。</p>
            ) : (
              <div className="provider-list">
                {fileFull.map((entry) => (
                  <ProviderConfigRow
                    key={entry.id}
                    entry={entry}
                    loadState={profileLoadState(entry.id, loadedProfileIds)}
                    editing={providerForm?.editingId === entry.id}
                    deleteArmed={deleteArmedId === entry.id}
                    busy={savingProvider || deletingProvider}
                    onEdit={() => openProviderEdit(entry)}
                    onArmDelete={() => {
                      setProviderError(null);
                      setDeleteArmedId(entry.id);
                    }}
                    onCancelDelete={() => setDeleteArmedId(null)}
                    onConfirmDelete={() => confirmProviderDelete(entry.id)}
                  />
                ))}
              </div>
            )}
            {providerProblems.map((problem) => (
              <FormStatus kind="error" key={problem}>
                {problem}
              </FormStatus>
            ))}
            {providerError !== null ? <FormStatus kind="error">{providerError}</FormStatus> : null}
            {providerWarning !== null ? <FormStatus kind="info">{providerWarning}</FormStatus> : null}
            {providerMessage !== null ? <FormStatus kind="success">{providerMessage}</FormStatus> : null}
            {providerForm !== null ? (
              <>
                <p className="node-drill-head" style={{ marginTop: 12 }}>
                  {providerForm.editingId === null ? "新增接入配置" : `编辑配置 ${providerForm.editingId}`}
                </p>
                <ProviderConfigForm
                  draft={providerForm.draft}
                  editingId={providerForm.editingId}
                  knownModels={knownModels}
                  onField={patchProviderDraft}
                />
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <button type="button" className="btn btn-primary" onClick={saveProvider} disabled={savingProvider}>
                    {savingProvider ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} 保存配置
                  </button>
                  <button type="button" className="btn" onClick={closeProviderForm}>
                    取消
                  </button>
                </div>
              </>
            ) : (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={openProviderCreate}
                  disabled={savingProvider || deletingProvider}
                >
                  <Plus size={16} /> 新增接入配置
                </button>
              </div>
            )}
          </>
        )}
      </Card>

      <Card>
        <h2 className="section-title">
          <Users size={18} /> Agent 团队
        </h2>
        <p className="form-status">
          四个角色(协调 / 架构 / 开发 / 评审)各自由哪个 AI 承担,按项目逐一绑定。选择一个项目查看或修改;
          未选择时显示推荐分工(默认模板,仅供参考,不会被自动写入)。
        </p>
        <label className="field-label" htmlFor="settings-project-select">
          项目
        </label>
        {projects === null ? (
          <p className="form-status">正在读取项目…</p>
        ) : (
          <select
            id="settings-project-select"
            className="select"
            value={selectedDir}
            onChange={(event) => setSelectedDir(event.target.value)}
          >
            <option value="">选择项目查看其团队分工…</option>
            {projects.map((project) => (
              <option key={project.repoRoot} value={project.repoRoot}>
                {dirNameFromPath(project.repoRoot)}
              </option>
            ))}
          </select>
        )}
        {projects !== null && projects.length === 0 ? (
          <p className="form-status">
            还没有登记项目。回
            <Link className="inline-link" to="/projects">项目</Link>
            页登记一个 git 仓库后,可以在这里调整它的分工。
          </p>
        ) : null}

        {selectedDir === "" ? (
          <>
            <p className="node-drill-head" style={{ marginTop: 12 }}>推荐分工(默认模板)</p>
            <TemplateCards template={status?.defaultBindingTemplate ?? null} />
            <p className="form-status">
              项目绑定保存后立即对该项目的新建任务生效;AI 配置文件本身的修改(模型、凭据组等)需重启桌面应用后才生效。
            </p>
          </>
        ) : bindingsError !== null ? (
          <FormStatus kind="error">{bindingsError}</FormStatus>
        ) : bindings === null ? (
          <p className="form-status">
            <LoaderCircle size={14} className="spin" /> 正在读取该项目绑定…
          </p>
        ) : resolved !== null ? (
          <>
            <p className="node-drill-head" style={{ marginTop: 12 }}>当前分工</p>
            <RoleBindingCards resolved={resolved} />
            {teamMessage !== null ? <FormStatus kind="success">{teamMessage}</FormStatus> : null}
            {teamNotice !== null ? <FormStatus kind="info">{teamNotice}</FormStatus> : null}
            {teamError !== null ? <FormStatus kind="error">{teamError}</FormStatus> : null}
            {editingTeam ? (
              <>
                <p className="form-status">
                  为每个角色选择命令行(CLI)与模型;模型选「CLI 默认」表示由命令行自行选择。保存会先同步 AI
                  配置文件(既有条目不会被改动),再把四个角色的绑定一次事务切换。
                </p>
                {profiles === null ? (
                  <FormStatus kind="error">AI 配置状态未知(拉取失败),暂时无法修改绑定。请重试后再改。</FormStatus>
                ) : status === null ? (
                  <FormStatus kind="error">检测状态不可用,暂时无法修改角色模型。请重试后再改。</FormStatus>
                ) : (
                  <>
                    {fileFull === null ? (
                      <FormStatus kind="info">
                        {fileFullError ?? "AI 配置文件不可读:这里只能选择已载入的命令行与模型组合,不能新增 AI 配置。"}
                      </FormStatus>
                    ) : null}
                    <RoleComboEditor
                      selections={modelSelections}
                      onChange={selectModel}
                      detected={detected}
                      knownModels={knownModels}
                    />
                  </>
                )}
                <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                  <button type="button" className="btn btn-primary" onClick={saveTeam} disabled={savingTeam || !selectionsReady}>
                    {savingTeam ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />} 保存绑定
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setEditingTeam(false);
                      setTeamError(null);
                    }}
                  >
                    取消
                  </button>
                </div>
              </>
            ) : (
              <div style={{ marginTop: 10 }}>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const loadedById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
                    setModelSelections(
                      initialModelSelections(
                        status?.defaultBindingTemplate ?? null,
                        resolved,
                        loadedById,
                        knownModels
                      )
                    );
                    setTeamMessage(null);
                    setTeamNotice(null);
                    setTeamError(null);
                    setEditingTeam(true);
                  }}
                >
                  <Bot size={16} /> 修改
                </button>
              </div>
            )}
            {bindingsComplete(resolved) ? null : (
              <p className="form-status">这个项目还没有绑定完整;绑定不齐时,新建任务会被拒绝。</p>
            )}
          </>
        ) : null}
      </Card>

      <details className="advanced-box">
        <summary>高级设置(Profile 凭据组 / 超时 / 并发)</summary>
        <p className="form-status">
          这些属性属于 AI 配置文件本身,在这里只读展示;修改请使用上方「接入配置(AI 供应商)」区的「编辑」功能(走既有的原子写回,保存后需重启桌面应用才生效)。
        </p>
        <AdvancedProfileRows profiles={profiles} />
      </details>

      <details className="advanced-box">
        <summary>开发者模式(诊断台 / DAG Inspector / 执行事件 / Context / Memory / 原始 API)</summary>
        <p className="form-status">
          这些是面向开发与诊断的工具,日常使用不需要打开。它们目前都在
          <a className="inline-link" href="/">旧工作台的「高级(观测台)」页</a>(任务 DAG 图、执行事件与日志、运行
          Context、Memory、原始 API 等入口都在那一页内切换;旧页按页签组织,没有单独的子页地址)。后续版本新界面接管
          首页后,诊断台计划整体移至 /debug——在它真实存在之前,这里只链接真实可达的页面。
        </p>
      </details>
    </div>
  );
}
