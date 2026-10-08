/**
 * M11-03 — the approval card (A17 presentation, product face). Pure display:
 * the view row arrives through props; the decision POST lives in the page.
 *
 * Discipline carried over from the M5-03 surface: EVERY digest constituent
 * the operator is deciding on is visible BEFORE the decision (argv, risk
 * grade + reasons, the minted permission increments, expiry); approve/reject
 * is PER approval (no batch, no global-grant vocabulary anywhere); a
 * non-actionable approval (decided / expired / candidate-changed) renders its
 * invalidations honestly and offers NO buttons; a rejection requires a
 * reason (the server re-validates). Internal ids (approvalId/digest/sha)
 * stay out of the card's VISIBLE text — they fold into the page's
 * 开发者详情. One ATTRIBUTE-level presence is deliberate (M11-04 review
 * handover ⑬, stated precisely): the reason input's accessibility id is
 * `approval-reason-<approvalId>` — a label htmlFor handle for the paired
 * input, never rendered copy.
 */
import { useState, type ReactNode } from "react";
import { Check, LoaderCircle, ShieldAlert, TriangleAlert } from "lucide-react";
import type { ApprovalItemView } from "../api";
import { formatTimestamp } from "../runStatus";
import { FormStatus } from "./ui";

/** Risk grade → 人话 (unknown grades verbatim, never invented into 低). */
export function riskGradeLabel(grade: string): string {
  switch (grade) {
    case "low":
      return "低风险";
    case "medium":
      return "中风险";
    case "high":
      return "高风险";
    default:
      return grade === "" ? "风险等级未知" : grade;
  }
}

/** Why a decision is currently impossible (server invalidation codes → 人话). */
export function invalidationLabel(code: string): string {
  if (code === "EXPIRED") return "已过期";
  if (code === "CANDIDATE_CHANGED") return "绑定的候选产物已变化";
  if (code.startsWith("STATUS_")) {
    const status = code.slice("STATUS_".length);
    switch (status) {
      case "APPROVED":
        return "已批准";
      case "REJECTED":
        return "已拒绝";
      case "CONSUMED":
        return "已被任务继续流程消费";
      case "EXPIRED":
        return "已过期";
      default:
        return status;
    }
  }
  return code;
}

export function ApprovalCard(props: {
  readonly approval: ApprovalItemView;
  readonly busy: boolean;
  readonly errorText: string | null;
  readonly onDecide: (decision: "approve" | "reject", reason: string) => void;
}): ReactNode {
  const [reason, setReason] = useState("");
  const approval = props.approval;
  const live = approval.actionable;
  return (
    <div className={`approval-card${approval.status === "PENDING" && live ? " approval-card-live" : ""}`}>
      <p className="approval-head">
        {approval.status === "PENDING" ? <ShieldAlert size={16} /> : <Check size={16} />}
        {approval.status === "PENDING"
          ? live
            ? "等待你的审批"
            : "等待审批(当前不可操作)"
          : invalidationLabel(`STATUS_${approval.status}`)}
        <span className={`status-badge status-${approval.riskGrade === "high" ? "error" : approval.riskGrade === "medium" ? "warning" : "neutral"}`}>
          {riskGradeLabel(approval.riskGrade)}
        </span>
      </p>
      {approval.riskReasons.length > 0 ? (
        <p className="approval-line">风险原因:{approval.riskReasons.join("、")}</p>
      ) : null}
      <p className="approval-line">将执行:{props.approval.argv.join(" ")}</p>
      {approval.permissionIncrements.length > 0 ? (
        <p className="approval-line">新增权限:{approval.permissionIncrements.join("、")}</p>
      ) : null}
      <p className="approval-line">过期时间:{formatTimestamp(approval.expiresAt) || "未知"}</p>
      {!live && approval.invalidations.length > 0 ? (
        <p className="approval-line">
          <TriangleAlert size={14} /> 该审批当前不可操作:{approval.invalidations.map(invalidationLabel).join(";")}。
        </p>
      ) : null}
      {live ? (
        <>
          <label className="field-label" htmlFor={`approval-reason-${approval.approvalId}`}>
            拒绝原因(拒绝时必填)
          </label>
          <input
            id={`approval-reason-${approval.approvalId}`}
            className="input"
            type="text"
            value={reason}
            maxLength={2000}
            onChange={(event) => setReason(event.target.value)}
          />
          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={props.busy}
              onClick={() => props.onDecide("approve", "")}
            >
              {props.busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
              批准
            </button>
            <button
              type="button"
              className="btn"
              disabled={props.busy || reason.trim() === ""}
              onClick={() => props.onDecide("reject", reason.trim())}
            >
              <TriangleAlert size={16} />
              拒绝
            </button>
          </div>
          <p className="form-status">
            审批绑定精确内容:批准只对这一条动作生效,不会放权其他操作;拒绝会记录原因。
          </p>
        </>
      ) : null}
      {props.errorText !== null ? <FormStatus kind="error">{props.errorText}</FormStatus> : null}
    </div>
  );
}
