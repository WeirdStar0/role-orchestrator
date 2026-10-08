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
 *   修改 editor whose save goes through the EXISTING transactional
 *   PUT /api/v1/projects/:id/role-bindings (all four land or none do). With
 *   no project selected the recommended DEFAULT template (setup status's
 *   defaultBindingTemplate) renders read-only — a suggestion, never written
 *   from here (bindings are per project).
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
 * 保存动作全部经既有原语: the ONLY write this page performs is the
 * transactional role-bindings PUT. Effect timing is stated EXACTLY: a saved
 * binding applies to the project's NEW tasks immediately (the server reads
 * bindings per task creation); the profiles FILE side (models, credential
 * groups, concurrency caps — whatever the JSON editor changed) needs a
 * DESKTOP APP RESTART to reach the running service — never hot-reloaded
 * (serveProfilesFullPut's own note), so every profiles-related sentence here
 * says 重启桌面应用后生效.
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
import { Bot, Cpu, LoaderCircle, Save, Users } from "lucide-react";
import {
  ApiError,
  fetchCsrfToken,
  fetchProfiles,
  fetchProjects,
  fetchRoleBindings,
  fetchSetupStatus,
  putRoleBindings,
  type ProfileSummary,
  type ProjectSummary,
  type RoleBindingsView,
  type SetupRoleId,
  type SetupStatus
} from "../api";
import { bindingFailureText } from "../runErrors";
import {
  RoleBindingCards,
  RoleBindingEditor,
  bindingsComplete,
  defaultSelections,
  resolveRoleBindings,
  roleHumanLabel,
  runtimeName
} from "../components/RoleBindingSection";
import { dirNameFromPath } from "./ProjectsPage";
import { createOneShotGate, type OneShotGate } from "../oneShotGate";
import { Card, FormStatus } from "../components/ui";

const ROLE_IDS: readonly SetupRoleId[] = ["coordinator", "architect", "developer", "reviewer"];

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

export function SettingsPage(): ReactNode {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  /** null = the profiles list itself could not be read (UNKNOWN — never
   * presented as an empty list). */
  const [profiles, setProfiles] = useState<readonly ProfileSummary[] | null>(null);
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [selectedDir, setSelectedDir] = useState("");
  const [bindings, setBindings] = useState<RoleBindingsView | null>(null);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [editingTeam, setEditingTeam] = useState(false);
  const [selections, setSelections] = useState<Readonly<Record<SetupRoleId, string>>>({
    coordinator: "",
    architect: "",
    developer: "",
    reviewer: ""
  });
  const [savingTeam, setSavingTeam] = useState(false);
  const [teamMessage, setTeamMessage] = useState<string | null>(null);
  const [teamError, setTeamError] = useState<string | null>(null);
  // The synchronous double-fire gate (the M11-03 handover-C pattern): a
  // rapid double-click on 保存 must not walk the PUT twice.
  const saveGate = useRef<OneShotGate | null>(null);
  if (saveGate.current === null) {
    saveGate.current = createOneShotGate();
  }

  useEffect(() => {
    let cancelled = false;
    // The detection status, the loaded profiles and the project list are
    // independent reads; a refused profiles list lands as null (UNKNOWN) and
    // must not take the page down.
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
  // 保存 is enabled only when all four roles carry a selection (the same
  // rule the wizard's save applies; the server re-validates everything).
  const selectionsReady = Object.values(selections).every((value) => value !== "");

  const saveTeam = (): void => {
    // Handover-C gate: the claim is synchronous — a double-click's second
    // press is refused before any state update can re-render.
    if (saveGate.current === null || !saveGate.current.take()) return;
    if (bindings === null || !editingTeam || savingTeam) {
      saveGate.current?.release();
      return;
    }
    if (!ROLE_IDS.every((roleId) => selections[roleId] !== "")) {
      setTeamError("请为四个角色各选择一个 AI 配置。");
      saveGate.current?.release();
      return;
    }
    setSavingTeam(true);
    setTeamError(null);
    setTeamMessage(null);
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return putRoleBindings(csrf, bindings.projectId,
          ROLE_IDS.map((roleId) => ({ roleId, profileId: selections[roleId]! }))
        );
      })
      .then(() => fetchRoleBindings(selectedDir))
      .then((view) => {
        setBindings(view);
        setEditingTeam(false);
        // Effect timing, stated exactly: bindings apply to NEW tasks at
        // once; the profiles FILE side is what needs the restart.
        setTeamMessage("已保存四个角色的分工(一次保存,全部生效或全部不生效),对该项目的新建任务立即生效。");
      })
      .catch((cause: unknown) => {
        setTeamError(bindingFailureText(cause));
      })
      .finally(() => {
        setSavingTeam(false);
        saveGate.current?.release();
      });
  };

  const selectValue = (roleId: SetupRoleId, value: string): void => {
    setSelections((current) => ({ ...current, [roleId]: value }));
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
          模型显示为「CLI 默认」表示该配置没有指定模型,由命令行工具自行选择——这里不会猜测具体型号。需要修改模型或增删
          AI 配置时,请到
          <a className="inline-link" href="/">旧工作台的「配置」页</a>
          编辑配置文件(保存后需重启桌面应用才能生效),或回
          <Link className="inline-link" to="/setup">初始设置</Link>
          重新生成推荐配置。
        </p>
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
            {teamError !== null ? <FormStatus kind="error">{teamError}</FormStatus> : null}
            {editingTeam ? (
              <>
                <p className="form-status">为每个角色选择一个已载入的 AI 配置;保存是一次事务,四个角色同时生效或同时不变。</p>
                {profiles === null ? (
                  <FormStatus kind="error">AI 配置状态未知(拉取失败),暂时无法修改绑定。请重试后再改。</FormStatus>
                ) : (
                  <RoleBindingEditor profiles={profiles} selections={selections} onChange={selectValue} />
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
                    setSelections(defaultSelections(status?.defaultBindingTemplate ?? null, profiles ?? []));
                    setTeamMessage(null);
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
          这些属性属于 AI 配置文件本身,在这里只读展示;修改请到
          <a className="inline-link" href="/">旧工作台的「配置」页</a>
          编辑配置文件 JSON(那里走既有的原子写回,保存后需重启桌面应用才生效)。
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
