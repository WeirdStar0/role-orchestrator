/**
 * M11-03 — the four-role binding face, shared by the wizard's embedded
 * binding step and the projects page's status cards. Pure display + pure
 * helpers: all state (the lookup view, the loaded profiles, the selections)
 * arrives through props, so every state renders string-testably without
 * fetch mocks.
 *
 * 人话 discipline: role cards show the PRODUCT runtime name (Claude Code /
 * Codex), never a profile id; the ids travel only as the selects' values and
 * the PUT's handles. A bound profile that is NOT among the loaded profiles
 * is an honest "未载入" state — never silently rendered as healthy, never
 * rendered as an identifier.
 */
import type { ReactNode } from "react";
import { Check, CircleAlert } from "lucide-react";
import type { ProfileSummary, RoleBindingsView, SetupRoleId } from "../api";

export const ROLE_LABELS: Readonly<Record<SetupRoleId, string>> = {
  coordinator: "协调",
  architect: "架构",
  developer: "开发",
  reviewer: "评审"
};

const ROLE_IDS: readonly SetupRoleId[] = ["coordinator", "architect", "developer", "reviewer"];

/** Runtime → product name (unknown runtimes pass through verbatim). */
export function runtimeName(runtime: string): string {
  if (runtime === "claude") return "Claude Code";
  if (runtime === "codex") return "Codex";
  return runtime;
}

/** Role enum → 人话名, total over strings (the graph view serves roles as
 * plain strings; unknown values surface verbatim, never invented). */
export function roleHumanLabel(role: string): string {
  const label = (ROLE_LABELS as Readonly<Record<string, string>>)[role];
  return label ?? (role === "" ? "未知角色" : role);
}

export interface ResolvedRoleBinding {
  readonly roleId: SetupRoleId;
  /** The bound profile id (the handle), or null when unbound. */
  readonly profileId: string | null;
  /** Product runtime line when bound AND loaded; null otherwise. */
  readonly runtimeLabel: string | null;
  readonly model: string | null;
  /** True when bound but the profile is not among the loaded profiles. */
  readonly notLoaded: boolean;
}

/**
 * Join the lookup view with the loaded profiles (pure). A role with NO row,
 * a row with a null profileId, or a profileId outside the loaded list is
 * honestly unbound/not-loaded — never guessed into a healthy state.
 */
export function resolveRoleBindings(
  view: Pick<RoleBindingsView, "bindings">,
  profiles: readonly ProfileSummary[]
): readonly ResolvedRoleBinding[] {
  const byId = new Map(profiles.map((profile) => [profile.id, profile]));
  return ROLE_IDS.map((roleId) => {
    const row = view.bindings.find((entry) => entry.roleId === roleId);
    const profileId = row?.profileId ?? null;
    if (profileId === null) {
      return { roleId, profileId: null, runtimeLabel: null, model: null, notLoaded: false };
    }
    const profile = byId.get(profileId);
    if (profile === undefined) {
      return { roleId, profileId, runtimeLabel: null, model: null, notLoaded: true };
    }
    return {
      roleId,
      profileId,
      runtimeLabel: runtimeName(profile.runtime),
      model: profile.model,
      notLoaded: false
    };
  });
}

/** A01 completeness, over the resolved view: every role bound AND loaded. */
export function bindingsComplete(resolved: readonly ResolvedRoleBinding[]): boolean {
  return resolved.every((entry) => entry.profileId !== null && !entry.notLoaded);
}

/**
 * The prefill from the setup status's recommended template: for each role,
 * the first loaded profile whose runtime matches the template's suggestion
 * ("" when no template or no matching profile — the select shows the
 * placeholder instead of a guess).
 */
export function defaultSelections(
  template: readonly { readonly roleId: SetupRoleId; readonly runtime: string }[] | null,
  profiles: readonly ProfileSummary[]
): Readonly<Record<SetupRoleId, string>> {
  const selections = { coordinator: "", architect: "", developer: "", reviewer: "" };
  if (template === null) return selections;
  for (const entry of template) {
    const match = profiles.find((profile) => profile.runtime === entry.runtime);
    selections[entry.roleId] = match?.id ?? "";
  }
  return selections;
}

/**
 * M11-04 (M11-03 review handover ⑤): how many of the four roles the
 * recommended template can ACTUALLY prefill given the loaded profiles — the
 * honest basis for the prefill sentence. "推荐分工已预填" may only be said
 * when every suggested role finds a loaded profile; a null/absent template
 * or missing runtime matches means the copy must not claim a prefill that
 * did not happen.
 */
export function prefillFillableCount(
  template: readonly { readonly roleId: SetupRoleId; readonly runtime: string }[] | null | undefined,
  profiles: readonly ProfileSummary[]
): number {
  if (template === null || template === undefined) return 0;
  let fillable = 0;
  for (const entry of template) {
    if (profiles.some((profile) => profile.runtime === entry.runtime)) fillable += 1;
  }
  return fillable;
}

/** The four role cards (the "成功展示四角色卡片" face and the status view). */
export function RoleBindingCards(props: {
  readonly resolved: readonly ResolvedRoleBinding[];
}): ReactNode {
  return (
    <div className="role-cards">
      {props.resolved.map((entry) => (
        <div key={entry.roleId} className={`role-card role-card-${entry.profileId !== null && !entry.notLoaded ? "ok" : "missing"}`}>
          <p className="role-card-role">
            {entry.profileId !== null && !entry.notLoaded ? <Check size={14} /> : <CircleAlert size={14} />}
            {ROLE_LABELS[entry.roleId]}
          </p>
          <p className="role-card-runtime">
            {entry.profileId === null
              ? "未绑定"
              : entry.notLoaded
                ? "已绑定,但该 AI 配置当前未载入(重启服务后可用)"
                : entry.runtimeLabel}
          </p>
        </div>
      ))}
    </div>
  );
}

/** The four selects (the editor face). Values are profile ids; labels are
 * product lines with the id as the tiebreaker suffix — ids never appear in
 * the CARDS above, only in this configuration surface (old-page parity). */
export function RoleBindingEditor(props: {
  readonly profiles: readonly ProfileSummary[];
  readonly selections: Readonly<Record<SetupRoleId, string>>;
  readonly onChange: (roleId: SetupRoleId, profileId: string) => void;
}): ReactNode {
  const options = props.profiles.map((profile) => (
    <option key={profile.id} value={profile.id}>
      {runtimeName(profile.runtime)}
      {profile.model !== null ? ` · ${profile.model}` : ""}
      {` (${profile.id})`}
    </option>
  ));
  return (
    <div className="role-editor">
      {ROLE_IDS.map((roleId) => (
        <div key={roleId} className="role-editor-row">
          <label className="field-label" htmlFor={`role-select-${roleId}`}>
            {ROLE_LABELS[roleId]}
          </label>
          <select
            id={`role-select-${roleId}`}
            className="select"
            value={props.selections[roleId]}
            onChange={(event) => props.onChange(roleId, event.target.value)}
          >
            <option value="">选择 AI 配置…</option>
            {options}
          </select>
        </div>
      ))}
    </div>
  );
}
