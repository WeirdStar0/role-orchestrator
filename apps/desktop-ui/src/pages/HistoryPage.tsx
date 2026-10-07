/**
 * M11-01 任务历史骨架:the run list from the EXISTING GET /api/v1/runs,
 * newest first, each row a 人话状态 (执行中/已完成/失败/等待审批 — from the
 * frozen status+outcome fields, see runStatus.ts) + objective + created
 * time. Internal ids stay out of the default view (they live only in the
 * detail deep-link). Live timeline / 下钻 arrives with M11-03/M11-04.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { fetchRuns, type RunSummary } from "../api";
import { loadFailureText } from "../runErrors";
import { formatTimestamp } from "../runStatus";
import { Card, EmptyState, FormStatus, ListRow, StatusBadge } from "../components/ui";

export function HistoryPage(): ReactNode {
  const [runs, setRuns] = useState<readonly RunSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <p className="page-subtitle">最近的任务,按创建时间倒序。点一行看任务状态;完整时间线在 M11-03 到来。</p>
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
              <span className="list-row-main">{run.objective ?? "(无目标)"}</span>
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
