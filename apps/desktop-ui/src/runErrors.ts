/**
 * M11-01 typed-refusal humanizer (M11-02 revision, M11-03 extension, M11-04
 * WORKFLOW_* family): the POST /api/v1/runs / POST /api/v1/projects / PUT
 * role-bindings refusals are the server's fail-closed 400/422/409/503
 * envelopes (the UI layer only TRANSLATES — validation itself stays
 * server-side, per the M11-01 ask "工作目录等约束仍在服务端校验,如实透出人话").
 *
 * Vocabulary claim, stated precisely (M11-02 review handover I, quantifier
 * made exact in M11-04 review handover ⑦; the "cross-field" parenthesis
 * itself made precise in M11-05): the create-route refusals that get a
 * DEDICATED sentence are exactly the typed carriers with a stable product
 * meaning — the four PROJECT_DIR_* gates, ROLE_BINDINGS_INCOMPLETE, the
 * nine WORKFLOW_* declaration carriers (multi-node.ts's declaration gates +
 * run-creation.ts's dag wrapper, M11-04 — and NOT all of them are
 * cross-field: the budget and duplicate-id checks are SET-level, the
 * self-dependency check is PER-NODE, and only the dependency/integration/
 * review-shape rules are genuinely cross-node), the 409 profile-definition
 * drift refusal and ORCHESTRATION_NOT_CONFIGURED — with the same meanings
 * the old page's createRunFailureText gives them where it had one (the
 * wording is this UI's own 人话, not a byte-copy). Shape-level refusals
 * (400 INPUT_REJECTED: malformed JSON / wrong fields) and anything future
 * deliberately fall through the honest default arm — status + code + the
 * server's own message, never invented into a wrong 人话. Run creation
 * NEVER answers 404 PROJECT_NOT_FOUND (a project row is found-or-created on
 * the creation path; that code lives on the role-bindings PUT surface), so
 * there is deliberately no such mapping HERE — it lives in the M11-03
 * binding humanizer below, whose route can answer it. The browser-context
 * auth sentences (the CSRF_* family and NOT_AUTHENTICATED) and the
 * first-run humanizer below are desktop-ui additions the old page does not
 * carry.
 */
import { ApiError } from "./api";

/**
 * M11-03 shared extraction of the first-run refusal's `notFound` detail
 * (M11-02 review handover B): the raw runtime ids are translated to the
 * product names SO THAT the miss list reads exactly like the main refusal
 * message (which has always translated them). Unknown entries pass through
 * verbatim — never invented into a wrong name.
 */
export function notFoundMissNames(error: unknown): readonly string[] {
  if (!(error instanceof ApiError) || !Array.isArray(error.details["notFound"])) {
    return [];
  }
  return (error.details["notFound"] as unknown[])
    .filter((item): item is string => typeof item === "string")
    .map((item) => (item === "claude" ? "Claude Code" : item === "codex" ? "Codex" : item));
}

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
      return "创建被拒(422):该项目的四个角色还没有绑定完整(绑定不齐时创建必然被拒,不会创建出半个任务)。请在上方「角色绑定」步骤完成四角色绑定后重试;本次没有创建任务。";
    // M11-04 (review handover ⑦): the WORKFLOW_* declaration-refusal family —
    // the server's typed 400 carriers for a multi-node workflow (multi-node.ts
    // validateWorkflowSpecs + run-creation.ts's dag wrapper). The wizard's
    // 人话预检 catches the common shapes before the round trip; the server
    // stays the authority, and a refusal that DOES arrive reads as a sentence
    // instead of the raw English carrier. Every sentence states the run was
    // not created.
    case "WORKFLOW_NODES_OUT_OF_BUDGET":
      // M11-05 不可达披露: through the product UI this carrier CANNOT arrive
      // — the wizard's 人话预检 (workflowDraft.ts, WORKFLOW_NODE_BUDGET = 64)
      // refuses an over-budget draft before submit (NewTaskPage.submit never
      // posts while draft problems exist), and the wizard is the only
      // workflow-submitting surface. The sentence stays as the honest
      // belt-and-braces arm: the server remains the authority (multi-node.ts
      // re-checks the budget), a future carrier path or a direct API caller
      // would land here, and the arm is pinned by a fabricated-carrier test
      // rather than deleted on a reachability claim.
      return `创建被拒(400):多节点工作流的节点数超出上限(一个任务最多 64 个节点)。请精简节点后重试;本次没有创建任务。详情: ${message}`;
    case "WORKFLOW_DUPLICATE_NODE_ID":
      return "创建被拒(400):多节点工作流里有重复的节点标识。请调整后重试;本次没有创建任务。";
    case "WORKFLOW_SELF_DEPENDENCY":
      return "创建被拒(400):有节点依赖了它自己(节点不能把自身设为前置)。请调整该节点的依赖后重试;本次没有创建任务。";
    case "WORKFLOW_UNKNOWN_DEPENDENCY":
      return "创建被拒(400):有节点依赖了一个不存在的节点(依赖必须是本工作流里声明的节点)。请调整依赖后重试;本次没有创建任务。";
    case "WORKFLOW_INTEGRATION_WITHOUT_PARENTS":
      return "创建被拒(400):集成节点至少要依赖一个其他节点(它是来合并其他节点成果的)。请为集成节点勾选依赖后重试;本次没有创建任务。";
    case "WORKFLOW_REVIEW_DEPENDENCY_COUNT":
      return "创建被拒(400):评审节点必须且只能依赖一个节点(它评审那个节点的成果)。请调整评审节点的依赖后重试;本次没有创建任务。";
    case "WORKFLOW_REVIEW_ROLE":
      return "创建被拒(400):评审节点的角色必须是「评审」。请调整后重试;本次没有创建任务。";
    case "WORKFLOW_INTEGRATION_NODE_COUNT":
      return "创建被拒(400):当前版本每任务支持一个集成节点;链式/并行集成将在后续版本支持。请改为单集成节点的结构后重试;本次没有创建任务。";
    case "WORKFLOW_GRAPH_INVALID": {
      // The dag wrapper's message names the concrete refusal; the cycle shape
      // gets its own sentence (the ask's cycle-specific line) — matched on the
      // server's own DependencyCycleError wording, with the server message
      // kept as the 详情 so the exact node path stays available.
      if (message.includes("dependency cycle detected")) {
        return `创建被拒(400):节点的依赖关系形成了环(任务结构必须无环)。请去掉互为前置的依赖后重试;本次没有创建任务。详情: ${message}`;
      }
      return `创建被拒(400):任务结构未通过校验。详情: ${message};本次没有创建任务。`;
    }
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

/**
 * M11-03 project-registration humanizer (POST /api/v1/projects refusals).
 * The four directory gates get their own dedicated sentences (the same
 * meanings the run-creation humanizer gives them, worded for 登记); a
 * refusal NEVER wrote anything — every sentence says so.
 */
export function registerFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return `登记失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { status, code, message } = error;
  if (status === 0) return message;
  switch (code) {
    case "PROJECT_DIR_NOT_ABSOLUTE":
      return "登记被拒(400):目录路径必须是绝对路径(例如 C:\\repo 或 /home/me/repo),当前填写不是绝对路径;本次没有写入任何内容。";
    case "PROJECT_DIR_MISSING":
      return `登记被拒(400):这个目录不存在(或无法访问),请检查路径拼写;本次没有写入任何内容。详情: ${message}`;
    case "PROJECT_DIR_NOT_DIRECTORY":
      return "登记被拒(400):填写的路径不是一个目录(可能是一个文件)。请填写项目仓库的文件夹路径;本次没有写入任何内容。";
    case "PROJECT_DIR_NOT_GIT_REPOSITORY":
      return "登记被拒(400):这个目录不是一个 git 仓库(缺少可解析的 git 基线,通常是还没有 git init 或没有提交)。任务需要 git 仓库才能安全隔离执行;本次没有写入任何内容。";
    case "CSRF_REQUIRED":
    case "CSRF_INVALID":
    case "NOT_AUTHENTICATED":
      return "无法认证:本页在浏览器直开时没有会话凭据。请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    default:
      return `登记被拒(${String(status)}${code === "" ? "" : ` ${code}`}): ${message}`;
  }
}

/**
 * M11-03 approval-decision humanizer (POST /api/v1/approvals/:id/decision
 * refusals) — a decision never executes the action; every refusal below left
 * the approval exactly as it was.
 */
export function approvalDecisionFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return `审批失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { status, code, message } = error;
  if (status === 0) return message;
  switch (code) {
    case "APPROVAL_INVALIDATED":
      return "审批无效(409):这条审批已被处理过,或它绑定的候选产物已经变化(审批绑定精确内容,不随内容漂移)。请刷新后查看最新状态;本次没有产生任何效果。";
    case "APPROVAL_EXPIRED":
      return "审批已过期(409):这条审批超时失效,请刷新查看;本次没有产生任何效果。";
    case "CSRF_REQUIRED":
    case "CSRF_INVALID":
    case "NOT_AUTHENTICATED":
      return "无法认证:本页在浏览器直开时没有会话凭据。请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    default:
      return `审批被拒(${String(status)}${code === "" ? "" : ` ${code}`}): ${message}`;
  }
}

/**
 * M11-03 binding humanizer (PUT /api/v1/projects/:id/role-bindings
 * refusals) — the write is transactional, so every refusal below left the
 * project's previous bindings untouched.
 */
export function bindingFailureText(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return `绑定失败: ${error instanceof Error ? error.message : String(error)}`;
  }
  const { status, code, message } = error;
  if (status === 0) return message;
  switch (code) {
    case "UNKNOWN_PROFILE":
      return "绑定被拒(422):所选的 AI 配置不在本服务已载入的配置之列(配置文件可能刚改过还没重启)。请重启桌面应用后再试;本次绑定没有写入。";
    case "EXECUTION_TARGET_MISMATCH":
      return "绑定被拒(422):所选 AI 配置的运行平台与这个项目的平台不一致(例如为 WSL 准备的配置不能绑定到 Windows 项目)。请选择与本机平台一致的配置;本次绑定没有写入。";
    case "PROFILE_DEFINITION_CONFLICT":
      return "绑定被拒(409):所选 AI 配置与已有记录不一致(同名但定义不同;修改配置是人的决定,不会自动覆盖)。请先在旧工作台(/)的「配置」页核对后重试;本次绑定没有写入。";
    case "PROJECT_NOT_FOUND":
      return "绑定被拒(404):这个项目记录在服务端不存在了(可能已被清理)。请回到项目页重新登记后重试;本次绑定没有写入。";
    case "ORCHESTRATION_NOT_CONFIGURED":
      return "绑定被拒(503):本服务进程没有接入编排(未传 --profiles),没有可绑定的 AI 配置——请从桌面应用启动,或查看服务启动参数。";
    case "CSRF_REQUIRED":
    case "CSRF_INVALID":
    case "NOT_AUTHENTICATED":
      return "无法认证:本页在浏览器直开时没有会话凭据。请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    default:
      return `绑定被拒(${String(status)}${code === "" ? "" : ` ${code}`}): ${message}`;
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
