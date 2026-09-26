/**
 * @role-orchestrator/contracts — public entry point.
 *
 * Two layers live here:
 *  1. `./runtime.js` — the interfaces migrated verbatim from the planning
 *     bundle's contracts/runtime.ts (types only, no runtime behavior).
 *  2. `./schema/` — Zod schemas mirroring the seven frozen JSON Schemas, plus
 *     the compile-time assertions that keep both layers from drifting apart.
 *
 * Static types do not replace runtime validation; every input crossing a trust
 * boundary must still go through the Zod schemas. See README.md for the
 * anti-drift mechanism and its documented boundaries.
 */
export * from "./runtime.js";
export * from "./schema/index.js";
