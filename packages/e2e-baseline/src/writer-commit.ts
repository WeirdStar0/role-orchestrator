/**
 * The node output commit — the benchmark stand-in for the controlled Git
 * Service's commit step (docs/GIT_AND_WORKSPACES.md 提交与集成: path checks +
 * "仅提交允许的文件").
 *
 * NOT product logic: the fake-cli scenarios emit synthetic event streams and
 * intentionally never write repository files, so the driver — not the
 * product — applies the scenario's declared file set to the node's execution
 * worktree and commits EXACTLY those paths (the engine's stdin prompt file and
 * anything else stay uncommitted). Commit identity is fixed (author/committer/
 * date), so identical content produces identical SHAs across independent
 * worlds — the anchor of the repeatability assertion.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitRunner } from "@role-orchestrator/worktree";
import { BaselineDriverError } from "./errors.js";

export const BASELINE_COMMIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_AUTHOR_NAME: "role-orchestrator-e2e-baseline",
  GIT_AUTHOR_EMAIL: "e2e-baseline@role-orchestrator.invalid",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+00:00",
  GIT_COMMITTER_NAME: "role-orchestrator-e2e-baseline",
  GIT_COMMITTER_EMAIL: "e2e-baseline@role-orchestrator.invalid",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+00:00"
});

/**
 * Write exactly the declared files into the worktree, stage exactly those
 * paths, commit with the fixed identity and return the new HEAD (40-hex).
 * Any git failure surfaces as a typed driver error with the raw cause.
 */
export async function commitNodeOutput(
  git: GitRunner,
  input: {
    readonly worktreePath: string;
    readonly files: Readonly<Record<string, string>>;
    readonly message: string;
  }
): Promise<string> {
  const relativePaths = Object.keys(input.files);
  if (relativePaths.length === 0) {
    throw new BaselineDriverError(
      `writer commit at ${input.worktreePath} has an empty file set`,
      "writer node declares no files"
    );
  }
  for (const [relativePath, content] of Object.entries(input.files)) {
    const absolute = path.join(input.worktreePath, ...relativePath.split("/"));
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, "utf8");
  }
  await git.run(input.worktreePath, ["add", ...relativePaths]);
  await git.run(input.worktreePath, ["commit", "-m", input.message], {
    env: { ...BASELINE_COMMIT_ENV }
  });
  const head = await git.run(input.worktreePath, ["rev-parse", "HEAD"]);
  return head.stdout.trim();
}
