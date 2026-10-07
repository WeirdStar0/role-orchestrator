/**
 * M11-01 typed-refusal humanizer (M11-02 revision): POST /api/v1/runs
 * refusals are the server's fail-closed 400/422/409/503 envelopes (the UI
 * layer only TRANSLATES — validation itself stays server-side, per the
 * M11-01 ask "工作目录等约束仍在服务端校验,如实透出人话").
 *
 * Vocabulary claim, stated precisely (M11-02 review handover I): the typed
 * create refusals this translator covers are EXACTLY the ones the route can
 * answer — the four PROJECT_DIR_* gates, ROLE_BINDINGS_INCOMPLETE, the 409
 * profile-definition drift refusal and ORCHESTRATION_NOT_CONFIGURED — with
 * the same meanings the old page's createRunFailureText gives them (the
 * wording is this UI's own 人话, not a byte-copy). Run creation NEVER
 * answers 404 PROJECT_NOT_FOUND (a project row is found-or-created on the
 * creation path; that code lives on the role-bindings PUT surface), so
 * there is deliberately no such mapping here — the M11-01 file carried one
 * and it was dead. The browser-context auth sentences (the CSRF_* family
 * and NOT_AUTHENTICATED) and the first-run humanizer below are desktop-ui
 * additions the old page does not carry.
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
    case "PROJECT_DIR_NOT_DIRECTORY":
      return "创建被拒(400):填写的路径不是一个目录(可能是一个文件)。请填写项目仓库的目录路径。";
    case "PROJECT_DIR_NOT_GIT_REPOSITORY":
      return "创建被拒(400):工作目录必须是一个 git 仓库(目录存在但缺少 .git)。";
    case "ROLE_BINDINGS_INCOMPLETE":
      return "创建被拒(422):该项目的四个角色(coordinator/architect/developer/reviewer)还没有绑定完整。请先在旧配置页(/)的「项目角色绑定」完成绑定,再回来创建任务。";
    case "ORCHESTRATION_NOT_CONFIGURED":
      return "创建被拒(503):本服务进程没有接入编排(未传 --profiles)——请从桌面应用启动,或查看服务启动参数。";
    case "CSRF_REQUIRED":
    case "CSRF_INVALID":
    case "NOT_AUTHENTICATED":
      return "无法认证:本页在浏览器直开时没有会话凭据。请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    default:
      // The 409 drift refusal carries the drift-gate meaning; other unknown
      // codes surface verbatim (never invented into a wrong 人话).
      if (status === 409) {
        return `创建被拒(409):AI 配置与已有记录不一致(修改配置是人的决定,不会自动覆盖)。详情: ${message}`;
      }
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

/**
 * M11-02 first-run humanizer (POST /api/v1/setup/first-run refusals).
 * Human names only — the raw runtime ids (claude/codex) are translated to
 * the product names, and no internal identifier (profile id, source path)
 * ever reaches the copy.
 */
export function firstRunFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return `生成失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { status, code, message, details } = error;
  if (status === 0) return message;
  switch (code) {
    case "CLIS_NOT_FOUND": {
      const raw = Array.isArray(details["notFound"]) ? (details["notFound"] as unknown[]) : [];
      const misses = raw
        .filter((item): item is string => typeof item === "string")
        .map((item) => (item === "claude" ? "Claude Code" : item === "codex" ? "Codex" : item));
      const listed = misses.length > 0 ? misses.join(" 和 ") : "任何可用的 AI 命令行";
      return (
        `未能生成(${String(status)}):本机没有找到 ${listed}。` +
        "请先安装 Claude Code 或 Codex(或将其加入 PATH)后重试,或在旧工作台(/)的「配置」页手动配置;本次没有写入任何文件。"
      );
    }
    case "HOME_DIRECTORY_UNAVAILABLE":
      return (
        "未能生成(422):无法定位用户主目录(必要的系统环境变量缺失),自动配置需要它来定位 " +
        "CLI 的配置目录;本次没有写入任何文件。请检查系统环境变量后重试,或在旧工作台(/)手动配置。"
      );
    case "PROFILE_SOURCE_ABSENT":
      return (
        "未能生成(409):本服务进程没有接入 AI 配置文件(未传 --profiles),自动配置不知道该把文件写到" +
        "哪里,也不会自行发明位置。请从桌面应用启动后重试,或查看服务启动参数。"
      );
    case "PROFILES_ALREADY_CONFIGURED":
      return (
        "无需生成(409):检测到已有可用的 AI 配置,首启向导从不覆盖现有配置。" +
        "如需调整,请用旧工作台(/)的「配置」页。"
      );
    case "CSRF_REQUIRED":
    case "CSRF_INVALID":
    case "NOT_AUTHENTICATED":
      return "无法认证:本页在浏览器直开时没有会话凭据。请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    default:
      return `生成被拒(${String(status)}${code === "" ? "" : ` ${code}`}): ${message}`;
  }
}
