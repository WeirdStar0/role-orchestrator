import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  bindingFailureText,
  createRunFailureText,
  firstRunFailureText,
  loadFailureText,
  notFoundMissNames,
  registerFailureText
} from "./runErrors";

/** The typed server refusals surface as human sentences — the dedicated
 * sentences cover the typed carriers with stable product meaning (see
 * runErrors.ts header for the exact vocabulary claim, quantifier made
 * precise in M11-04: shape-level INPUT_REJECTED deliberately falls to the
 * honest default arm instead of a dedicated sentence). */
describe("createRunFailureText (M11-01 服务端校验,人话透出;M11-03 binding guidance)", () => {
  it("maps the typed create refusals that carry dedicated sentences", () => {
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_ABSOLUTE", "x"))).toContain("绝对路径");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_MISSING", "gone"))).toContain("工作目录不存在");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_DIRECTORY", "a file"))).toContain("不是一个目录");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_GIT_REPOSITORY", "x"))).toContain("git 仓库");
    expect(createRunFailureText(new ApiError(422, "ROLE_BINDINGS_INCOMPLETE", "x"))).toContain("四个角色");
    expect(createRunFailureText(new ApiError(503, "ORCHESTRATION_NOT_CONFIGURED", "x"))).toContain("--profiles");
    expect(createRunFailureText(new ApiError(403, "CSRF_REQUIRED", "x"))).toContain("无法认证");
    expect(createRunFailureText(new ApiError(403, "NOT_AUTHENTICATED", "no cred"))).toContain("浏览器直开");
  });

  it("M11-04: each WORKFLOW_* declaration carrier gets its own human sentence stating nothing was created", () => {
    // WORKFLOW_NODES_OUT_OF_BUDGET is UNREACHABLE through the product UI
    // (the wizard's preflight blocks an over-budget draft before submit —
    // the runErrors.ts disclosure): the arm is pinned here with a
    // FABRICATED carrier so it stays honest should a future carrier path
    // or a direct API caller land on it.
    const sentences = [
      createRunFailureText(new ApiError(400, "WORKFLOW_NODES_OUT_OF_BUDGET", "workflow.nodes must carry 1..64 nodes, got 65")),
      createRunFailureText(new ApiError(400, "WORKFLOW_DUPLICATE_NODE_ID", "duplicate")),
      createRunFailureText(new ApiError(400, "WORKFLOW_SELF_DEPENDENCY", "self")),
      createRunFailureText(new ApiError(400, "WORKFLOW_UNKNOWN_DEPENDENCY", "unknown dep")),
      createRunFailureText(new ApiError(400, "WORKFLOW_INTEGRATION_WITHOUT_PARENTS", "no parents")),
      createRunFailureText(new ApiError(400, "WORKFLOW_REVIEW_DEPENDENCY_COUNT", "two deps")),
      createRunFailureText(new ApiError(400, "WORKFLOW_REVIEW_ROLE", "developer role")),
      createRunFailureText(new ApiError(400, "WORKFLOW_INTEGRATION_NODE_COUNT", "two integrations")),
      createRunFailureText(new ApiError(400, "WORKFLOW_GRAPH_INVALID", "missing dependency"))
    ];
    for (const sentence of sentences) {
      expect(sentence).toContain("创建被拒(400)");
      expect(sentence).toContain("本次没有创建任务");
    }
    // Each sentence is distinct enough to name its own shape (the nine
    // carriers are nine different operator mistakes).
    expect(new Set(sentences).size).toBe(9);
    expect(sentences[0]).toContain("64");
    expect(sentences[4]).toContain("集成节点");
    expect(sentences[5]).toContain("只能依赖一个");
    expect(sentences[6]).toContain("「评审」");
    expect(sentences[7]).toContain("每任务支持一个集成节点");
  });

  it("M11-04: the GRAPH_INVALID cycle shape gets the cycle-specific sentence and keeps the server detail", () => {
    const cycle = createRunFailureText(
      new ApiError(400, "WORKFLOW_GRAPH_INVALID", "dependency cycle detected: node-a -> node-b -> node-a; graphs must stay acyclic")
    );
    expect(cycle).toContain("依赖关系形成了环");
    expect(cycle).toContain("本次没有创建任务");
    // The exact path stays available as the detail (never swallowed).
    expect(cycle).toContain("node-a -> node-b -> node-a");
    // A non-cycle dag refusal keeps the honest generic arm (detail verbatim).
    const missing = createRunFailureText(new ApiError(400, "WORKFLOW_GRAPH_INVALID", "missing dependency \"x\""));
    expect(missing).toContain("任务结构未通过校验");
    expect(missing).toContain("missing dependency");
    expect(missing).toContain("本次没有创建任务");
  });

  it("M11-04: the shape-level INPUT_REJECTED refusal falls to the honest default (no invented 人话)", () => {
    const text = createRunFailureText(new ApiError(400, "INPUT_REJECTED", "objective must be a string"));
    expect(text).toContain("INPUT_REJECTED");
    expect(text).toContain("objective must be a string");
  });

  it("M11-03: the binding-incomplete sentence points at the wizard's OWN binding step (the old 配置页 pointer is gone)", () => {
    const text = createRunFailureText(new ApiError(422, "ROLE_BINDINGS_INCOMPLETE", "x"));
    expect(text).toContain("角色绑定");
    expect(text).toContain("没有创建任务");
    // M11-03 moved the binding surface into the wizard; the stale pointer to
    // the old page must not resurface here.
    expect(text).not.toContain("旧配置页");
  });

  it("the 409 drift refusal gets the drift sentence (review handover I: vocabulary completion)", () => {
    const text = createRunFailureText(new ApiError(409, "PROFILE_DEFINITION_CONFLICT", "drift"));
    expect(text).toContain("409");
    expect(text).toContain("不会自动覆盖");
    expect(text).toContain("drift");
  });

  it("carries NO dedicated PROJECT_NOT_FOUND mapping (dead mapping removed in M11-02): an unexpected 404 falls to the honest generic line", () => {
    const text = createRunFailureText(new ApiError(404, "PROJECT_NOT_FOUND", "no row"));
    expect(text).toContain("404");
    expect(text).toContain("no row");
    // The M11-01 dedicated sentence is gone — run creation never answers this.
    expect(text).not.toContain("还没有这个项目的记录");
  });

  it("keeps unknown typed refusals honest (status + server message, no invention)", () => {
    const text = createRunFailureText(new ApiError(418, "SOME_FUTURE_CODE", "detail here"));
    expect(text).toContain("418");
    expect(text).toContain("SOME_FUTURE_CODE");
    expect(text).toContain("detail here");
  });

  it("network-level failures speak the offline sentence", () => {
    expect(createRunFailureText(new ApiError(0, "NETWORK_UNREACHABLE", "无法连接本地服务"))).toContain(
      "无法连接本地服务"
    );
    expect(loadFailureText(new ApiError(0, "NETWORK_UNREACHABLE", "无法连接本地服务——请从桌面应用内使用"))).toContain(
      "桌面应用"
    );
    expect(loadFailureText(new Error("boom"))).toContain("boom");
  });
});

describe("firstRunFailureText (M11-02 首启向导人话)", () => {
  it("CLIS_NOT_FOUND names the misses in product words, never raw ids", () => {
    const text = firstRunFailureText(
      new ApiError(422, "CLIS_NOT_FOUND", "neither CLI was found", { notFound: ["claude", "codex"] })
    );
    expect(text).toContain("没有找到 Claude Code 和 Codex");
    expect(text).not.toContain('"claude"');
    expect(text).toContain("没有写入任何文件");
  });

  it("the other typed first-run refusals each get their honest sentence", () => {
    expect(firstRunFailureText(new ApiError(409, "PROFILE_SOURCE_ABSENT", "no wiring"))).toContain("--profiles");
    expect(firstRunFailureText(new ApiError(409, "PROFILE_SOURCE_ABSENT", "no wiring"))).toContain("不会自行发明");
    expect(firstRunFailureText(new ApiError(422, "HOME_DIRECTORY_UNAVAILABLE", "no home"))).toContain("主目录");
    expect(firstRunFailureText(new ApiError(409, "PROFILES_ALREADY_CONFIGURED", "already"))).toContain("从不覆盖");
    expect(firstRunFailureText(new ApiError(403, "CSRF_REQUIRED", "x"))).toContain("无法认证");
  });

  it("unknown codes and network faults stay honest", () => {
    const text = firstRunFailureText(new ApiError(500, "INTERNAL", "boom"));
    expect(text).toContain("500");
    expect(text).toContain("boom");
    expect(firstRunFailureText(new ApiError(0, "NETWORK_UNREACHABLE", "无法连接本地服务"))).toContain("无法连接本地服务");
    expect(firstRunFailureText(new Error("plain"))).toContain("plain");
  });
});

describe("notFoundMissNames (M11-02 review handover B: extraction-site translation)", () => {
  it("translates the raw runtime ids to product names, matching the main message", () => {
    const error = new ApiError(422, "CLIS_NOT_FOUND", "neither CLI", { notFound: ["claude", "codex"] });
    expect(notFoundMissNames(error)).toEqual(["Claude Code", "Codex"]);
  });

  it("unknown entries pass through verbatim; non-ApiError / missing detail yield an empty list", () => {
    expect(notFoundMissNames(new ApiError(422, "CLIS_NOT_FOUND", "x", { notFound: ["future-cli", "codex"] }))).toEqual([
      "future-cli",
      "Codex"
    ]);
    expect(notFoundMissNames(new ApiError(409, "OTHER", "x"))).toEqual([]);
    expect(notFoundMissNames(new Error("plain"))).toEqual([]);
    // A non-string detail array is filtered, never rendered.
    expect(notFoundMissNames(new ApiError(422, "CLIS_NOT_FOUND", "x", { notFound: [1, null] }))).toEqual([]);
  });
});

describe("registerFailureText (M11-03 项目登记人话:四道门各得一句)", () => {
  it("maps the four fail-closed directory gates, each stating nothing was written", () => {
    expect(registerFailureText(new ApiError(400, "PROJECT_DIR_NOT_ABSOLUTE", "x"))).toContain("绝对路径");
    expect(registerFailureText(new ApiError(400, "PROJECT_DIR_MISSING", "gone"))).toContain("目录不存在");
    expect(registerFailureText(new ApiError(400, "PROJECT_DIR_NOT_DIRECTORY", "a file"))).toContain("不是一个目录");
    expect(registerFailureText(new ApiError(400, "PROJECT_DIR_NOT_GIT_REPOSITORY", "x"))).toContain("git 仓库");
    for (const code of ["PROJECT_DIR_NOT_ABSOLUTE", "PROJECT_DIR_MISSING", "PROJECT_DIR_NOT_DIRECTORY", "PROJECT_DIR_NOT_GIT_REPOSITORY"]) {
      expect(registerFailureText(new ApiError(400, code, "x"))).toContain("没有写入任何内容");
    }
  });

  it("auth and unknown codes stay honest", () => {
    expect(registerFailureText(new ApiError(403, "NOT_AUTHENTICATED", "x"))).toContain("浏览器直开");
    const text = registerFailureText(new ApiError(418, "FUTURE", "detail"));
    expect(text).toContain("418");
    expect(text).toContain("detail");
  });
});

describe("bindingFailureText (M11-03 绑定人话:事务式写面的拒绝族)", () => {
  it("maps the typed binding refusals, each stating the write did not land", () => {
    expect(bindingFailureText(new ApiError(422, "UNKNOWN_PROFILE", "x"))).toContain("已载入");
    expect(bindingFailureText(new ApiError(422, "EXECUTION_TARGET_MISMATCH", "x"))).toContain("平台不一致");
    expect(bindingFailureText(new ApiError(409, "PROFILE_DEFINITION_CONFLICT", "x"))).toContain("不会自动覆盖");
    expect(bindingFailureText(new ApiError(404, "PROJECT_NOT_FOUND", "x"))).toContain("重新登记");
    expect(bindingFailureText(new ApiError(503, "ORCHESTRATION_NOT_CONFIGURED", "x"))).toContain("--profiles");
    for (const error of [
      new ApiError(422, "UNKNOWN_PROFILE", "x"),
      new ApiError(422, "EXECUTION_TARGET_MISMATCH", "x"),
      new ApiError(409, "PROFILE_DEFINITION_CONFLICT", "x"),
      new ApiError(404, "PROJECT_NOT_FOUND", "x")
    ]) {
      expect(bindingFailureText(error)).toContain("没有写入");
    }
  });

  it("unknown codes stay honest", () => {
    const text = bindingFailureText(new ApiError(418, "FUTURE", "detail"));
    expect(text).toContain("418");
    expect(text).toContain("detail");
  });
});
