/**
 * M11-03 任务历史页:the run list from the EXISTING GET /api/v1/runs,
 * newest first (the server's own order), each row a 人话状态 (执行中/等待
 * 审批/已完成/失败/已取消 — from the frozen status+outcome fields, see
 * runStatus.ts) + objective + created time. Clicking a ROW opens the task
 * detail (the Agent timeline); the explicit 查看 link stays for keyboard
 * users. Internal ids stay out of the default view (they live only in the
 * detail's 开发者详情 block).
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { fetchRuns, type RunSummary } from "../api";
import { loadFailureText } from "../runErrors";
import { formatTimestamp } from "../runStatus";
import { Card, EmptyState, FormStatus, ListRow, StatusBadge } from "../components/ui";

export function HistoryPage(): ReactNode {
  const [runs, setRuns] = useState<readonly RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    fetchRuns()
      .then((rows) => {
        if (!cancelled) setRuns(rows);
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
      <h1 className="page-title">历史</h1>
      <p className="page-subtitle">最近的任务,按创建时间倒序。点一行进任务详情(Agent 时间线)。</p>
      {runs === null && error === null ? <p className="page-subtitle">正在读取…</p> : null}
      {error !== null ? <FormStatus kind="error">{error}</FormStatus> : null}
      {runs !== null && runs.length === 0 ? (
        <EmptyState>
          还没有任务。回<Link className="inline-link" to="/">新任务</Link>创建第一个。
        </EmptyState>
      ) : null}
      {runs !== null && runs.length > 0 ? (
        <Card>
          {runs.map((run) => (
            <ListRow key={run.id}>
              <span
                className="list-row-main"
                role="link"
                tabIndex={0}
                style={{ cursor: "pointer" }}
                onClick={() => navigate(`/runs/${encodeURIComponent(run.id)}`)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") navigate(`/runs/${encodeURIComponent(run.id)}`);
                }}
              >
                {run.objective ?? "(无目标)"}
              </span>
              <StatusBadge status={run.status} outcome={run.outcome} />
              <span className="list-row-meta">{formatTimestamp(run.createdAt)}</span>
              <Link className="inline-link" to={`/runs/${encodeURIComponent(run.id)}`}>
                查看
              </Link>
            </ListRow>
          ))}
        </Card>
      ) : null}
    </div>
  );
}
