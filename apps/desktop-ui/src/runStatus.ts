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

/** Server timestamps → short human date (the raw ISO string stays in the title). */
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
