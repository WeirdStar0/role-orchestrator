/**
 * M11-01 项目骨架(只读):list of registered projects from the read-only
 * GET /api/v1/projects surface (repoRoot + createdAt — NO internal ids in
 * the view, per the frozen 产品基准「内部 ID 默认隐藏」). Directory browsing
 * / registration is M11-03 scope; this page links there honestly.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Folder } from "lucide-react";
import { fetchProjects, type ProjectSummary } from "../api";
import { loadFailureText } from "../runErrors";
import { formatTimestamp } from "../runStatus";
import { Card, EmptyState, FormStatus, ListRow } from "../components/ui";

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
      {projects !== null && projects.length === 0 ? (
        <EmptyState>
          还没有项目记录。先在{" "}
          <Link className="inline-link" to="/">
            旧工作台
          </Link>{" "}
          登记项目目录并绑定角色;项目会在首次创建任务时自动登记。
        </EmptyState>
      ) : null}
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
