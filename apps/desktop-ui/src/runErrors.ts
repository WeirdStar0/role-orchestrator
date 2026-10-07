/**
 * M11-01 typed-refusal humanizer: POST /api/v1/runs refusals are the
 * server's fail-closed 400/422/503 envelopes (the UI layer only TRANSLATES
 * — validation itself stays server-side, per the M11-01 ask "工作目录等
 * 约束仍在服务端校验,如实透出人话"). Vocabulary aligned with the old
 * page's createRunFailureText so both faces of the product say the same
 * thing about the same refusal.
 */
import { ApiError } from "./api";

export function createRunFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return `创建失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { status, code, message } = error;
  if (status === 0) return message;
  switch (code) {
    case "PROJECT_DIR_NOT_ABSOLUTE":
      return "创建被拒(400):工作目录必须是绝对路径(例如 C:\\repo),当前填写不是绝对路径。";
    case "PROJECT_DIR_MISSING":
      return `创建被拒(400):工作目录不存在,请检查路径拼写。详情: ${message}`;
    case "PROJECT_DIR_NOT_GIT_REPOSITORY":
      return "创建被拒(400):工作目录必须是一个 git 仓库(目录存在但缺少 .git)。";
    case "ROLE_BINDINGS_INCOMPLETE":
      return "创建被拒(422):该项目的四个角色(coordinator/architect/developer/reviewer)还没有绑定完整。请先在旧配置页(/)的「项目角色绑定」完成绑定,再回来创建任务。";
    case "PROJECT_NOT_FOUND":
      return `创建被拒(404):还没有这个项目的记录(首次创建会登记项目)。详情: ${message}`;
    case "ORCHESTRATION_NOT_CONFIGURED":
      return "创建被拒(503):本服务进程没有接入编排(未传 --profiles)——请从桌面应用启动,或查看服务启动参数。";
    case "CSRF_REQUIRED":
    case "CSRF_INVALID":
    case "NOT_AUTHENTICATED":
      return "无法认证:本页在浏览器直开时没有会话凭据。请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    default:
      return `创建被拒(${String(status)}${code === "" ? "" : ` ${code}`}): ${message}`;
  }
}

/** Generic list-loading failure text (projects / history pages). */
export function loadFailureText(error: unknown): string {
  if (error instanceof ApiError && error.status === 0) return error.message;
  if (error instanceof ApiError && error.code === "NOT_AUTHENTICATED") return error.message;
  const status = error instanceof ApiError ? String(error.status) : "";
  const message = error instanceof Error ? error.message : String(error);
  return `加载失败${status === "" ? "" : `(${status})`}: ${message}`;
}
