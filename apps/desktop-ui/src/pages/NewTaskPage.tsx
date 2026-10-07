/**
 * M11-01 首页(新任务):「今天想完成什么?」+ 目标输入 + 项目下拉(既有
 * 项目;空则引导)+ 开始执行 —— POST /api/v1/runs 的最小路径(选项目+目标;
 * 工作目录等约束由服务端 fail-closed 校验,类型化拒绝在这里翻译成人话)。
 * 成功后跳转任务占位详情页(/app/runs/:runId)。
 */
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Play, LoaderCircle } from "lucide-react";
import { createRun, fetchCsrfToken, fetchProjects, ApiError, type ProjectSummary } from "../api";
import { createRunFailureText } from "../runErrors";
import { Card, EmptyState, FormStatus } from "../components/ui";

type CreateState =
  | { readonly phase: "editing" }
  | { readonly phase: "submitting" }
  | { readonly phase: "error"; readonly message: string };

export function NewTaskPage(): ReactNode {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [objective, setObjective] = useState("");
  const [projectDir, setProjectDir] = useState("");
  const [state, setState] = useState<CreateState>({ phase: "editing" });

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
    setState({ phase: "submitting" });
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return createRun(csrf, { objective: objective.trim(), projectDir });
      })
      .then((runId) => {
        navigate(`/runs/${encodeURIComponent(runId)}`);
      })
      .catch((error: unknown) => {
        setState({ phase: "error", message: createRunFailureText(error) });
      });
  };

  const loadingProjects = projects === null && loadError === null;

  return (
    <div className="app-main-inner">
      <h1 className="page-title-hero">今天想完成什么?</h1>
      {projects !== null && projects.length === 0 && loadError === null ? (
        <EmptyState>
          还没有项目。先在 <a className="inline-link" href="/">旧工作台的「配置」页</a>{" "}
          登记一个项目目录并完成四个角色绑定,项目就会出现在这里(新 UI 的项目
          目录浏览与引导登记在 M11-03 到来)。
        </EmptyState>
      ) : (
        <Card>
          <label className="field-label" htmlFor="new-task-objective">
            任务目标(一句话说清要完成什么)
          </label>
          <textarea
            id="new-task-objective"
            className="textarea"
            value={objective}
            maxLength={10000}
            onChange={(event) => setObjective(event.target.value)}
            placeholder="例如:把登录页的错误提示改成更友好的文案,并补上对应测试"
          />
          <label className="field-label" htmlFor="new-task-project">
            项目(任务在哪个仓库里执行)
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
            {(projects ?? []).map((project) => (
              <option key={project.repoRoot} value={project.repoRoot}>
                {project.repoRoot}
              </option>
            ))}
          </select>
          <div style={{ marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submit}
              disabled={state.phase === "submitting"}
            >
              {state.phase === "submitting" ? <LoaderCircle size={16} className="spin" /> : <Play size={16} />}
              开始执行
            </button>
          </div>
          {state.phase === "error" ? <FormStatus kind="error">{state.message}</FormStatus> : null}
        </Card>
      )}
      {loadError !== null ? <FormStatus kind="error">{loadError}</FormStatus> : null}
      <p className="form-status">
        工作目录存在性、git 仓库与角色绑定完整性都由服务端校验;被拒时这里会原样给出原因。
      </p>
    </div>
  );
}
