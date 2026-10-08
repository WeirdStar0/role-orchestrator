/**
 * M11-01 首页(新任务)→ M11-03 新任务向导:「今天想完成什么?」+ 四步:
 * ① 选项目(下拉 + 内嵌登记入口)→ ② 角色绑定状态检查(GET role-bindings;
 * 未绑定 → 内嵌绑定步骤:四角色映射选择,预填 setup/status 的推荐模板,
 * 提交事务式 PUT role-bindings,成功展示四角色卡片)→ ③ 目标输入 →
 * ④ 『开始执行』(POST /runs 单节点起步;多节点 workflow 表单收在『高级』
 * 折叠项:节点列表编辑 kind/dependencies,≤64 节点/单 integration 的人话
 * 预检 —— 服务端仍是权威)。成功跳任务详情。
 *
 * M11-02 首启引导:the page still probes GET /api/v1/setup/status once on
 * load and mounts the guide card ABOVE the hero when the profiles config is
 * not in use yet (refused probe → zero noise).
 *
 * M11-02 review handover C (the double-fire fix): the generate button's
 * guard is a SYNCHRONOUS one-shot gate (oneShotGate.ts) — React state
 * updates are async, so a phase-only check let a rapid double-click fire
 * the POST twice; the gate is claimed before any render cycle can run.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { CircleAlert, LoaderCircle, Play, Plus, Trash2 } from "lucide-react";
import {
  ApiError,
  applyFirstRun,
  createRun,
  fetchCsrfToken,
  fetchProfiles,
  fetchProfilesFull,
  fetchProjects,
  fetchRoleBindings,
  fetchSetupStatus,
  registerProject,
  type ProfileFullEntry,
  type ProfileSummary,
  type ProjectSummary,
  type RoleBindingsView,
  type SetupRoleId
} from "../api";
import {
  bindingFailureText,
  createRunFailureText,
  firstRunFailureText,
  notFoundMissNames,
  profilesFullFailureText,
  registerFailureText
} from "../runErrors";
import { Card, FormStatus } from "../components/ui";
import { SetupGuideCard, type SetupGuideState } from "../components/SetupGuideCard";
import { RoleBindingCards, RoleComboEditor, bindingsComplete, prefillFillableCount, resolveRoleBindings } from "../components/RoleBindingSection";
import {
  EMPTY_MODEL_SELECTIONS,
  initialModelSelections,
  knownModelsOf,
  loadedAsComboSource,
  type ModelSelection
} from "../profileUpsert";
import { saveAgentTeamSelections } from "../teamSave";
import {
  freshDraftNodeId,
  kindLabel,
  roleLabel,
  validateWorkflowDraft,
  workflowToRequest,
  WORKFLOW_NODE_BUDGET,
  type WorkflowDraftNode,
  type WorkflowDraftKind,
  type WorkflowDraftRole
} from "../workflowDraft";
import { setupGuideStateFromStatus } from "./SetupPage";
import { dirNameFromPath } from "./ProjectsPage";
import { createOneShotGate, type OneShotGate } from "../oneShotGate";

type CreateState =
  | { readonly phase: "editing" }
  | { readonly phase: "submitting" }
  | { readonly phase: "error"; readonly message: string };

type BindingState =
  | { readonly phase: "idle" } // no project selected
  | { readonly phase: "loading" }
  | { readonly phase: "unavailable"; readonly message: string }
  | { readonly phase: "view"; readonly view: RoleBindingsView };

type RegisterPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "working" }
  | { readonly phase: "done"; readonly existing: boolean; readonly dirName: string }
  | { readonly phase: "error"; readonly message: string };

const ROLE_IDS: readonly SetupRoleId[] = ["coordinator", "architect", "developer", "reviewer"];

/** The wizard's 『登记项目』 mini-form (the dropdown's 登记入口). */
function InlineRegisterForm(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly phase: RegisterPhase;
  readonly onSubmit: () => void;
}): ReactNode {
  return (
    <div className="advanced-box" style={{ marginTop: 10 }}>
      <label className="field-label" htmlFor="wizard-register-dir">
        登记新项目:git 仓库目录的绝对路径
      </label>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <input
          id="wizard-register-dir"
          className="input"
          type="text"
          style={{ flex: "1 1 280px" }}
          value={props.value}
          placeholder="例如 C:\\repos\\my-project"
          onChange={(event) => props.onValueChange(event.target.value)}
        />
        <button type="button" className="btn" onClick={props.onSubmit} disabled={props.phase.phase === "working"}>
          {props.phase.phase === "working" ? <LoaderCircle size={16} className="spin" /> : <Plus size={16} />}
          校验并登记
        </button>
      </div>
      {props.phase.phase === "done" ? (
        <FormStatus kind="success">
          {props.phase.existing ? "这个目录此前已登记过,已选中。" : `已登记「${props.phase.dirName}」并选中。`}
          {" "}继续完成下方角色绑定即可开始第一个任务。
        </FormStatus>
      ) : null}
      {props.phase.phase === "error" ? <FormStatus kind="error">{props.phase.message}</FormStatus> : null}
    </div>
  );
}

export function NewTaskPage(): ReactNode {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [state, setState] = useState<CreateState>({ phase: "editing" });
  /** null = probe in flight or honestly absent (refused probe → no card,
   * never noise). Non-null = the guide card is due. */
  const [setup, setSetup] = useState<SetupGuideState | null>(null);
  /** The recommended role→runtime template from the same probe (undefined =
   * probe not settled; null = no template to suggest). */
  const [bindingTemplate, setBindingTemplate] = useState<
    readonly { readonly roleId: SetupRoleId; readonly runtime: string }[] | null | undefined
  >(undefined);
  /** M11-06: the per-runtime CLI detection result of the same probe (null =
   * probe not settled — the editor then lists both CLIs behind a note). */
  const [detected, setDetected] = useState<Readonly<Record<"claude" | "codex", boolean>> | null>(null);
  /** The loaded profiles the binding prefill resolves against. */
  const [profiles, setProfiles] = useState<readonly ProfileSummary[] | null>(null);
  /** M11-06: the profiles FILE's current full set — the diff base of the
   * (CLI, model) upsert save. null = unavailable (unwired/absent/unparseable). */
  const [fileFull, setFileFull] = useState<readonly ProfileFullEntry[] | null>(null);
  const [fileFullError, setFileFullError] = useState<string | null>(null);
  /** The selected project's binding face (keyed to projectDir). */
  const [bindings, setBindings] = useState<BindingState>({ phase: "idle" });
  /** The editor's (CLI × model) selections ("" runtime = not chosen). */
  const [modelSelections, setModelSelections] =
    useState<Readonly<Record<SetupRoleId, ModelSelection>>>(EMPTY_MODEL_SELECTIONS);
  const [savingBindings, setSavingBindings] = useState(false);
  const [bindingError, setBindingError] = useState<string | null>(null);
  /** The M11-06 outcome sentences of the last save (pending-restart etc.). */
  const [bindingNotice, setBindingNotice] = useState<string | null>(null);
  const [bindingSuccess, setBindingSuccess] = useState<string | null>(null);
  /** The 『登记项目』 inline mini-form. */
  const [registerDir, setRegisterDir] = useState("");
  const [registerPhase, setRegisterPhase] = useState<RegisterPhase>({ phase: "idle" });
  /** The multi-node draft (advanced face; empty = single-node run). */
  const [workflowNodes, setWorkflowNodes] = useState<readonly WorkflowDraftNode[]>([]);
  /** The advanced box is a CONTROLLED details element: the submit path opens
   * it when the draft has problems, and the operator's manual toggle is the
   * state's source of truth afterwards. */
  const [advancedOpen, setAdvancedOpen] = useState(false);
  /** M11-02 review handover C: the synchronous double-fire gate. */
  const generateGate = useRef<OneShotGate | null>(null);
  if (generateGate.current === null) {
    generateGate.current = createOneShotGate();
  }

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((rows) => {
        if (cancelled) return;
        setProjects(rows);
        if (rows.length > 0) setProjectDir(rows[0]!.repoRoot);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(error instanceof ApiError ? error.message : String(error));
        setProjects([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchSetupStatus()
      .then((status) => {
        if (cancelled) return;
        setSetup(setupGuideStateFromStatus(status));
        setBindingTemplate(status.defaultBindingTemplate);
        setDetected({ claude: status.claudeFound, codex: status.codexFound });
      })
      .catch(() => {
        // Refused (plain browser) or unreadable: no guide card, zero noise;
        // the binding prefill simply has no template to suggest, and the
        // editor lists both CLIs behind its honest note.
        if (cancelled) return;
        setSetup(null);
        setBindingTemplate(undefined);
        setDetected(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchProfiles()
      .then((rows) => {
        if (cancelled) return;
        setProfiles(rows);
      })
      .catch(() => {
        if (cancelled) return;
        setProfiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // M11-06: the profiles FILE's full set — the upsert's diff base. A refusal
  // (unwired/absent) or an unparseable file lands as honest guidance; the
  // editor cannot save against a guess.
  useEffect(() => {
    let cancelled = false;
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
        if (cancelled) return;
        setFileFull(null);
        setFileFullError(null); // the empty-loaded arm below already guides
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // The template-driven prefill tops up ONLY the still-unselected roles: the
  // template maps roles to RUNTIMES with the CLI 默认 model on top (the M11-06
  // ask: "defaults 之上可选模型"), and a choice the operator already made is
  // never overwritten.
  useEffect(() => {
    if (bindingTemplate === undefined || bindingTemplate === null) return;
    setModelSelections((current) => {
      const next = { ...current };
      let changed = false;
      for (const entry of bindingTemplate) {
        if (next[entry.roleId]?.runtime !== "") continue;
        const runtime = entry.runtime === "claude" || entry.runtime === "codex" ? entry.runtime : "";
        if (runtime !== "") {
          next[entry.roleId] = { runtime, model: "", custom: false };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [bindingTemplate, profiles]);

  // The binding face follows the selected directory.
  useEffect(() => {
    if (projectDir === "") {
      setBindings({ phase: "idle" });
      return;
    }
    let cancelled = false;
    setBindings({ phase: "loading" });
    setBindingError(null);
    setBindingNotice(null);
    setBindingSuccess(null);
    fetchRoleBindings(projectDir)
      .then((view) => {
        if (cancelled) return;
        setBindings({ phase: "view", view });
        // M11-06 prefill: bound+loaded roles reflect their CURRENT combo;
        // the rest take the template's runtime with CLI 默认 on top.
        const loadedById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
        setModelSelections(
          initialModelSelections(
            bindingTemplate ?? null,
            resolveRoleBindings(view, profiles ?? []),
            loadedById,
            knownModels
          )
        );
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setBindings({
          phase: "unavailable",
          message:
            cause instanceof ApiError && cause.status === 404
              ? "这个目录还没有项目记录——请先在下方登记该目录。"
              : bindingFailureText(cause)
        });
      });
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  const resolvedBindings =
    bindings.phase === "view" ? resolveRoleBindings(bindings.view, profiles ?? []) : null;
  const bindingsOk = resolvedBindings !== null && bindingsComplete(resolvedBindings);
  // M11-04 (review handover ⑤/⑥, honest labels): the prefill sentence claims
  // only what the template + loaded profiles actually support, and a role
  // bound to a NOT-loaded profile is its own state — distinct from plain
  // 未绑定完整.
  const prefillCount = prefillFillableCount(bindingTemplate, profiles ?? []);
  const notLoadedCount =
    resolvedBindings?.filter((entry) => entry.profileId !== null && entry.notLoaded).length ?? 0;
  /** M11-06: models already in use (file set first, loaded list fills gaps)
   * — the editor renders them as pickable options above 自定义, and the
   * prefill uses the same set to decide the explicit custom marker. */
  const knownModels = knownModelsOf([...(fileFull ?? []), ...(profiles ?? [])]);
  const draftProblems = validateWorkflowDraft(workflowNodes);
  const workflowActive = workflowNodes.length > 0;

  const generateDefaults = (): void => {
    // Handover C: the gate claim is SYNCHRONOUS — a rapid double-click is
    // refused before any state update (and therefore any re-render) happens.
    if (generateGate.current === null || !generateGate.current.take()) return;
    if (setup === null || setup.phase !== "ready") {
      generateGate.current.release();
      return;
    }
    setState({ phase: "editing" });
    setSetup({ phase: "working", claudeFound: setup.claudeFound, codexFound: setup.codexFound });
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return applyFirstRun(csrf);
      })
      .then((result) => {
        setSetup({ phase: "done", mode: result.mode, profileCount: result.profileCount });
      })
      .catch((error: unknown) => {
        // Handover B: the miss list is translated at the extraction site, so
        // it reads exactly like the main refusal message (product names).
        setSetup({ phase: "error", message: firstRunFailureText(error), misses: notFoundMissNames(error) });
      })
      .finally(() => {
        generateGate.current?.release();
      });
  };

  const submitRegistration = (): void => {
    if (registerPhase.phase === "working") return;
    if (registerDir.trim() === "") {
      setRegisterPhase({ phase: "error", message: "请先填写项目目录的绝对路径。" });
      return;
    }
    setRegisterPhase({ phase: "working" });
    const requested = registerDir.trim();
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return registerProject(csrf, requested);
      })
      .then((result) => {
        setRegisterPhase({ phase: "done", existing: result.existing, dirName: dirNameFromPath(result.repoRoot) });
        setRegisterDir("");
        // Refresh the dropdown and SELECT the new project (its binding face
        // loads through the projectDir effect).
        return fetchProjects().then((rows) => {
          setProjects(rows);
          setProjectDir(result.repoRoot);
        });
      })
      .catch((cause: unknown) => {
        setRegisterPhase({ phase: "error", message: registerFailureText(cause) });
      });
  };

  const saveBindings = (): void => {
    if (bindings.phase !== "view" || savingBindings) return;
    if (profiles === null) {
      setBindingError("AI 配置状态未知(拉取失败),暂时无法修改绑定。");
      return;
    }
    const selectionsReady = ROLE_IDS.every((roleId) => modelSelections[roleId]!.runtime !== "");
    if (!selectionsReady) {
      setBindingError("请为四个角色各选择一个命令行(CLI);模型可以保持「CLI 默认」。");
      return;
    }
    setSavingBindings(true);
    setBindingError(null);
    setBindingNotice(null);
    setBindingSuccess(null);
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return saveAgentTeamSelections({
          csrfToken: csrf,
          projectId: bindings.view.projectId,
          selections: modelSelections,
          currentBindings: bindings.view.bindings.map((entry) => ({
            roleId: entry.roleId,
            profileId: entry.profileId
          })),
          // Same discipline as the settings page: the FILE's set when it is
          // readable; otherwise the loaded set as combo source with minting
          // refused (bind-only against existing combos).
          fileProfiles: fileFull ?? loadedAsComboSource(profiles),
          loadedProfileIds: profiles.map((profile) => profile.id),
          mintable: fileFull !== null
        });
      })
      .then(async (outcome) => {
        if (outcome.kind === "refused") {
          setBindingError(outcome.message);
          return;
        }
        if (outcome.kind === "no-change") {
          setBindingSuccess("当前选择与既有配置和绑定一致,没有需要保存的修改。");
          return;
        }
        if (outcome.kind === "bind-pending") {
          setBindingNotice(
            (outcome.addedCount > 0
              ? `已把 ${String(outcome.addedCount)} 个新 AI 配置写入配置文件。`
              : "所需的 AI 配置已在配置文件中。") +
              "运行中的服务还没有载入它——请重启桌面应用;重启后回到这里再点一次「保存绑定」,绑定即会切换。完成之前,这个项目还不能开始任务。本次没有改动该项目的绑定。"
          );
          return;
        }
        const view = await fetchRoleBindings(projectDir);
        setBindings({ phase: "view", view });
        const loadedById = new Map((profiles ?? []).map((profile) => [profile.id, profile]));
        setModelSelections(
          initialModelSelections(
            bindingTemplate ?? null,
            resolveRoleBindings(view, profiles ?? []),
            loadedById,
            knownModels
          )
        );
        setBindingSuccess(
          "四个角色已绑定(一次保存,全部生效或全部不生效),对该项目的新建任务立即生效。" +
            (outcome.fileChanged ? "AI 配置文件已同步更新(其载入需重启桌面应用)。" : "")
        );
      })
      .catch((cause: unknown) => {
        setBindingError(
          cause instanceof ApiError && (cause.status === 409 || cause.status === 422) && cause.code !== "UNKNOWN_PROFILE" && cause.code !== "PROFILE_DEFINITION_CONFLICT"
            ? profilesFullFailureText(cause)
            : bindingFailureText(cause)
        );
      })
      .finally(() => {
        setSavingBindings(false);
      });
  };

  const submit = (): void => {
    if (state.phase === "submitting") return;
    if (objective.trim() === "") {
      setState({ phase: "error", message: "请先写下一句话目标。" });
      return;
    }
    if (projectDir === "") {
      setState({ phase: "error", message: "请选择一个项目。" });
      return;
    }
    if (workflowActive && draftProblems.length > 0) {
      setAdvancedOpen(true);
      setState({ phase: "error", message: draftProblems[0]! });
      return;
    }
    if (bindings.phase === "view" && !bindingsOk) {
      setState({ phase: "error", message: "这个项目的四个角色还没有绑定完整——请先在上方完成角色绑定。" });
      return;
    }
    setState({ phase: "submitting" });
    const workflow = workflowToRequest(workflowNodes);
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return createRun(csrf, {
          objective: objective.trim(),
          projectDir,
          ...(workflow !== null ? { workflow } : {})
        });
      })
      .then((runId) => {
        navigate(`/runs/${encodeURIComponent(runId)}`);
      })
      .catch((error: unknown) => {
        setState({ phase: "error", message: createRunFailureText(error) });
      });
  };

  const loadingProjects = projects === null && loadError === null;
  const canSubmit =
    state.phase !== "submitting" &&
    objective.trim() !== "" &&
    projectDir !== "" &&
    (bindings.phase === "view" ? bindingsOk : false);

  return (
    <div className="app-main-inner">
      {setup !== null ? <SetupGuideCard state={setup} onGenerate={generateDefaults} /> : null}
      <h1 className="page-title-hero">今天想完成什么?</h1>

      <Card>
        <label className="field-label" htmlFor="new-task-project">
          ① 项目(任务在哪个仓库里执行)
        </label>
        <select
          id="new-task-project"
          className="select"
          value={projectDir}
          disabled={loadingProjects || loadError !== null}
          onChange={(event) => setProjectDir(event.target.value)}
        >
          {loadingProjects ? <option value="">正在读取项目…</option> : null}
          {loadError !== null ? <option value="">(项目列表不可用)</option> : null}
          {projects !== null && projects.length === 0 ? <option value="">(还没有项目——在下方登记)</option> : null}
          {(projects ?? []).map((project) => (
            <option key={project.repoRoot} value={project.repoRoot}>
              {dirNameFromPath(project.repoRoot)}({project.repoRoot})
            </option>
          ))}
        </select>

        <InlineRegisterForm
          value={registerDir}
          onValueChange={setRegisterDir}
          phase={registerPhase}
          onSubmit={submitRegistration}
        />

        <label className="field-label" htmlFor="new-task-bindings">
          ② 角色绑定(四个角色各由一个 AI 配置承担;一次保存,全部生效或全部不生效)
        </label>
        <div id="new-task-bindings">
          {bindings.phase === "idle" ? <p className="form-status">先选择一个项目。</p> : null}
          {bindings.phase === "loading" ? <p className="form-status">正在读取角色绑定…</p> : null}
          {bindings.phase === "unavailable" ? (
            <FormStatus kind="error">{bindings.message}</FormStatus>
          ) : null}
          {resolvedBindings !== null && bindingsOk ? (
            <>
              <FormStatus kind="success">四个角色已绑定,这个项目可以执行任务了。</FormStatus>
              <RoleBindingCards resolved={resolvedBindings} />
            </>
          ) : null}
          {resolvedBindings !== null && !bindingsOk ? (
            <>
              {profiles === null ? (
                <FormStatus kind="error">
                  AI 配置状态未知(拉取失败),暂时无法修改绑定。请重试后再改。
                </FormStatus>
              ) : (
                <>
                  {/* M11-04 (review handover ⑥): 绑而未载入 is its own state,
                  distinct from 未绑定完整 — the roles ARE bound, but the bound
                  AI configuration is not currently loaded (renamed/removed
                  profile, or the profiles file is not wired into this
                  process). */}
                  {notLoadedCount > 0 ? (
                    <FormStatus kind="error">
                      {`有 ${String(notLoadedCount)} 个角色已绑定,但其 AI 配置当前未载入(该配置可能已被改名、移除,或服务尚未载入配置文件)。请为这些角色重新选择,或重启桌面应用后再试。`}
                    </FormStatus>
                  ) : null}
                  {profiles.length === 0 ? (
                    <FormStatus kind="error">
                      本服务当前没有已载入的 AI 配置(可能刚生成还未重启)——请先完成初始设置并重启桌面应用,再回到这里保存绑定。
                    </FormStatus>
                  ) : null}
                  {fileFull === null ? (
                    <FormStatus kind="info">
                      {fileFullError ?? "AI 配置文件不可读:这里只能选择已载入的命令行与模型组合,不能新增 AI 配置。"}
                    </FormStatus>
                  ) : null}
                  {/* M11-04 (review handover ⑤): the prefill claim follows
                  the template's ACTUAL reach — full prefill, partial prefill
                  (named count), or none. */}
                  <p className="form-status">
                    {prefillCount >= ROLE_IDS.length
                      ? "这个项目还没有绑定完整。推荐分工已预填(命令行已选,模型默认由 CLI 自选,可改);改好后点「保存绑定」。"
                      : prefillCount > 0
                        ? `这个项目还没有绑定完整。已按推荐分工预填 ${String(prefillCount)} 个角色的命令行,其余请手动选择;改好后点「保存绑定」。`
                        : "这个项目还没有绑定完整。当前没有可预填的推荐分工,请为四个角色各选择一个命令行;改好后点「保存绑定」。"}
                  </p>
                  <RoleComboEditor
                    selections={modelSelections}
                    onChange={(roleId, selection) =>
                      setModelSelections((current) => ({ ...current, [roleId]: selection }))
                    }
                    detected={detected}
                    knownModels={knownModels}
                  />
                  <div style={{ marginTop: 12 }}>
                    <button type="button" className="btn btn-primary" onClick={saveBindings} disabled={savingBindings}>
                      {savingBindings ? <LoaderCircle size={16} className="spin" /> : null}
                      保存绑定
                    </button>
                  </div>
                </>
              )}
              {bindingSuccess !== null ? <FormStatus kind="success">{bindingSuccess}</FormStatus> : null}
              {bindingNotice !== null ? <FormStatus kind="info">{bindingNotice}</FormStatus> : null}
              {bindingError !== null ? <FormStatus kind="error">{bindingError}</FormStatus> : null}
            </>
          ) : null}
        </div>

        <label className="field-label" htmlFor="new-task-objective">
          ③ 任务目标(一句话说清要完成什么)
        </label>
        <textarea
          id="new-task-objective"
          className="textarea"
          value={objective}
          maxLength={10000}
          onChange={(event) => setObjective(event.target.value)}
          placeholder="例如:把登录页的错误提示改成更友好的文案,并补上对应测试"
        />

        <details
          className="advanced-box"
          open={advancedOpen}
          onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)}
        >
          <summary>高级:多节点工作流(可选——默认单节点执行)</summary>
          <p className="form-status">
            声明了多节点时,上面的任务目标作为整个任务的记录,每个节点有自己的目标与依赖。当前版本每个任务至多一个
            集成节点;评审节点必须且只能依赖一个节点。
          </p>
          {workflowNodes.map((node, index) => (
            <div key={node.id} className="workflow-node">
              <div className="workflow-node-head">
                <span className="field-label">节点 {String(index + 1)}</span>
                <select
                  aria-label="节点类型"
                  className="select"
                  style={{ flex: "0 0 auto" }}
                  value={node.kind}
                  onChange={(event) =>
                    setWorkflowNodes((current) =>
                      current.map((entry) =>
                        entry.id === node.id ? { ...entry, kind: event.target.value as WorkflowDraftKind } : entry
                      )
                    )
                  }
                >
                  <option value="agent">{kindLabel("agent")}</option>
                  <option value="integration">{kindLabel("integration")}</option>
                  <option value="review">{kindLabel("review")}</option>
                </select>
                <select
                  aria-label="节点角色"
                  className="select"
                  style={{ flex: "0 0 auto" }}
                  value={node.role}
                  onChange={(event) =>
                    setWorkflowNodes((current) =>
                      current.map((entry) =>
                        entry.id === node.id ? { ...entry, role: event.target.value as WorkflowDraftRole } : entry
                      )
                    )
                  }
                >
                  {ROLE_IDS.map((roleId) => (
                    <option key={roleId} value={roleId}>
                      {roleLabel(roleId)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  aria-label={`删除节点 ${String(index + 1)}`}
                  onClick={() => setWorkflowNodes((current) => current.filter((entry) => entry.id !== node.id))}
                >
                  <Trash2 size={16} />
                </button>
              </div>
              <textarea
                className="textarea"
                style={{ minHeight: 56 }}
                maxLength={10000}
                aria-label="节点目标"
                placeholder="这个节点要完成什么"
                value={node.objective}
                onChange={(event) =>
                  setWorkflowNodes((current) =>
                    current.map((entry) => (entry.id === node.id ? { ...entry, objective: event.target.value } : entry))
                  )
                }
              />
              {workflowNodes.length > 1 ? (
                <div className="workflow-deps">
                  <span className="field-label" style={{ margin: 0 }}>
                    依赖(等待这些节点完成后才开始):
                  </span>
                  {workflowNodes
                    .map((other, otherIndex) => ({ other, otherIndex }))
                    .filter(({ other }) => other.id !== node.id)
                    .map(({ other, otherIndex }) => (
                      <label key={other.id}>
                        <input
                          type="checkbox"
                          checked={node.dependencies.includes(other.id)}
                          onChange={(event) =>
                            setWorkflowNodes((current) =>
                              current.map((entry) =>
                                entry.id === node.id
                                  ? {
                                      ...entry,
                                      dependencies: event.target.checked
                                        ? [...entry.dependencies, other.id]
                                        : entry.dependencies.filter((dependency) => dependency !== other.id)
                                    }
                                  : entry
                              )
                            )
                          }
                        />
                        {`节点 ${String(otherIndex + 1)}`}
                      </label>
                    ))}
                </div>
              ) : null}
            </div>
          ))}
          <div style={{ marginTop: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              className="btn"
              disabled={workflowNodes.length >= WORKFLOW_NODE_BUDGET}
              onClick={() =>
                setWorkflowNodes((current) => [
                  ...current,
                  {
                    id: freshDraftNodeId(),
                    role: "developer",
                    kind: "agent",
                    objective: "",
                    dependencies: []
                  }
                ])
              }
            >
              <Plus size={16} /> 添加节点
            </button>
            <span className="form-status">
              {String(workflowNodes.length)}/{String(WORKFLOW_NODE_BUDGET)} 个节点;不添加任何节点即为单节点任务。
            </span>
          </div>
          {draftProblems.length > 0 ? (
            <div role="status">
              {draftProblems.map((problem) => (
                <FormStatus key={problem} kind="error">
                  <CircleAlert size={14} /> {problem}
                </FormStatus>
              ))}
            </div>
          ) : null}
        </details>

        <div style={{ marginTop: 16 }}>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canSubmit}>
            {state.phase === "submitting" ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
            开始执行
          </button>
          {!canSubmit && bindings.phase === "view" && !bindingsOk ? (
            <span className="form-status" style={{ marginLeft: 10 }}>
              完成②的角色绑定后即可开始。
            </span>
          ) : null}
        </div>
        {state.phase === "error" ? <FormStatus kind="error">{state.message}</FormStatus> : null}
      </Card>

      {loadError !== null ? <FormStatus kind="error">{loadError}</FormStatus> : null}
      <p className="form-status">
        工作目录存在性、git 仓库与角色绑定完整性都由服务端校验;被拒时这里会原样给出原因。
      </p>
    </div>
  );
}
