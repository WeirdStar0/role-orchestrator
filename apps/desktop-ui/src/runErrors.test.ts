import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import { createRunFailureText, loadFailureText } from "./runErrors";

/** The typed server refusals surface as human sentences (vocabulary aligned
 * with the old page's createRunFailureText). */
describe("createRunFailureText (M11-01: 服务端校验,人话透出)", () => {
  it("maps every typed create refusal the route can answer", () => {
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_ABSOLUTE", "x"))).toContain("绝对路径");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_MISSING", "gone"))).toContain("工作目录不存在");
    expect(createRunFailureText(new ApiError(400, "PROJECT_DIR_NOT_GIT_REPOSITORY", "x"))).toContain("git 仓库");
    expect(createRunFailureText(new ApiError(422, "ROLE_BINDINGS_INCOMPLETE", "x"))).toContain("四个角色");
    expect(createRunFailureText(new ApiError(422, "ROLE_BINDINGS_INCOMPLETE", "x"))).toContain("旧配置页");
    expect(createRunFailureText(new ApiError(404, "PROJECT_NOT_FOUND", "no row"))).toContain("404");
    expect(createRunFailureText(new ApiError(503, "ORCHESTRATION_NOT_CONFIGURED", "x"))).toContain("--profiles");
    expect(createRunFailureText(new ApiError(403, "CSRF_REQUIRED", "x"))).toContain("无法认证");
    expect(createRunFailureText(new ApiError(403, "NOT_AUTHENTICATED", "no cred"))).toContain("浏览器直开");
  });

  it("keeps unknown typed refusals honest (status + server message, no invention)", () => {
    const text = createRunFailureText(new ApiError(409, "SOME_FUTURE_CODE", "detail here"));
    expect(text).toContain("409");
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
