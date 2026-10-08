/**
 * M11-04 任务 3 — the run-detail visualization pieces, extracted PURE so
 * every face is string-testable (renderToString) against fabricated data:
 * the real-data browser chains (app-rework-flow / app-approval-flow) prove
 * these faces LIVE; these pins make the render CONTRACTS explicit and give
 * the discriminance the ask names — a regression that leaks raw node ids
 * into structure rows, drops the honest hold copy, or claims live updates
 * on a settled run goes red here without any browser.
 *
 * 执行日志实时性决策(ask 二选一)= **(a) 保持 3s 轮询 + 如实标注**:
 * PollRefreshBadge is the ONLY place the polling口径 is claimed — visible
 * while the run is non-terminal (including the recoverable `blocked`
 * pause), gone once terminal (a badge on a settled run would claim updates
 * the page no longer performs). M11-05 停摆态二选一: a FAILED poll round
 * self-heals with a capped backoff (RunDetailPage poll) rather than the
 * badge being retracted on failure — with a dead poll the claim would be
 * false anyway, and a retracted badge plus a frozen page is precisely the
 * ⑧ page-stall shape this batch already fixed. The execution LOG panel
 * stays an explicit refresh snapshot and says so (NodeDrillDown's 不自动续拉
 * caption, its poll claim conditional on the poll actually running).
 * Option (b) — a one-time-ticket WS live stream — was declined: it would
 * add a NEW credentialed ticket endpoint plus a WS-auth change on a path
 * ADR 010 documents as fail-closed (the shell's header injection does not
 * cover the WS upgrade), require a frozen-surface ADR supplement with its
 * own mitigation list and replay/expiry edges — a security-surface cost the
 * single-operator local product's 3s poll + explicit refresh does not
 * justify; the WS live stream remains available where it exists today (the
 * old console's developer-grade ws-events.ts path). The full reason is
 * recorded in the batch report.
 */
import type { ReactNode } from "react";
import { Clock } from "lucide-react";
import type { RunExpansionsView, RunGraphNode } from "../api";
import { nodeHumanState } from "../runStatus";
import { roleHumanLabel } from "./RoleBindingSection";
import { FormStatus } from "./ui";

/** Decision (a)'s honest label. Renders NOTHING for a terminal run. */
export function PollRefreshBadge(props: { readonly terminal: boolean }): ReactNode {
  if (props.terminal) return null;
  return (
    <span className="list-row-meta">
      <Clock size={14} /> 每 3 秒自动刷新
    </span>
  );
}

/**
 * The 节点 N(角色) label map over the SERVED graph order (after an
 * expansion the minted nodes join it, so ordinals are not the creation
 * order — the dependency LABELS are the contract, not positions). Raw node
 * ids never enter the default view through these labels; they fold into the
 * page's 开发者详情.
 */
export function nodeGraphLabels(nodes: readonly RunGraphNode[]): ReadonlyMap<string, string> {
  return new Map(
    nodes.map((node, index) => [node.nodeId, `节点 ${String(index + 1)}(${roleHumanLabel(node.role)})`])
  );
}

/** The 节点图 secondary view: each node with its DECLARED dependencies,
 * spoken entirely in labels — the structure rows carry no raw ids (the
 * server-authored objective PROSE may quote them; that is durable content,
 * not structure). */
export function NodeGraphView(props: {
  readonly nodes: readonly RunGraphNode[];
  readonly reworkTags: ReadonlyMap<string, number>;
  readonly showWaitGuide: boolean;
  readonly onWaitGuide: () => void;
}): ReactNode {
  const labels = nodeGraphLabels(props.nodes);
  return (
    <div className="node-graph">
      {props.nodes.map((node) => {
        const human = nodeHumanState(node.state);
        const waiting = node.state === "WAITING_APPROVAL";
        const label = labels.get(node.nodeId) ?? "未知节点";
        return (
          <div key={node.nodeId} className={`node-graph-row${waiting ? " timeline-node-waiting" : ""}`}>
            <p className="timeline-node-head">
              {label}
              <span className={`status-badge status-${human.tone}`}>{human.label}</span>
              {props.reworkTags.has(node.nodeId) ? (
                <span className="rework-tag">第 {String(props.reworkTags.get(node.nodeId))} 轮返工</span>
              ) : null}
              {waiting && props.showWaitGuide ? (
                <button type="button" className="btn btn-waiting-guide" onClick={props.onWaitGuide}>
                  等待你的决定
                </button>
              ) : null}
            </p>
            {node.objective !== "" ? <p className="timeline-node-objective">{node.objective}</p> : null}
            <p className="form-status">
              {node.dependencies.length === 0
                ? "无前置依赖(起点节点)。"
                : `依赖:${node.dependencies
                    .map((dependency) => labels.get(dependency) ?? "未知节点")
                    .join("、")}。`}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** The 返工轮次 face: the REAL executed rounds from the durable expansion
 * rows (评审未通过 → 修复 → 复审, with live states and the findings count)
 * plus the A20 hold copy. Renders NOTHING while no round has executed and
 * no hold exists — an empty box would fabricate a rework history. */
export function ReworkRounds(props: {
  readonly expansions: RunExpansionsView | null;
  readonly nodeLabels: ReadonlyMap<string, string>;
}): ReactNode {
  const view = props.expansions;
  if (view === null || (view.expansions.length === 0 && view.unresolvedHold === null)) return null;
  const label = (nodeId: string): string => props.nodeLabels.get(nodeId) ?? "未知节点";
  return (
    <div className="rework-rounds">
      <p className="node-drill-head">
        返工轮次(共 {String(view.expansions.length)} 轮;上限 {String(view.maxReviewRounds)} 轮)
      </p>
      {view.expansions.map((round) => (
        <p key={`round-${String(round.generation)}-${round.fixNode.nodeId}`} className="form-status">
          第 {String(round.generation)} 轮:评审({label(round.triggerReviewNodeId)})未通过
          {round.findings.length > 0 ? `,发现 ${String(round.findings.length)} 个问题` : ""} →{" "}
          {roleHumanLabel(round.fixNode.role)}修复({nodeHumanState(round.fixNode.state).label})→ 复审(
          {nodeHumanState(round.reviewNode.state).label})。
        </p>
      ))}
      {view.unresolvedHold !== null ? (
        <FormStatus kind="error">
          返工轮次已达上限({String(view.maxReviewRounds)} 轮),任务已暂停,等待你的处置(产品内的处置入口尚未提供,将在后续版本评估)。
        </FormStatus>
      ) : null}
    </div>
  );
}
