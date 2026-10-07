/**
 * M11-03 任务详情页(/app/runs/:id)—— the Agent timeline is THE execution
 * view: the run's nodes rendered as 人话 role cards (协调/架构/开发/评审 —
 * the durable node rows carry no dispatch `kind`, it is the driving
 * process's bookkeeping and never enters the store, so a node's name is its
 * ROLE; stated honestly rather than smuggled), grouped into topological
 * waves so same-generation nodes (轮内并行) render on ONE row. Node states
 * are dag's frozen vocabulary through nodeHumanState (runStatus.ts) —
 * including an honest NO 「等待集成」 label (see there).
 *
 * Drill-down (per node, expandable): objective, attempt count + spans,
 * execution logs (GET /executions/:id/events — the redacted, server-paged
 * log), and 在改文件/Diff via the EXISTING candidate-diff endpoint: it
 * answers for integration records; a node without one yields candidateSha
 * null and the page says so honestly — agent-node file activity has NO
 * durable per-node record; the degradation sentence is the ask's own.
 *
 * Approvals: the decision buttons ARE wired (the ask's 二选一 landed on
 * 接入): POST /api/v1/approvals/:id/decision is the EXISTING guarded,
 * per-actionDigest surface the old page already drives — no batch, reject
 * requires a reason, decidedBy is the fixed honest "local-operator".
 *
 * Internal ids (runId/projectId/taskId/baseSha/node/execution/approval ids)
 * fold into the 开发者详情 block at the bottom — the default view renders
 * none of them.
 *
 * Data: GET /runs/:id + /runs/:id/graph + /runs/:id/approvals, polled every
 * 3s while the run is non-terminal; the objective comes from the runs list
 * (the entry-node objective — the same field the history page shows); the
 * project name resolves once through the projects list + per-project
 * bindings lookup (the same join the projects page uses).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronDown, CircleAlert, Clock, LoaderCircle, RefreshCw } from "lucide-react";
import {
  ApiError,
  decideApproval,
  fetchCsrfToken,
  fetchExecutionEvents,
  fetchProjects,
  fetchRoleBindings,
  fetchRunApprovals,
  fetchRunDetail,
  fetchRunDiff,
  fetchRunGraph,
  fetchRuns,
  type ApprovalItemView,
  type RunDetailView,
  type RunDiffView,
  type RunGraphView
} from "../api";
import { approvalDecisionFailureText, loadFailureText } from "../runErrors";
import { formatDuration, formatTimestamp, nodeHumanState } from "../runStatus";
import { eventLines, nodeAttemptSpans, timelineWaves } from "../timeline";
import { roleHumanLabel } from "../components/RoleBindingSection";
import { ApprovalCard } from "../components/ApprovalCard";
import { Card, FormStatus, StatusBadge } from "../components/ui";

const POLL_INTERVAL_MS = 3_000;

/** The run is terminal when the durable status says delivered/cancelled or
 * the outcome overlay has settled (success/failed/cancelled). */
function runIsTerminal(detail: RunDetailView): boolean {
  if (detail.outcome !== null) return true;
  return detail.status === "DELIVERED" || detail.status === "CANCELLED";
}

/** Resolve the project's operator-facing name (repoRoot) from the existing
 * surfaces: projects list + per-project bindings lookup until the ids match
 * (the small-N join the projects page uses). */
async function resolveProjectName(projectId: string): Promise<string | null> {
  if (projectId === "") return null;
  const projects = await fetchProjects();
  for (const project of projects) {
    try {
      const view = await fetchRoleBindings(project.repoRoot);
      if (view.projectId === projectId) return project.repoRoot;
    } catch {
      // A refused/unreadable lookup must not take the header down.
    }
  }
  return null;
}

interface EventGroup {
  readonly executionId: string;
  readonly attempt: number;
  readonly events: ReturnType<typeof eventLines>;
  readonly failed: boolean;
}

/** One node's drill-down body (logs + diff), fetched once on mount. */
function NodeDrillDown(props: {
  readonly runId: string;
  readonly nodeId: string;
  readonly executions: readonly {
    readonly id: string;
    readonly attempt: number;
    readonly phase: string;
    readonly createdAt: string;
    readonly updatedAt: string;
  }[];
}): ReactNode {
  const [logs, setLogs] = useState<readonly EventGroup[] | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsLoading, setLogsLoading] = useState(false);
  const [diff, setDiff] = useState<RunDiffView | null>(null);
  const [diffError, setDiffError] = useState<string | null>(null);

  const loadLogs = (): void => {
    setLogsLoading(true);
    setLogsError(null);
    Promise.all(
      props.executions.map(async (execution) => {
        try {
          const events = await fetchExecutionEvents(execution.id);
          return { executionId: execution.id, attempt: execution.attempt, events: eventLines(events), failed: false };
        } catch {
          // One refused attempt's log renders as failed; the others still load.
          return { executionId: execution.id, attempt: execution.attempt, events: eventLines([]), failed: true };
        }
      })
    )
      .then((groups) => setLogs(groups))
      .catch((cause: unknown) => setLogsError(loadFailureText(cause)))
      .finally(() => setLogsLoading(false));
  };

  useEffect(() => {
    loadLogs();
    let cancelled = false;
    fetchRunDiff(props.runId, props.nodeId)
      .then((view) => {
        if (!cancelled) setDiff(view);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDiffError(loadFailureText(cause));
      });
    return () => {
      cancelled = true;
    };
    // Mount-only by design: the drill-down data is a snapshot the operator
    // refreshes with the explicit 刷新 button (the page poll above owns the
    // live node states).
  }, []);

  const multiAttempt = props.executions.length > 1;
  return (
    <div className="node-drill">
      <p className="node-drill-head">尝试次数:{String(props.executions.length)} 次</p>
      {multiAttempt ? (
        <ul className="node-attempts">
          {[...props.executions]
            .sort((a, b) => a.attempt - b.attempt)
            .map((execution) => {
              const duration = formatDuration(execution.createdAt, execution.updatedAt);
              return (
                <li key={execution.id}>
                  第 {String(execution.attempt)} 次 · {execution.phase}
                  {duration !== null ? ` · 耗时 ${duration}` : ""}
                </li>
              );
            })}
        </ul>
      ) : null}

      <p className="node-drill-head">在改文件 / Diff</p>
      {diffError !== null ? <FormStatus kind="error">{diffError}</FormStatus> : null}
      {diff !== null && diff.candidateSha !== null && diff.files !== null ? (
        <div>
          <p className="form-status">该节点的集成候选相对基线改动了 {String(diff.files.length)} 个文件:</p>
          <ul className="diff-files">
            {diff.files.map((file) => (
              <li key={file.path}>
                <code>{file.path}</code> ({file.status}
                {file.additions !== null || file.deletions !== null
                  ? ` +${String(file.additions ?? 0)}/-${String(file.deletions ?? 0)}`
                  : ""}
                {file.binary ? " · 二进制" : ""})
              </li>
            ))}
          </ul>
          {diff.filesTruncated ? <p className="form-status">文件清单被截断(改动文件过多,仅显示前一批)。</p> : null}
          {diff.conflictFiles !== null && diff.conflictFiles.length > 0 ? (
            <p className="form-status form-status-error">存在冲突文件:{diff.conflictFiles.join("、")}</p>
          ) : null}
        </div>
      ) : diffError === null ? (
        <p className="form-status">
          该信息当前未持久化:普通执行节点的工作区文件活动没有按节点留痕,任务级的集成候选
          Diff 只在有集成产出的节点上可得。运行中可看下方执行日志;「在改文件/Diff」的节点级呈现将在 M11-04 评估。
        </p>
      ) : null}

      <p className="node-drill-head">
        执行日志
        <button type="button" className="btn" style={{ marginLeft: 8 }} onClick={loadLogs}>
          <RefreshCw size={14} /> 刷新
        </button>
      </p>
      {logsLoading ? (
        <p className="form-status">
          <LoaderCircle size={14} className="spin" /> 正在读取日志…
        </p>
      ) : null}
      {logsError !== null ? <FormStatus kind="error">{logsError}</FormStatus> : null}
      {logs !== null && logs.length === 0 ? <p className="form-status">该节点还没有执行尝试,因此没有日志。</p> : null}
      {(logs ?? []).map((group) => (
        <div key={group.executionId} className="log-group">
          {multiAttempt ? (
            <p className="form-status">
              第 {String(group.attempt)} 次尝试的日志{group.failed ? "(读取失败)" : ""}:
            </p>
          ) : null}
          {group.events.length === 0 ? (
            <p className="form-status">(该尝试暂无可显示的事件)</p>
          ) : (
            <ul className="event-log">
              {group.events.map((event) => (
                <li key={event.eventId}>
                  <span className="event-time">{formatTimestamp(event.occurredAt)}</span>{" "}
                  <code className="event-type">{event.type}</code>
                  {event.text !== null ? <span className="event-text">{event.text}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

export function RunDetailPage(): ReactNode {
  const params = useParams<{ runId: string }>();
  const runId = params.runId ?? "";
  const [detail, setDetail] = useState<RunDetailView | null>(null);
  const [graph, setGraph] = useState<RunGraphView | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalItemView[] | null>(null);
  const [objective, setObjective] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionDone, setDecisionDone] = useState<string | null>(null);
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const objectiveFetched = useRef(false);
  const projectNameFetched = useRef(false);

  useEffect(() => {
    if (runId === "") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = (): void => {
      Promise.all([fetchRunDetail(runId), fetchRunGraph(runId), fetchRunApprovals(runId)])
        .then(([nextDetail, nextGraph, nextApprovals]) => {
          if (cancelled) return;
          setDetail(nextDetail);
          setGraph(nextGraph);
          setApprovals(nextApprovals.approvals);
          setError(null);
          if (!runIsTerminal(nextDetail)) {
            timer = setTimeout(poll, POLL_INTERVAL_MS);
          }
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          setError(loadFailureText(cause));
        });
    };
    poll();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [runId]);

  // The objective (the runs list's entry-node objective — the same field the
  // history row shows) resolves ONCE per page.
  useEffect(() => {
    if (runId === "" || objectiveFetched.current) return;
    objectiveFetched.current = true;
    let cancelled = false;
    fetchRuns()
      .then((runs) => {
        if (cancelled) return;
        const run = runs.find((candidate) => candidate.id === runId);
        if (run !== undefined) setObjective(run.objective);
      })
      .catch(() => {
        // The header falls back to the graph's own first objective below.
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  // The project name resolves ONCE (it does not change while the page runs);
  // the guard keeps the 3s poll from re-walking the project list.
  useEffect(() => {
    if (detail === null || projectNameFetched.current) return;
    projectNameFetched.current = true;
    let cancelled = false;
    resolveProjectName(detail.projectId)
      .then((name) => {
        if (!cancelled) setProjectName(name);
      })
      .catch(() => {
        // The header renders the honest 未知 state; nothing else depends on it.
      });
    return () => {
      cancelled = true;
    };
  }, [detail]);

  const decide = (approval: ApprovalItemView, decision: "approve" | "reject", reason: string): void => {
    if (decisionBusy !== null) return;
    setDecisionBusy(approval.approvalId);
    setDecisionError(null);
    setDecisionDone(null);
    fetchCsrfToken()
      .then((csrf) => {
        if (csrf === null) {
          throw new ApiError(403, "NOT_AUTHENTICATED", "无法取得会话凭据(CSRF)。");
        }
        return decideApproval(csrf, approval.approvalId, {
          decision,
          ...(decision === "reject" ? { reason } : {})
        });
      })
      .then((result) => {
        setDecisionDone(
          result.decision === "approve"
            ? "已批准(绑定该条动作;由任务的检查点续行消费)。"
            : "已拒绝(原因已记录)。"
        );
        return fetchRunApprovals(runId).then((view) => setApprovals(view.approvals));
      })
      .catch((cause: unknown) => setDecisionError(approvalDecisionFailureText(cause)))
      .finally(() => setDecisionBusy(null));
  };

  if (runId === "") {
    return (
      <div className="app-main-inner">
        <FormStatus kind="error">缺少任务标识。</FormStatus>
      </div>
    );
  }

  const waves = graph !== null ? timelineWaves(graph.nodes) : [];
  const nodeById = new Map((graph?.nodes ?? []).map((node) => [node.nodeId, node]));
  const headerObjective = objective ?? (graph !== null && graph.nodes.length > 0 ? graph.nodes[0]!.objective : null);

  return (
    <div className="app-main-inner">
      <p>
        <Link className="inline-link" to="/history">
          ← 返回历史
        </Link>
      </p>
      {error !== null ? <FormStatus kind="error">{error}</FormStatus> : null}
      {detail === null && error === null ? <p className="page-subtitle">正在读取任务…</p> : null}
      {detail !== null ? (
        <>
          <Card>
            <p className="run-objective">{headerObjective ?? "(无目标)"}</p>
            <p style={{ margin: "10px 0 0 0", display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <StatusBadge status={detail.status} outcome={detail.outcome} />
              <span className="list-row-meta">
                项目:{projectName ?? (projectName === null ? "读取中…" : "未知(项目记录不可用)")}
              </span>
              <span className="list-row-meta">创建于 {formatTimestamp(detail.createdAt)}</span>
              {!runIsTerminal(detail) ? (
                <span className="list-row-meta">
                  <Clock size={14} /> 每 3 秒自动刷新
                </span>
              ) : null}
            </p>
          </Card>

          {approvals !== null && approvals.length > 0 ? (
            <Card>
              <h2 className="section-title">
                <CircleAlert size={18} /> 审批
              </h2>
              {decisionDone !== null ? <FormStatus kind="success">{decisionDone}</FormStatus> : null}
              {decisionError !== null ? <FormStatus kind="error">{decisionError}</FormStatus> : null}
              {approvals.map((approval) => (
                <ApprovalCard
                  key={approval.approvalId}
                  approval={approval}
                  busy={decisionBusy === approval.approvalId}
                  errorText={null}
                  onDecide={(decision, reason) => decide(approval, decision, reason)}
                />
              ))}
            </Card>
          ) : null}

          <Card>
            <h2 className="section-title">Agent 时间线</h2>
            {graph === null ? <p className="form-status">正在读取任务结构…</p> : null}
            {graph !== null &&
              waves.map((wave) => (
                <div key={wave.index} className="timeline-wave">
                  <p className="wave-label">
                    第 {String(wave.index)} 波
                    {wave.nodeIds.length > 1 ? `(${String(wave.nodeIds.length)} 个角色并行)` : ""}
                  </p>
                  <div className="wave-row">
                    {wave.nodeIds.map((nodeId) => {
                      const node = nodeById.get(nodeId);
                      if (node === undefined) return null;
                      const human = nodeHumanState(node.state);
                      const executions = detail.executions.filter((execution) => execution.nodeId === nodeId);
                      const lastDuration =
                        nodeAttemptSpans(executions)
                          .find((entry) => entry.nodeId === nodeId)
                          ?.attempts.filter((attempt) => attempt.duration !== null)
                          .slice(-1)[0]?.duration ?? null;
                      const running = node.state === "RUNNING";
                      const waiting = node.state === "WAITING_APPROVAL";
                      return (
                        <div
                          key={nodeId}
                          className={`timeline-node timeline-node-${human.tone}${waiting ? " timeline-node-waiting" : ""}`}
                        >
                          <p className="timeline-node-head">
                            {running ? <LoaderCircle size={14} className="spin" /> : null}
                            {roleHumanLabel(node.role)}
                            <span className={`status-badge status-${human.tone}`}>{human.label}</span>
                            {lastDuration !== null ? <span className="list-row-meta">耗时 {lastDuration}</span> : null}
                          </p>
                          {node.objective !== "" ? <p className="timeline-node-objective">{node.objective}</p> : null}
                          {expandedNode === nodeId ? (
                            <NodeDrillDown runId={runId} nodeId={nodeId} executions={executions} />
                          ) : null}
                          <button
                            type="button"
                            className="btn"
                            onClick={() => setExpandedNode(expandedNode === nodeId ? null : nodeId)}
                          >
                            <ChevronDown size={14} /> {expandedNode === nodeId ? "收起详情" : "查看详情/日志"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
          </Card>

          <details className="advanced-box">
            <summary>开发者详情(内部标识)</summary>
            <ul className="dev-details">
              <li>任务 ID:{detail.id}</li>
              <li>项目 ID:{detail.projectId}</li>
              <li>关联任务记录:{detail.taskId}</li>
              <li>基线 SHA:{detail.baseSha}</li>
              <li>图修订号:{String(detail.graphRevision)}</li>
              {(graph?.nodes ?? []).map((node) => (
                <li key={`node-${node.nodeId}`}>
                  节点 {node.nodeId}(角色 {node.role},状态 {node.state})
                </li>
              ))}
              {detail.executions.map((execution) => (
                <li key={execution.id}>
                  执行 {execution.id}(节点 {execution.nodeId},第 {String(execution.attempt)} 次,{execution.phase})
                </li>
              ))}
              {(approvals ?? []).map((approval) => (
                <li key={approval.approvalId}>
                  审批 {approval.approvalId}({approval.status})
                </li>
              ))}
            </ul>
          </details>
        </>
      ) : null}
    </div>
  );
}
