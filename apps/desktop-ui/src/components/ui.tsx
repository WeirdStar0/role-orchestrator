/**
 * M11-01 component primitives — deliberately tiny, self-built on the token
 * layer (the ask: 少量组件原语自建,不引入重型 UI 库). Every "state color"
 * usage goes through the four frozen tones.
 */
import type { ReactNode } from "react";
import { runHumanStatus, type StatusTone } from "../runStatus";

export function Card(props: { readonly children: ReactNode }): ReactNode {
  return <section className="card">{props.children}</section>;
}

export function ListRow(props: { readonly children: ReactNode }): ReactNode {
  return <div className="list-row">{props.children}</div>;
}

export function EmptyState(props: { readonly children: ReactNode }): ReactNode {
  return <div className="empty-state">{props.children}</div>;
}

export function StatusBadge(props: {
  readonly status: string | null | undefined;
  readonly outcome: string | null | undefined;
}): ReactNode {
  const human = runHumanStatus(props.status, props.outcome);
  return <span className={`status-badge status-${human.tone}`}>{human.label}</span>;
}

export function FormStatus(props: {
  readonly kind: "info" | "error" | "success";
  readonly children: ReactNode;
}): ReactNode {
  const cls =
    props.kind === "error" ? "form-status form-status-error" : props.kind === "success" ? "form-status form-status-success" : "form-status";
  return (
    <p className={cls} role="status">
      {props.children}
    </p>
  );
}

export function toneClass(tone: StatusTone): string {
  return `status-${tone}`;
}
