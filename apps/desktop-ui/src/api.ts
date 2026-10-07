/**
 * M11-01 API client for /app. Authentication is the DESKTOP SHELL's job
 * (ADR docs/adr/010-token-auto-session.md): the shell injects
 * `Authorization: Bearer …` on every request to 127.0.0.1:<serve port>, so
 * this client deliberately sends NO Authorization header and NEVER touches
 * or stores a token — the token stays invisible to this UI (and unreadable:
 * injected request headers are not observable from page JS).
 *
 * Outside the shell (plain browser) every /api call is refused by the
 * server's guard pipeline; refusals surface as explicit human states, never
 * as console noise (a 403 fetch logs nothing by itself).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function requestJson(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, "NETWORK_UNREACHABLE", "无法连接本地服务——请从桌面应用内使用,或确认服务已启动。");
  }
  if (!response.ok) {
    let code = "";
    let message = `HTTP ${String(response.status)}`;
    try {
      const body: unknown = await response.json();
      if (body !== null && typeof body === "object" && "error" in body) {
        const error = (body as { error: { code?: unknown; message?: unknown } }).error;
        if (typeof error.code === "string") code = error.code;
        if (typeof error.message === "string") message = error.message;
      }
    } catch {
      // keep the HTTP status fallback
    }
    if (response.status === 403 && code === "") {
      code = "NOT_AUTHENTICATED";
      message = "本页在浏览器直开时没有会话凭据;请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    }
    throw new ApiError(response.status, code, message);
  }
  try {
    return (await response.json()) as unknown;
  } catch {
    throw new ApiError(response.status, "BAD_BODY", "服务返回了无法解析的内容。");
  }
}

/** The session-bound CSRF token mutating requests must echo back (ADR 010: the
 * probe carries NO local token — authentication is the shell's injection). */
export async function fetchCsrfToken(): Promise<string | null> {
  const body = (await requestJson("/api/v1/session")) as { csrfToken?: unknown };
  return typeof body.csrfToken === "string" && body.csrfToken !== "" ? body.csrfToken : null;
}

export interface ProjectSummary {
  readonly repoRoot: string;
  readonly createdAt: string;
}

export async function fetchProjects(): Promise<readonly ProjectSummary[]> {
  const body = (await requestJson("/api/v1/projects")) as { projects?: unknown };
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const parsed: ProjectSummary[] = [];
  for (const item of projects) {
    if (item !== null && typeof item === "object") {
      const row = item as { repoRoot?: unknown; createdAt?: unknown };
      if (typeof row.repoRoot === "string" && typeof row.createdAt === "string") {
        parsed.push({ repoRoot: row.repoRoot, createdAt: row.createdAt });
      }
    }
  }
  return parsed;
}

export interface RunSummary {
  readonly id: string;
  readonly objective: string | null;
  readonly status: string;
  readonly outcome: string | null;
  readonly createdAt: string;
}

export async function fetchRuns(): Promise<readonly RunSummary[]> {
  const body = (await requestJson("/api/v1/runs")) as { runs?: unknown };
  const runs = Array.isArray(body.runs) ? body.runs : [];
  const parsed: RunSummary[] = [];
  for (const item of runs) {
    if (item !== null && typeof item === "object") {
      const row = item as Record<string, unknown>;
      if (
        typeof row["id"] === "string" &&
        typeof row["status"] === "string" &&
        typeof row["createdAt"] === "string"
      ) {
        parsed.push({
          id: row["id"],
          objective: typeof row["objective"] === "string" ? row["objective"] : null,
          status: row["status"],
          outcome: typeof row["outcome"] === "string" ? row["outcome"] : null,
          createdAt: row["createdAt"]
        });
      }
    }
  }
  return parsed;
}

/** The create body is the EXACT allowlist POST /api/v1/runs accepts —
 * objective + projectDir, nothing else (A02: no model/Profile carriers). */
export interface CreateRunInput {
  readonly objective: string;
  readonly projectDir: string;
}

export async function createRun(csrfToken: string, input: CreateRunInput): Promise<string> {
  const body = (await requestJson("/api/v1/runs", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ objective: input.objective, projectDir: input.projectDir })
  })) as { runId?: unknown };
  if (typeof body.runId !== "string" || body.runId === "") {
    throw new ApiError(500, "BAD_BODY", "服务接受了任务,但没有返回任务标识。");
  }
  return body.runId;
}
