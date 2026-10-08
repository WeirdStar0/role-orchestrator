/**
 * M11-06 — the shared (CLI, model) → save flow behind the Settings「Agent
 * 团队」editor and the new-task wizard's binding step. ONE implementation,
 * two callers, so the semantics cannot drift between the surfaces:
 *
 *   1. composeProfileUpsert (pure, profileUpsert.ts) turns the four
 *      selections into the target profile set — combo reuse first, ADD-ONLY
 *      merge (existing entries are never rewritten; the user's other
 *      profiles survive byte-for-byte), minted ids per the M11-06 convention.
 *   2. A changed set goes through the EXISTING atomic PUT
 *      /api/v1/profiles/full (the server validates through the frozen parser
 *      before any filesystem mutation; temp + rename).
 *   3. The binding PUT (EXISTING transactional
 *      PUT /api/v1/projects/:id/role-bindings) fires ONLY when every target
 *      id is in the running process's LOADED set (GET /api/v1/profiles). A
 *      minted profile is by definition not loaded yet — firing the PUT would
 *      deterministically 422 (UNKNOWN_PROFILE) — so the flow SKIPS it and
 *      reports bind-pending with the restart-and-resave instruction. The 422
 *      humanizer arm stays as belt-and-braces for a stale-UI race.
 *
 * Effect timing, stated exactly by the callers' copy: a completed binding
 * applies to the project's NEW tasks immediately (no restart); the profiles
 * FILE change reaches the running service only after a desktop-app restart
 * (no hot reload — serveProfilesFullPut's own note).
 */
import { putProfilesFull, putRoleBindings, type ProfileFullEntry, type SetupRoleId } from "./api";
import {
  composeProfileUpsert,
  duplicateProfileIdMessage,
  firstDuplicateProfileId,
  profilesFileContent,
  type ModelSelection,
  type UpsertBindingInput
} from "./profileUpsert";

export type TeamSaveOutcome =
  /** Bindings written (all targets were loaded). `fileChanged` is
   * informational — in the normal path a file change implies pending. */
  | { readonly kind: "bind-done"; readonly fileChanged: boolean; readonly addedCount: number }
  /** The file now carries the new profiles; the RUNNING service has not
   * loaded them, so the binding PUT was deliberately NOT fired. The caller
   * renders the restart-and-resave instruction. */
  | { readonly kind: "bind-pending"; readonly addedCount: number }
  /** Every target already equals the current binding and the file already
   * serves every combo — nothing to write, nothing to bind. */
  | { readonly kind: "no-change" }
  /** The pure planner refused (no CLI chosen / bad custom token / id
   * collision / no base entry to clone). No fetch has fired yet. */
  | { readonly kind: "refused"; readonly message: string };

const ROLE_IDS: readonly SetupRoleId[] = ["coordinator", "architect", "developer", "reviewer"];

export async function saveAgentTeamSelections(input: {
  readonly csrfToken: string;
  readonly projectId: string;
  readonly selections: Readonly<Record<SetupRoleId, ModelSelection>>;
  readonly currentBindings: readonly UpsertBindingInput[];
  /** The FILE's full set; when the file is not readable here, the caller
   * passes the loaded set lifted through loadedAsComboSource and sets
   * `mintable: false` (bind-only against existing combos). */
  readonly fileProfiles: readonly ProfileFullEntry[];
  /** The ids the RUNNING process loaded at startup (GET /api/v1/profiles). */
  readonly loadedProfileIds: readonly string[];
  /** false = no profiles file writable here → minting is refused (profileUpsert's own sentence). */
  readonly mintable?: boolean;
}): Promise<TeamSaveOutcome> {
  const plan = composeProfileUpsert({
    fileProfiles: input.fileProfiles,
    selections: ROLE_IDS.map((roleId) => ({ roleId, ...input.selections[roleId]! })),
    currentBindings: input.currentBindings,
    ...(input.mintable === false ? { mintable: false as const } : {})
  });
  if (plan.kind !== "ok") {
    return { kind: "refused", message: plan.message };
  }
  if (!plan.fileChanged && !plan.bindingsChanged) {
    return { kind: "no-change" };
  }
  if (plan.fileChanged) {
    // Write-guard, second belt (B1): the planner already asserts id
    // uniqueness, but the LAST thing between a duplicated id and the
    // server's unconstrained-at-parse frozen schema is THIS check — the PUT
    // never fires on a set that would brick the next serve start.
    const duplicateId = firstDuplicateProfileId(plan.nextFileProfiles);
    if (duplicateId !== null) {
      return { kind: "refused", message: duplicateProfileIdMessage(duplicateId) };
    }
    await putProfilesFull(input.csrfToken, profilesFileContent(plan.nextFileProfiles));
  }
  const pending = ROLE_IDS.filter((roleId) => !input.loadedProfileIds.includes(plan.targets[roleId]!));
  if (pending.length > 0) {
    return { kind: "bind-pending", addedCount: plan.addedProfiles.length };
  }
  await putRoleBindings(
    input.csrfToken,
    input.projectId,
    ROLE_IDS.map((roleId) => ({ roleId, profileId: plan.targets[roleId]! }))
  );
  return { kind: "bind-done", fileChanged: plan.fileChanged, addedCount: plan.addedProfiles.length };
}
