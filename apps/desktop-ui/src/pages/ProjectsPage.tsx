/**
 * M11-01 项目骨架(只读):list of registered projects from the read-only
 * GET /api/v1/projects surface (repoRoot + createdAt — NO internal ids in
 * the view, per the frozen 产品基准「内部 ID 默认隐藏」). Directory browsing
 * / registration is M11-03 scope; this page links there honestly.
 * M11-02 review handover A: the old-workbench link is a NATIVE <a href="/">
 * (a router Link would resolve under the /app basename and stay inside the
 * new UI instead of reaching the old page).
 */
import { useEffect, useState, type ReactNode } from "react";
import { Folder } from "lucide-react";
import { fetchProjects, type ProjectSummary } from "../api";
import { loadFailureText } from "../runErrors";
import { formatTimestamp } from "../runStatus";
import { Card, EmptyState, FormStatus, ListRow } from "../components/ui";

/**
 * The empty-state guide, exported for the basename pin test (M11-02 review
 * handover A): rendered under a basename="/app" router it must still carry
 * href="/" EXACTLY.
 */
export function ProjectsEmptyGuide(): ReactNode {
  return (
    <EmptyState>
      还没有项目记录。先在{" "}
      <a className="inline-link" href="/">
        旧工作台
      </a>{" "}
      登记项目目录并绑定角色;项目会在首次创建任务时自动登记。
    </EmptyState>
  );
}

export function ProjectsPage(): ReactNode {
  const [projects, setProjects] = useState<readonly ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchProjects()
      .then((rows) => {
        if (!cancelled) setProjects(rows);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(loadFailureText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="app-main-inner">
      <h1 className="page-title">项目</h1>
      <p className="page-subtitle">已登记的项目仓库(只读)。目录浏览与新建登记在 M11-03 到来。</p>
      {projects === null && error === null ? <p className="page-subtitle">正在读取…</p> : null}
      {error !== null ? <FormStatus kind="error">{error}</FormStatus> : null}
      {projects !== null && projects.length === 0 ? <ProjectsEmptyGuide /> : null}
      {projects !== null && projects.length > 0 ? (
        <Card>
          {projects.map((project) => (
            <ListRow key={project.repoRoot}>
              <Folder size={16} />
              <span className="list-row-main">{project.repoRoot}</span>
              <span className="list-row-meta">登记于 {formatTimestamp(project.createdAt)}</span>
            </ListRow>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
