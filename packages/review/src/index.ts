/**
 * @role-orchestrator/review — public entry point (M2-05).
 *
 * Fixed-SHA review with a disposable validation workspace
 * (docs/GIT_AND_WORKSPACES.md 读者与测试, ACCEPTANCE A12/A13):
 *  - `openReviewSession` — a DETACHED, read-only baseline worktree at the
 *    immutable candidateSha plus a per-file content manifest bound to the
 *    commit's tracked tree, and a verified one-shot workspace copy where
 *    test processes may write;
 *  - `runValidationCommand` / `recordValidationArtifact` — evidence
 *    registration for the session; commands run ONLY inside the workspace;
 *  - `assertBaselineInvariance` — the A13 gate: per-file sha256 of the
 *    reviewed source must still equal the pinned candidate content, any
 *    drift invalidates the review (typed `ReviewBaselineDriftError`);
 *  - `completeReview` / `invalidateReviewSession` — guarded terminal
 *    transitions persisting the verdict/evidence (migration 006);
 *  - `getReviewVerdict` — the A12 query: a verdict answers ONLY for its own
 *    exact candidateSha; a changed candidate is answered `invalidated`, so
 *    an old pass never applies to a new candidate.
 *
 * Verdict/evidence reuse contracts' `ReviewSchema` / `ArtifactRefSchema`
 * semantics — no second definition of the review payload exists.
 *
 * See README.md for the protocol, the candidateSha binding semantics, the
 * validation workspace lifecycle and the known boundaries.
 */
export * from "./errors.js";
export * from "./baseline.js";
export * from "./workspace.js";
export * from "./record.js";
export * from "./session.js";
