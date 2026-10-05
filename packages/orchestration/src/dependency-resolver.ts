/**
 * M10-02 M5 (dependency-resolver) — the pure dependency-baseline rule.
 *
 * Moved from the e2e-baseline driver (packages/e2e-baseline/src/driver.ts:305,
 * `baselineFor`), generalized from a BaselineNodeSpec to a plain dependency
 * list so every pump can consume it without dragging test-fixture types into
 * this package. Semantics are the three copies' shared intent: walk the
 * dependencies BACKWARDS and take the nearest dependency that already has an
 * accepted output; with none (production's single "execute" node has no
 * dependencies at all) fall back to the run's frozen base commit. For the
 * M9-01 production graph this is mathematically exactly `run.baseSha` — the
 * step-1 production-parity invariant (恒 run.baseSha) holds by construction.
 *
 * Convergence of the three pump copies onto THIS export is M10-02 step 2;
 * this module only establishes the shared home.
 */

/** A dependency's accepted output (branch it was produced on + head commit). */
export interface AcceptedOutput {
  readonly branch: string;
  readonly headSha: string;
}

/** node id -> accepted output, as the pumps record them. */
export type AcceptedOutputs = ReadonlyMap<string, AcceptedOutput>;

/** Last dependency with an accepted output, else the run's base commit. */
export function baselineFor(
  dependencies: readonly string[],
  acceptedOutputs: AcceptedOutputs,
  baseSha: string
): string {
  for (let index = dependencies.length - 1; index >= 0; index -= 1) {
    const dep = dependencies[index];
    const output = dep === undefined ? undefined : acceptedOutputs.get(dep);
    if (output !== undefined) return output.headSha;
  }
  return baseSha;
}

/**
 * The parents of an integration node, in dependency order — the input set the
 * integration service single-writer-merges. A dependency without an accepted
 * output is a pump-contract violation (it could not have been READY).
 */
export function buildParents(
  nodeId: string,
  dependencies: readonly string[],
  acceptedOutputs: AcceptedOutputs
): { nodeId: string; branch: string; headSha: string }[] {
  return dependencies.map((dep) => {
    const output = acceptedOutputs.get(dep);
    if (output === undefined) {
      throw new Error(
        `integration node "${nodeId}" depends on "${dep}" which has no accepted output yet`
      );
    }
    return { nodeId: dep, branch: output.branch, headSha: output.headSha };
  });
}
