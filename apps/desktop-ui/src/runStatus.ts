/**
 * M11-01 人话状态(the ask: 执行中/已完成/失败/等待审批):the run list and
 * detail pages speak the product language, derived from the SAME frozen
 * fields the old page uses — `status` (the durable PLANNED/RUNNING/…
 * vocabulary) and `outcome` (the M10-04 failed/blocked/cancelled/success
 * overlay). Pure and total: unknown values surface VERBATIM (never
 * silently mapped into a wrong 人话).
 *
 * Precedence: outcome first (it is the LIVE truth a frozen RUNNING status
 * hides — a failed run is 失败, not a fake 执行中), then status.
 */
export type StatusTone = "running" | "success" | "error" | "warning" | "neutral";

export interface HumanStatus {
  readonly label: string;
  readonly tone: StatusTone;
}

export function runHumanStatus(status: string | null | undefined, outcome: string | null | undefined): HumanStatus {
  switch (outcome) {
    case "failed":
      return { label: "失败", tone: "error" };
    case "blocked":
      return { label: "等待审批", tone: "warning" };
    case "cancelled":
      return { label: "已取消", tone: "neutral" };
    case "success":
      return { label: "已完成", tone: "success" };
    default:
      break;
  }
  switch (status) {
    case "PLANNED":
      return { label: "排队中", tone: "neutral" };
    case "RUNNING":
      return { label: "执行中", tone: "running" };
    case "READY_FOR_DELIVERY":
      return { label: "已完成", tone: "success" };
    case "DELIVERED":
      return { label: "已完成", tone: "success" };
    case "CANCELLED":
      return { label: "已取消", tone: "neutral" };
    default:
      // Unknown/absent: surface the raw value honestly in a neutral tone.
      return { label: status === null || status === undefined || status === "" ? "未知状态" : status, tone: "neutral" };
  }
}

// ---------------------------------------------------------------------------
// M11-04 (M11-03 review handover ⑧): terminal-ness of the run detail's poll.
// The outcome overlay's `blocked` is RECOVERABLE, not terminal: the run row
// stays RUNNING while approvals are pending and the driver RESETS the
// outcome to NULL once the checkpoint resumes (run-driver.ts settleRunStatus:
// "any node WAITING_APPROVAL -> run stays RUNNING, outcome 'blocked'" plus
// the idempotent blocked→NULL reset). Treating `blocked` as terminal stopped
// the detail page's 3s poll exactly when the operator most needs live
// updates — the approval pause froze the page. failed/success/cancelled keep
// their settled meaning; the M11-03 review names only `blocked` as the
// recoverable case.
// ---------------------------------------------------------------------------

/** True when the run detail has settled: a terminal outcome overlay
 * (success/failed/cancelled — never the recoverable `blocked`) or a terminal
 * durable status (DELIVERED/CANCELLED). `blocked` returns false so the page
 * keeps polling through an approval pause. */
export function runIsTerminal(detail: { readonly status: string; readonly outcome: string | null }): boolean {
  if (detail.outcome === "blocked") return false;
  if (detail.outcome !== null) return true;
  return detail.status === "DELIVERED" || detail.status === "CANCELLED";
}

/** Server timestamps → short human date for list rows. An unfuzzable value
 * (unparseable/absent) passes through verbatim; nothing here invents a date. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  const pad = (n: number): string => (n < 10 ? `0${String(n)}` : String(n));
  return (
    `${String(parsed.getFullYear())}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())} ` +
    `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
}

// ---------------------------------------------------------------------------
// M11-03 任务详情: NODE-state 人话 + attempt 时长. The node state vocabulary
// is dag's frozen NODE_STATES (the graph view serves it verbatim); the
// mapping is total and honest — an unknown value surfaces verbatim, never
// silently bent into a wrong 人话. There is deliberately NO 「等待集成」
// label: the durable node rows do not distinguish an integration-target
// state (the dispatch kind never enters the store), so a finished node that
// waits on its dependents simply reads 已完成 — inventing the label would
// fabricate a state the data does not carry.
// ---------------------------------------------------------------------------

export function nodeHumanState(state: string | null | undefined): HumanStatus {
  switch (state) {
    case "RUNNING":
      return { label: "运行中", tone: "running" };
    case "WAITING_APPROVAL":
      return { label: "等待审批", tone: "warning" };
    case "SUCCEEDED":
      return { label: "已完成", tone: "success" };
    case "FAILED":
      return { label: "失败", tone: "error" };
    case "READY":
      return { label: "待执行", tone: "neutral" };
    case "PENDING":
      return { label: "等待前置", tone: "neutral" };
    case "BLOCKED":
      return { label: "已阻塞", tone: "warning" };
    case "RETRY_PENDING":
      return { label: "等待重试", tone: "warning" };
    case "INTERRUPTED":
      return { label: "已中断", tone: "error" };
    case "RECOVERY_REQUIRED":
      return { label: "需要恢复", tone: "error" };
    case "CANCELLED":
      return { label: "已取消", tone: "neutral" };
    default:
      return { label: state === null || state === undefined || state === "" ? "未知状态" : state, tone: "neutral" };
  }
}

/** Attempt duration in 人话 (e.g. 42 秒 / 3 分 5 秒); null when the span is
 * not computable (missing/unparseable stamps) — never a fabricated 0. */
export function formatDuration(startIso: string, endIso: string): string | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return null;
  const seconds = Math.round((end - start) / 1000);
  if (seconds < 60) return `${String(seconds)} 秒`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(rest)} 秒`;
}
