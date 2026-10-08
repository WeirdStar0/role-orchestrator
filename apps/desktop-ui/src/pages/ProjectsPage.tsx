/**
 * M11-03 项目页: the registered-project cards (目录名 / 绑定状态 / 最近任务
 * 数) plus the 『登记项目』 flow — a directory path input whose validation IS
 * the server's fail-closed registration (POST /api/v1/projects: the same
 * four gates run creation applies; every 400 is translated to its dedicated
 * 人话句). A successful registration guides to the four-role binding (the
 * wizard's embedded step is the binding surface — one surface, no
 * duplication).
 *
 * Data composition, zero server change: the cards join FOUR existing
 * read-only surfaces — GET /api/v1/projects (repoRoot+createdAt, id-free),
 * GET /api/v1/projects/role-bindings?projectDir= (per-project binding state
 * AND the projectId handle), GET /api/v1/runs (projectId → per-project task
 * count), and GET /api/v1/profiles (the loaded ids — M11-04 review handover
 * ⑥: 绑而未载入 must not present as healthy 绑定完整; M11-05 review
 * handover: a REFUSED profiles list is UNKNOWN — bound cards read 状态未知
 * (拉取失败), never a fabricated 未载入). N+1 by design: the
 * local product's project count is small and
 * each lookup is a cheap read; a batch endpoint would be new surface for
 * no measured need.
 *
 * Directory browsing was CONSIDERED and declined for this batch (the ask's
 * 二选一): a read-only GET /api/v1/fs/list would add a credentialed
 * file-system enumeration surface for a single-operator local product whose
 * path input is a paste from the file manager; 纯路径输入+校验按钮 keeps the
 * new-surface footprint at the registration write alone and leans on the
 * server's fail-closed gates for the truth. Revisit on maintainer feedback.
 *
 * M11-02 review handover A stays pinned: the old-workbench link is a NATIVE
 * <a href="/"> (basename defect).
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Folder, LoaderCircle } from "lucide-react";
import {
  ApiError,
  fetchCsrfToken,
  fetchProfiles,
  fetchProjects,
  fetchRoleBindings,
  fetchRuns,
  registerProject,
  type ProfileSummary,
  type ProjectSummary,
  type RunSummary
} from "../api";
import { loadFailureText, registerFailureText } from "../runErrors";
import { formatTimestamp } from "../runStatus";
import { Card, EmptyState, FormStatus } from "../components/ui";

/** The directory name of a repo root (Windows/POSIX both; the verbatim path
 * is shown as well, so nothing is guessed away). */
export function dirNameFromPath(repoRoot: string): string {
  const trimmed = repoRoot.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  const last = segments[segments.length - 1];
  return last === undefined || last === "" ? repoRoot : last;
}

/** Binding face of one card, derived from the lookup's raw rows + the loaded
 * profile ids: a role is bound iff it has a row with a non-null profileId
 * (missing rows and the zero-rows face of a fresh registration read
 * identically — the same rule run creation's completeness check applies).
 * M11-04 (review handover ⑥): "bound" and "bound AND usable" are distinct —
 * a project whose four roles point at profiles the service has NOT loaded is
 * its own face (bound-not-loaded), never presented as plain 绑定完整.
 * M11-05 (review handover, honest degradation): `loadedProfileIds === null`
 * means the PROFILES LIST ITSELF could not be fetched — a state this page
 * cannot see through, so a fully-bound project reads profiles-unknown
 * (状态未知(拉取失败)) instead of the fabricated claim that its AI
 * configurations are unloaded. An INCOMPLETE binding set stays incomplete:
 * that face never depended on the profiles list. */
export function bindingFace(
  view: { readonly bindings: readonly { readonly profileId: string | null }[] } | null,
  loadedProfileIds: ReadonlySet<string> | null
): {
  readonly kind: "checking" | "complete" | "bound-not-loaded" | "incomplete" | "unavailable" | "profiles-unknown";
  readonly missingCount: number;
  readonly notLoadedCount: number;
} {
  if (view === null) return { kind: "checking", missingCount: 0, notLoadedCount: 0 };
  const boundRows = view.bindings.filter((entry) => entry.profileId !== null);
  const notLoadedCount =
    loadedProfileIds === null
      ? 0
      : boundRows.filter((entry) => entry.profileId !== null && !loadedProfileIds.has(entry.profileId)).length;
  if (boundRows.length === 4) {
    if (loadedProfileIds === null) {
      return { kind: "profiles-unknown", missingCount: 0, notLoadedCount: 0 };
    }
    return notLoadedCount > 0
      ? { kind: "bound-not-loaded", missingCount: 0, notLoadedCount }
      : { kind: "complete", missingCount: 0, notLoadedCount: 0 };
  }
  return { kind: "incomplete", missingCount: 4 - boundRows.length, notLoadedCount };
}

function taskCountFor(runs: readonly RunSummary[], projectId: string): number {
  return runs.filter((run) => run.projectId === projectId).length;
}

type CardUpdater = (current: readonly ProjectCardState[] | null) => readonly ProjectCardState[] | null;

/** Attach one project's binding face + task count (module-level: the only
 * component-scope values it needs are the stable setState and the loaded
 * profile ids — or null when the profiles list itself is unreadable:
 * UNKNOWN, never dressed up as an empty set). */
function attachProjectState(
  project: ProjectSummary,
  runs: readonly RunSummary[],
  loadedProfileIds: ReadonlySet<string> | null,
  setCards: (updater: CardUpdater) => void
): void {
  fetchRoleBindings(project.repoRoot)
    .then((view) => {
      setCards((current) =>
        (current ?? []).map((entry) =>
          entry.project.repoRoot !== project.repoRoot
            ? entry
            : {
                ...entry,
                binding: bindingFace(view, loadedProfileIds),
                taskCount: taskCountFor(runs, view.projectId)
              }
        )
      );
    })
    .catch(() => {
      setCards((current) =>
        (current ?? []).map((entry) =>
          entry.project.repoRoot !== project.repoRoot
            ? entry
            : { ...entry, binding: { kind: "unavailable", missingCount: 0, notLoadedCount: 0 }, taskCount: null }
        )
      );
    });
}

interface ProjectCardState {
  readonly project: ProjectSummary;
  readonly binding: ReturnType<typeof bindingFace>;
  /** Per-project task count; null until the binding lookup yields the
   * project's id handle. */
  readonly taskCount: number | null;
}

type RegisterPhase =
  | { readonly phase: "idle" }
  | { readonly phase: "working" }
  | { readonly phase: "done"; readonly existing: boolean; readonly dirName: string }
  | { readonly phase: "error"; readonly message: string };

/**
 * The registration form. The absolute-path hint mirrors the old page's shape
 * hint — a keystroke-level courtesy, never a filesystem pre-check.
 */
export function RegisterProjectForm(props: {
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  readonly phase: RegisterPhase;
  readonly onSubmit: () => void;
}): ReactNode {
  const trimmed = props.value.trim();
  const looksAbsolute = /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/") || trimmed.startsWith("\\\\");
  return (
    <Card>
      <label className="field-label" htmlFor="register-project-dir">
        项目目录(要登记的 git 仓库的绝对路径)
      </label>
      <input
        id="register-project-dir"
        className="input"
        type="text"
        value={props.value}
        placeholder="例如 C:\\repos\\my-project"
        onChange={(event) => props.onValueChange(event.target.value)}
      />
      {trimmed !== "" && !looksAbsolute ? (
        <p className="form-status">提示:这看起来不是绝对路径(Windows 盘符或 / 开头);提交后服务端会以同样原因拒绝。</p>
      ) : null}
      <div style={{ marginTop: 12 }}>
        <button type="button" className="btn btn-primary" onClick={props.onSubmit} disabled={props.phase.phase === "working"}>
          {props.phase.phase === "working" ? <LoaderCircle size={16} className="spin" /> : <Folder size={16} />}
          校验并登记
        </button>
      </div>
      <p className="form-status">
        服务端会依次校验:路径是绝对路径 → 目录存在 → 是目录 → 是 git
        仓库;任何一步不通过都会原样告知原因,且不会写入任何内容。已登记过的目录重复登记是安全的(不会产生第二条记录)。
      </p>
      {props.phase.phase === "done" ? (
        <FormStatus kind="success">
          {props.phase.existing ? "这个目录此前已登记过,无需重复操作。" : `已登记「${props.phase.dirName}」。`}
          {" "}下一步:完成四个角色(协调/架构/开发/评审)的绑定——去
          <Link className="inline-link" to="/">新任务</Link>
          选择这个项目,页面会引导你完成绑定。
        </FormStatus>
      ) : null}
      {props.phase.phase === "error" ? <FormStatus kind="error">{props.phase.message}</FormStatus> : null}
    </Card>
  );
}

export function ProjectsPage(): ReactNode {
  const [cards, setCards] = useState<readonly ProjectCardState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirValue, setDirValue] = useState("");
  const [register, setRegister] = useState<RegisterPhase>({ phase: "idle" });

  useEffect(() => {
    let cancelled = false;
    // The loaded-profile ids ride along (M11-04 review handover ⑥): 绑而未载入
    // must not read as 绑定完整. A REFUSED profiles list is its own truth —
    // null (UNKNOWN) — and a fully-bound card then reads 状态未知(拉取失败)
    // (M11-05 review handover), never the fabricated "not loaded" claim the
    // old empty-set degradation produced.
    Promise.all([
      fetchProjects(),
      fetchRuns(),
      fetchProfiles().then(
        (rows) => rows as readonly ProfileSummary[] | null,
        () => null
      )
    ])
      .then(([projects, runs, profiles]) => {
        if (cancelled) return;
        const loadedProfileIds = profiles === null ? null : new Set(profiles.map((profile) => profile.id));
        setCards(
          projects.map((project) => ({
            project,
            binding: { kind: "checking", missingCount: 0, notLoadedCount: 0 },
            taskCount: null
          }))
        );
        for (const project of projects) {
          if (cancelled) return;
          attachProjectState(project, runs, loadedProfileIds, setCards);
        }
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(loadFailureText(cause));
        setCards([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const submitRegistration = (): void => {
    if (register.phase === "working") return;
    if (dirValue.trim() === "") {
      setRegister({ phase: "error", message: "请先填写项目目录的绝对路径。" });
      return;
    }
    setRegister({ phase: "working" });
    const requested = dirValue.trim();
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return registerProject(csrf, requested);
      })
      .then(async (result) => {
        setRegister({ phase: "done", existing: result.existing, dirName: dirNameFromPath(result.repoRoot) });
        setDirValue("");
        // Refresh the cards; the (re-)registered project joins like the rest.
        // Same UNKNOWN discipline as the mount load: a refused profiles list
        // is null, not an empty set.
        const [projects, runs, profiles] = await Promise.all([
          fetchProjects(),
          fetchRuns(),
          fetchProfiles().then(
            (rows) => rows as readonly ProfileSummary[] | null,
            () => null
          )
        ]);
        const loadedProfileIds = profiles === null ? null : new Set(profiles.map((profile) => profile.id));
        setCards(
          projects.map((project) => ({
            project,
            binding: { kind: "checking", missingCount: 0, notLoadedCount: 0 },
            taskCount: null
          }))
        );
        for (const project of projects) {
          attachProjectState(project, runs, loadedProfileIds, setCards);
        }
      })
      .catch((cause: unknown) => {
        setRegister({ phase: "error", message: registerFailureText(cause) });
      });
  };

  return (
    <div className="app-main-inner">
      <h1 className="page-title">项目</h1>
      <p className="page-subtitle">
        已登记的项目仓库。任务在项目选择的目录上执行;每个项目完成四个角色的绑定后才能执行任务。
      </p>
      {cards === null && error === null ? <p className="page-subtitle">正在读取…</p> : null}
      {error !== null ? <FormStatus kind="error">{error}</FormStatus> : null}
      {cards !== null && cards.length === 0 ? (
        <EmptyState>
          还没有项目。在下方登记一个 git 仓库目录,或回
          <Link className="inline-link" to="/">新任务</Link>
          页面的项目登记入口登记。
        </EmptyState>
      ) : null}
      {cards !== null && cards.length > 0 ? (
        <div className="project-cards">
          {cards.map((card) => (
            <div key={card.project.repoRoot} className="project-card">
              <p className="project-card-name">{dirNameFromPath(card.project.repoRoot)}</p>
              <p className="project-card-path">{card.project.repoRoot}</p>
              <p className="project-card-meta">
                {card.binding.kind === "checking"
                  ? "正在读取绑定状态…"
                  : card.binding.kind === "unavailable"
                    ? "绑定状态不可用(服务未响应)"
                    : card.binding.kind === "complete"
                      ? "四个角色已绑定"
                      : card.binding.kind === "bound-not-loaded"
                        ? `四个角色已绑定,但其中 ${String(card.binding.notLoadedCount)} 个角色的 AI 配置当前未载入(重启桌面应用后可用)`
                        : card.binding.kind === "profiles-unknown"
                          ? "四个角色已绑定;AI 配置状态未知(拉取失败,无法确认配置是否已载入)"
                          : `绑定不完整(还差 ${String(card.binding.missingCount)} 个角色)`}
              </p>
              <p className="project-card-meta">
                最近任务:{card.taskCount === null ? "…" : String(card.taskCount)} 个 · 登记于{" "}
                {formatTimestamp(card.project.createdAt)}
              </p>
            </div>
          ))}
        </div>
      ) : null}

      <h2 className="page-title" style={{ fontSize: "1.2rem", marginTop: 28 }}>
        登记项目
      </h2>
      <RegisterProjectForm
        value={dirValue}
        onValueChange={setDirValue}
        phase={register}
        onSubmit={submitRegistration}
      />

      <p className="form-status" style={{ marginTop: 20 }}>
        需要查看任务记录?去
        <Link className="inline-link" to="/history">历史</Link>
        页;旧版整表工作台仍在
        <a className="inline-link" href="/">旧工作台</a>。
      </p>
    </div>
  );
}
