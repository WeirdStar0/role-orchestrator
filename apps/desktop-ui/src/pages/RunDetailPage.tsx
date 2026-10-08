/**
 * M11-03 任务详情页(/app/runs/:id)→ M11-04 执行可视化升级 —— the Agent
 * timeline is THE execution view: the run's nodes rendered as 人话 role
 * cards (协调/架构/开发/评审 — the durable node rows carry no dispatch
 * `kind`, it is the driving process's bookkeeping and never enters the
 * store, so a node's name is its ROLE; stated honestly rather than
 * smuggled), grouped into topological waves so same-generation nodes
 * (轮内并行) render on ONE row. Node states are dag's frozen vocabulary
 * through nodeHumanState (runStatus.ts) — including an honest NO 「等待集成」
 * label (see there).
 *
 * M11-04 additions (the batch's acceptance face):
 * - 节点图 secondary view: a 时间线/节点图 toggle; the graph face renders
 *   each node with its DECLARED dependencies (ordinal labels 节点 N — the
 *   same numbering the wizard uses; node ids stay in 开发者详情).
 * - 返工轮次: the EXISTING M5-02 expansion view (GET /runs/:id/expansions)
 *   is the fourth polled face; executed rounds render as 第 N 轮返工 steps
 *   (评审未通过 → 修复 → 复审, with live node states and the round's
 *   findings count), fix/re-review nodes carry a 轮次 tag, and an unresolved
 *   hold (A20 third-round cap) states the run is paused for the operator.
 *   All round data is REAL (the durable review_expansions rows) — nothing
 *   is derived from node-id spellings.
 * - Reviewer 下钻: a reviewer-role node's drill-down fetches the NEW
 *   read-only /runs/:id/review-records view — the A12 verdict records
 *   (通过/未通过 + findings list, oldest first) with the honest sentence
 *   that problem SEVERITY is not persisted (plain strings only, nothing
 *   invented); the node's own rework status comes from the expansions face.
 * - Diff: the unified -U3 text the diff endpoint ALREADY serves renders
 *   through the page's own lightweight painter (diffLines.ts classify +
 *   per-line coloring, plain React text nodes, no HTML assembly, no
 *   highlight dependency); server text cap and the painter's line cap are
 *   both announced, never silent.
 * - 审批暂停: a WAITING_APPROVAL node carries the 等待你的决定 guidance
 *   (scrolls to the approvals card) whenever an actionable approval exists
 *   — and the poll KEEPS RUNNING through `blocked` (runStatus.runIsTerminal,
 *   task-1 fix), so the page unfreezes as soon as a decision lands.
 *
 * Drill-down (per node, expandable): objective, attempt count + spans,
 * execution logs (GET /executions/:id/events — the redacted, server-paged
 * log), and 在改文件/Diff via the EXISTING candidate-diff endpoint: it
 * answers for integration records; a node without one yields candidateSha
 * null and the page says so honestly — agent-node file activity has NO
 * durable per-node record.
 *
 * Approvals: the decision buttons ARE wired (the M11-03 二选一 landed on
 * 接入): POST /api/v1/approvals/:id/decision is the EXISTING guarded,
 * per-actionDigest surface the old page already drives — no batch, reject
 * requires a reason, decidedBy is the fixed honest "local-operator".
 *
 * Internal ids (runId/projectId/taskId/baseSha/node/execution/approval ids)
 * fold into the 开发者详情 block at the bottom — the default view renders
 * none of them.
 *
 * Data: GET /runs/:id + /runs/:id/graph + /runs/:id/approvals +
 * /runs/:id/expansions, polled every 3s while the run is non-terminal —
 * where runIsTerminal (runStatus.ts, M11-03 review handover ⑧) counts the
 * recoverable `blocked` outcome as NON-terminal: approvals pending keep the
 * poll alive, because the run resumes after the decisions land (the driver
 * resets blocked→NULL). A decision POST refreshes ALL FOUR faces
 * immediately (not just the approvals list — the resumed run moves
 * nodes/executions/rounds too), and the header carries an explicit 手动刷新
 * button for the drill-down snapshots and every other moment the operator
 * wants fresh data.
 *
 * 执行日志实时性 = M11-04 任务 3 的二选一, landed on (a): the 3s poll
 * KEEPS driving the node states with the honest PollRefreshBadge label
 * (components/RunVisualization.tsx — the only place the口径 is claimed),
 * while the LOG panel stays an on-demand snapshot and says so (不自动续拉
 * caption). The one-time-ticket WS alternative was declined — a new
 * credentialed ticket endpoint plus a WS-auth change on the path ADR 010
 * documents as fail-closed, a frozen-surface ADR supplement with its own
 * mitigation/replay edges, for a live-tail benefit a single-operator local
 * product has not asked for; the WS live stream remains on the old
 * console's developer-grade path (ws-events.ts). Full reason in the batch
 * report.
 *
 * The objective comes from the runs list (the entry-node
 * objective — the same field the history page shows); the project name
 * resolves once through the projects list + per-project bindings lookup (the
 * same join the projects page uses).
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { ChevronDown, CircleAlert, Clock, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import {
  ApiError,
  decideApproval,
  EXECUTION_EVENT_PAGE_SIZE,
  fetchCsrfToken,
  fetchExecutionEvents,
  fetchProjects,
  fetchReviewRecords,
  fetchRoleBindings,
  fetchRunApprovals,
  fetchRunDetail,
  fetchRunDiff,
  fetchRunExpansions,
  fetchRunGraph,
  fetchRuns,
  type ApprovalItemView,
  type RunDetailView,
  type RunDiffView,
  type RunExpansionsView,
  type RunGraphView,
  type RunReviewRecordsView
} from "../api";
import { approvalDecisionFailureText, loadFailureText } from "../runErrors";
import { formatDuration, formatTimestamp, nodeHumanState, runIsTerminal } from "../runStatus";
import { eventLines, nodeAttemptSpans, timelineWaves } from "../timeline";
import { roleHumanLabel } from "../components/RoleBindingSection";
import { ApprovalCard } from "../components/ApprovalCard";
import { NodeGraphView, PollRefreshBadge, ReworkRounds, nodeGraphLabels } from "../components/RunVisualization";
import { UnifiedDiff } from "../components/UnifiedDiff";
import { Card, FormStatus, StatusBadge } from "../components/ui";

const POLL_INTERVAL_MS = 3_000;

/** One round of the four read-only faces the page lives on (the poll, the
 * manual 刷新 button and the post-decision refresh all walk the same round,
 * so every entry point leaves the page in the same coherent state). The
 * fourth face is the EXISTING M5-02 expansion view — the rework-round
 * lineage the 返工轮次 presentation reads (M11-04, zero server change). */
function loadRunFaces(
  runId: string
): Promise<readonly [RunDetailView, RunGraphView, readonly ApprovalItemView[], RunExpansionsView]> {
  return Promise.all([
    fetchRunDetail(runId),
    fetchRunGraph(runId),
    fetchRunApprovals(runId),
    fetchRunExpansions(runId)
  ]).then(
    ([detail, graph, approvals, expansions]) =>
      [detail, graph, approvals.approvals, expansions] as const
  );
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

/** One node's drill-down body: attempt spans, the candidate diff (file list
 * + the unified text through the page's own painter), a reviewer-role node's
 * A12 verdict records, and the logs — fetched on mount, refreshed by the
 * explicit 刷新 button. */
function NodeDrillDown(props: {
  readonly runId: string;
  readonly nodeId: string;
  readonly role: string;
  readonly reworkRounds: readonly { readonly generation: number; readonly state: string }[];
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
  // M11-04 Reviewer 下钻: the A12 verdict records of THIS review node.
  const [review, setReview] = useState<RunReviewRecordsView | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const isReviewer = props.role === "reviewer";

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

  const loadReview = (): void => {
    if (!isReviewer) return;
    fetchReviewRecords(props.runId, props.nodeId)
      .then((view) => setReview(view))
      .catch((cause: unknown) => setReviewError(loadFailureText(cause)));
  };

  useEffect(() => {
    loadLogs();
    loadReview();
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
  // The unified text renders through the page's own painter (UnifiedDiff).
  const unifiedLines = diff !== null && diff.unified !== "" ? diff.unified.split("\n") : [];
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

      {isReviewer ? (
        <>
          <p className="node-drill-head">评审记录</p>
          {reviewError !== null ? <FormStatus kind="error">{reviewError}</FormStatus> : null}
          {review === null && reviewError === null ? <p className="form-status">正在读取评审记录…</p> : null}
          {review !== null && review.records.length === 0 ? (
            <p className="form-status">该评审节点还没有评审记录(评审完成后,这里显示结论与发现的问题)。</p>
          ) : null}
          {review !== null && review.records.length > 0 ? (
            <div className="review-records">
              {review.records.map((record, index) => (
                <div key={`${String(record.candidateSha)}-${String(index)}`} className="review-record">
                  <p className="form-status">
                    {record.state === "COMPLETED" ? (
                      record.verdict === "pass" ? (
                        <strong>结论:通过</strong>
                      ) : (
                        <strong>结论:未通过(发现 {String(record.findings.length)} 个问题)</strong>
                      )
                    ) : record.state === "INVALID" ? (
                      <>记录已失效(绑定的候选产物已变化){record.invalidatedReason !== null ? `:${record.invalidatedReason}` : ""}</>
                    ) : (
                      "评审进行中…"
                    )}
                  </p>
                  {record.findings.length > 0 ? (
                    <ol className="review-findings">
                      {record.findings.map((finding, findingIndex) => (
                        <li key={String(findingIndex)}>{finding}</li>
                      ))}
                    </ol>
                  ) : null}
                </div>
              ))}
              {/* Honest degradation (M11-04 ask ②): the frozen contracts
              findings shape is a plain string list — NO severity/grading
              field is persisted, so none is shown or invented. */}
              <p className="form-status">
                当前评审记录不保存问题分级(严重级),仅保存逐条问题描述;分级呈现将在后续版本评估。
              </p>
            </div>
          ) : null}
          {props.reworkRounds.length > 0 ? (
            <p className="form-status">
              {props.reworkRounds
                .map((round) => `第 ${String(round.generation)} 轮返工已触发(修复节点${nodeHumanState(round.state).label})`)
                .join(";")}
              。
            </p>
          ) : null}
        </>
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
          {/* M11-04: the unified text the endpoint already carries, painted
          by the page's OWN lightweight component (plain React text nodes,
          transport-escaped; no HTML assembly, no highlight library). Both
          caps (server chars, painter lines) are announced. */}
          {unifiedLines.length > 0 && unifiedLines.some((line) => line.trim() !== "") ? (
            <UnifiedDiff unified={diff.unified} truncated={diff.unifiedTruncated} />
          ) : (
            <p className="form-status">该候选没有可显示的文本改动(可能只有二进制文件变更)。</p>
          )}
        </div>
      ) : diffError === null ? (
        <p className="form-status">
          该信息当前未持久化:普通执行节点的工作区文件活动没有按节点留痕,任务级的集成候选
          Diff 只在有集成产出的节点上可得。运行中可看下方执行日志。
        </p>
      ) : null}

      <p className="node-drill-head">
        执行日志
        <button
          type="button"
          className="btn"
          style={{ marginLeft: 8 }}
          onClick={() => {
            loadLogs();
            loadReview();
          }}
        >
          <RefreshCw size={14} /> 刷新
        </button>
      </p>
      {/* M11-04 任务 3, 决策 (a) 的另一半如实标注: the NODE states ride the
      3s poll, but the LOG panel is an on-demand snapshot — say so instead of
      implying a live tail. */}
      <p className="form-status">日志按需加载,不自动续拉;点「刷新」获取最新(节点状态每 3 秒自动刷新)。</p>
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
            <>
              {/* M11-03 review handover ⑨: a FULL page means the log may
              continue beyond it — say so instead of silently implying
              completeness. */}
              {group.events.length >= EXECUTION_EVENT_PAGE_SIZE ? (
                <p className="form-status">
                  仅显示前 {String(EXECUTION_EVENT_PAGE_SIZE)} 条日志(更早日志未列出;完整日志可在诊断台查看)。
                </p>
              ) : null}
              <ul className="event-log">
                {group.events.map((event) => (
                  <li key={event.eventId}>
                    <span className="event-time">{formatTimestamp(event.occurredAt)}</span>{" "}
                    <code className="event-type">{event.type}</code>
                    {event.text !== null ? <span className="event-text">{event.text}</span> : null}
                  </li>
                ))}
              </ul>
            </>
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
  const [expansions, setExpansions] = useState<RunExpansionsView | null>(null);
  const [objective, setObjective] = useState<string | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decisionBusy, setDecisionBusy] = useState<string | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decisionDone, setDecisionDone] = useState<string | null>(null);
  const [expandedNode, setExpandedNode] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // M11-04: the node-structure view toggle (时间线 default; 节点图 the
  // secondary nodes+dependencies face).
  const [nodeView, setNodeView] = useState<"timeline" | "graph">("timeline");
  const objectiveFetched = useRef(false);
  const projectNameFetched = useRef(false);

  useEffect(() => {
    if (runId === "") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const poll = (): void => {
      loadRunFaces(runId)
        .then(([nextDetail, nextGraph, nextApprovals, nextExpansions]) => {
          if (cancelled) return;
          setDetail(nextDetail);
          setGraph(nextGraph);
          setApprovals(nextApprovals);
          setExpansions(nextExpansions);
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

  // M11-04 (review handover ⑧): the explicit manual refresh entry — the same
  // three-face round the poll walks, available in EVERY state (a terminal
  // page can still be stale, and the drill-down snapshots below are
  // mount-time by design).
  const refreshNow = (): void => {
    if (refreshing) return;
    setRefreshing(true);
    loadRunFaces(runId)
      .then(([nextDetail, nextGraph, nextApprovals, nextExpansions]) => {
        setDetail(nextDetail);
        setGraph(nextGraph);
        setApprovals(nextApprovals);
        setExpansions(nextExpansions);
        setError(null);
      })
      .catch((cause: unknown) => setError(loadFailureText(cause)))
      .finally(() => setRefreshing(false));
  };

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
        // M11-04 (review handover ⑧): a decision un-pauses the run — the
        // resumed run moves nodes/executions too, so ALL THREE faces refresh
        // immediately instead of waiting for the next 3s tick. The decision
        // itself already landed here, so a REFRESH failure reports in its own
        // sentence beside the success banner and must not read as a decision
        // failure (hence it is caught on its own chain, not the outer one).
        loadRunFaces(runId)
          .then(([nextDetail, nextGraph, nextApprovals, nextExpansions]) => {
            setDetail(nextDetail);
            setGraph(nextGraph);
            setApprovals(nextApprovals);
            setExpansions(nextExpansions);
          })
          .catch((cause: unknown) =>
            setDecisionError(`决策已生效,但刷新任务状态失败: ${loadFailureText(cause)}`)
          );
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
  // M11-04 任务 3: the 节点 N(角色) labels (served graph order) shared by
  // the 节点图 view and the 返工轮次 lines — raw node ids stay in 开发者详情.
  const graphLabels = nodeGraphLabels(graph?.nodes ?? []);
  // M11-04 返工轮次 (real data from the M5-02 expansion view): which minted
  // fix/re-review node carries which round, and which rounds a review node
  // triggered.
  const reworkTagByNode = new Map<string, number>();
  for (const round of expansions?.expansions ?? []) {
    reworkTagByNode.set(round.fixNode.nodeId, round.generation);
    reworkTagByNode.set(round.reviewNode.nodeId, round.generation);
  }
  const roundsForNode = (nodeId: string): readonly { readonly generation: number; readonly state: string }[] =>
    (expansions?.expansions ?? [])
      .filter((round) => round.triggerReviewNodeId === nodeId)
      .map((round) => ({ generation: round.generation, state: round.fixNode.state }));
  const actionableCount = (approvals ?? []).filter((approval) => approval.actionable).length;
  const scrollToApprovals = (): void => {
    document.getElementById("approvals-card")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

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
              {/* M11-04 任务 3, 决策 (a): the honest 3s-polling label — the
              ONLY claim of live updates, hidden once terminal. */}
              <PollRefreshBadge terminal={runIsTerminal(detail)} />
              <button type="button" className="btn" onClick={refreshNow} disabled={refreshing}>
                <RefreshCw size={14} className={refreshing ? "spin" : undefined} /> 刷新
              </button>
            </p>
          </Card>

          {approvals !== null && approvals.length > 0 ? (
            <Card>
              <div id="approvals-card">
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
              </div>
            </Card>
          ) : null}

          <Card>
            <h2 className="section-title" style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
              Agent 时间线
              {/* M11-04: the 节点图 secondary view toggle (节点+依赖 face). */}
              <span style={{ display: "inline-flex", gap: 6 }}>
                <button
                  type="button"
                  className={`btn${nodeView === "timeline" ? " btn-primary" : ""}`}
                  onClick={() => setNodeView("timeline")}
                >
                  <Clock size={14} /> 时间线
                </button>
                <button
                  type="button"
                  className={`btn${nodeView === "graph" ? " btn-primary" : ""}`}
                  onClick={() => setNodeView("graph")}
                >
                  <GitBranch size={14} /> 节点图
                </button>
              </span>
            </h2>
            {graph === null ? <p className="form-status">正在读取任务结构…</p> : null}

            {/* M11-04 任务 3 返工轮次: the extracted pure face over the REAL
            expansion rows; renders nothing while no round exists. */}
            <ReworkRounds expansions={expansions} nodeLabels={graphLabels} />

            {graph !== null && nodeView === "graph" ? (
              /* M11-04 节点图 secondary view (extracted pure face): each
              node with its DECLARED dependencies, labels only. */
              <NodeGraphView
                nodes={graph.nodes}
                reworkTags={reworkTagByNode}
                showWaitGuide={actionableCount > 0}
                onWaitGuide={scrollToApprovals}
              />
            ) : null}

            {graph !== null && nodeView === "timeline"
              ? waves.map((wave) => (
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
                              {reworkTagByNode.has(nodeId) ? (
                                <span className="rework-tag">第 {String(reworkTagByNode.get(nodeId))} 轮返工</span>
                              ) : null}
                              {lastDuration !== null ? <span className="list-row-meta">耗时 {lastDuration}</span> : null}
                            </p>
                            {node.objective !== "" ? <p className="timeline-node-objective">{node.objective}</p> : null}
                            {expandedNode === nodeId ? (
                              <NodeDrillDown
                                runId={runId}
                                nodeId={nodeId}
                                role={node.role}
                                reworkRounds={roundsForNode(nodeId)}
                                executions={executions}
                              />
                            ) : null}
                            {waiting && actionableCount > 0 ? (
                              <button type="button" className="btn btn-waiting-guide" onClick={scrollToApprovals}>
                                等待你的决定
                              </button>
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
                ))
              : null}
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
