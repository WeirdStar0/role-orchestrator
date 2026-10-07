import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { createRunFailureText, firstRunFailureText, loadFailureText } from "./runErrors";

/** The typed server refusals surface as human sentences — coverage matches
 * exactly the refusals the create route can answer (see runErrors.ts header
 * for the precise vocabulary claim). */
describe("createRunFailureText (M11-01 服务端校验,人话透出;M11-02 vocabulary correction)", () => {
  it("maps every typed create refusal the route can answer", () => {
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_ABSOLUTE", "x"))).toContain("绝对路径");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_MISSING", "gone"))).toContain("工作目录不存在");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_DIRECTORY", "a file"))).toContain("不是一个目录");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_GIT_REPOSITORY", "x"))).toContain("git 仓库");
    expect(createRunFailureText(new ApiError(422, "ROLE_BINDINGS_INCOMPLETE", "x"))).toContain("四个角色");
    expect(createRunFailureText(new ApiError(422, "ROLE_BINDINGS_INCOMPLETE", "x"))).toContain("旧配置页");
    expect(createRunFailureText(new ApiError(503, "ORCHESTRATION_NOT_CONFIGURED", "x"))).toContain("--profiles");
    expect(createRunFailureText(new ApiError(403, "CSRF_REQUIRED", "x"))).toContain("无法认证");
    expect(createRunFailureText(new ApiError(403, "NOT_AUTHENTICATED", "no cred"))).toContain("浏览器直开");
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
