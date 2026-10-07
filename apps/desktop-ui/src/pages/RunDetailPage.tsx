/**
 * M11-01 任务占位详情页(the ask: 成功跳转任务占位详情页):fetches the
 * EXISTING run detail endpoint and renders the human status + objective —
 * a placeholder, honestly labeled: the execution timeline / node drill-down
 * is M11-03/M11-04 scope. Internal ids are NOT rendered in the view body.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchRuns } from "../api";
import { loadFailureText } from "../runErrors";
import { formatTimestamp } from "../runStatus";
import { Card, FormStatus, StatusBadge } from "../components/ui";

export function RunDetailPage(): ReactNode {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";
  const [objective, setObjective] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchRuns()
      .then((runs) => {
        if (cancelled) return;
        const run = runs.find((candidate) => candidate.id === runId);
        if (run === undefined) {
          setError("找不到这个任务(可能尚未出现在列表中)。");
          return;
        }
        setObjective(run.objective);
        setStatus(run.status);
        setOutcome(run.outcome);
        setCreatedAt(run.createdAt);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(loadFailureText(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  return (
    <div className="app-main-inner">
      <h1 className="page-title">任务</h1>
      <p className="page-subtitle">任务占位页:完整时间线与节点下钻在 M11-03/M11-04 到来。</p>
      {error !== null ? <FormStatus kind="error">{error}</FormStatus> : null}
      {error === null && status === null ? <p className="page-subtitle">正在读取…</p> : null}
      {status !== null ? (
        <Card>
          <p style={{ margin: "0 0 10px 0", fontWeight: 500 }}>{objective ?? "(无目标)"}</p>
          <p style={{ margin: 0, display: "flex", gap: 12, alignItems: "center" }}>
            <StatusBadge status={status} outcome={outcome} />
            <span className="list-row-meta">创建于 {formatTimestamp(createdAt)}</span>
          </p>
        </Card>
      ) : null}
      <p>
        <Link className="inline-link" to="/history">
          ← 返回历史
        </Link>
      </p>
    </div>
  );
}
