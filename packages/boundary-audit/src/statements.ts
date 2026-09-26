/**
 * M7-04 boundary statements, pinned as data (same method as
 * remote-worker's TENANCY_BOUNDARY_STATEMENT): any consumer of this package
 * receives the boundary claims together with the data, and the test suite
 * pins every sentence verbatim, so rewording the claim is a code change
 * that must survive review.
 *
 * IMPORTANT HONESTY NOTE: these are DESIGN declarations. No commercial
 * edition exists in this repository; the A01/A02 statements below declare
 * obligations for a FUTURE commercial control plane, they are not evidence
 * of one existing.
 */

/**
 * The product boundary of docs/adr/009-open-core-and-license.md in one
 * sentence: the open local core stays fully open source; team
 * governance/collaboration/hosting productizes separately; commercial
 * dependencies must never enter the open core's startup or build path.
 */
export const COMMERCIAL_BOUNDARY_STATEMENT =
  "Open local core vs commercial control plane (docs/adr/009-open-core-and-license.md): " +
  "every package listed in OPEN_CORE_PACKAGE_MANIFEST is open-source local core; a workspace " +
  "package joins the commercial control plane ONLY by carrying the literal marker field " +
  '"commercial": true in its own package.json; commercial dependencies must not enter the ' +
  "open core's startup or build path.";

/**
 * A01 (single-select binding, docs/ACCEPTANCE.md) holds unchanged in the
 * commercial control plane: role-to-Profile binding stays single-select
 * through the SAME open-core authority.
 */
export const A01_COMMERCIAL_STATEMENT =
  "A01 single-select binding holds unchanged in the commercial control plane: every role - " +
  "including any role surfaced by a future commercial control plane - binds to exactly one " +
  "Profile through the same open-core authority (@role-orchestrator/runtime-profile " +
  "resolveRoleBinding plus dag plan-time resolution, whose five rejection kinds cover " +
  "missing/unbound/multiple/unknown-profile/unknown-revision before any startup step); a " +
  "commercial control plane MUST NOT ship an alternative profile-selection path, a second " +
  "binding authority, or any way to bind a role to zero or several Profiles.";

/**
 * A02 (override rejection, docs/ACCEPTANCE.md) holds unchanged in the
 * commercial control plane: model/Profile override injection stays refused
 * at every layer with the SAME closed vocabulary.
 */
export const A02_COMMERCIAL_STATEMENT =
  "A02 override rejection holds unchanged in the commercial control plane: model/Profile " +
  "override fields injected at Node/Task/Workflow level are refused at every layer (frozen " +
  "contract schema, API strict parse, UI) and the runtime no-override deep scan " +
  "(@role-orchestrator/runtime-profile FORBIDDEN_OVERRIDE_KEYS / NodeOverrideRejectedError) " +
  "applies to commercial control-plane inputs with the same closed key vocabulary; a " +
  "commercial extension can never relax, alias, or bypass the override guard, and no " +
  "commercial package may add a forbidden override key to any surface.";

/**
 * Mechanism-vs-existence disclosure carried by EVERY audit result and CLI
 * output, so the honesty boundary cannot be separated from the data.
 */
export const DESIGN_ONLY_DISCLOSURE =
  "Design-only disclosure (M7-04): NO commercial-edition code exists in this repository. " +
  "The commercial marker mechanism is exercised by fixtures only; an audit run against the " +
  "real repository is MECHANISM verification (the audit machinery works and currently finds " +
  "nothing because no commercial package exists), NOT existence verification.";
