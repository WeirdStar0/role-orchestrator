/**
 * M11-01 API client for /app. Authentication is the DESKTOP SHELL's job
 * (ADR docs/adr/010-token-auto-session.md): the shell injects
 * `Authorization: Bearer …` on every request to 127.0.0.1:<serve port>, so
 * this client deliberately sends NO Authorization header and NEVER touches
 * or stores a token — the token stays invisible to this UI (and unreadable:
 * injected request headers are not observable from page JS).
 *
 * Outside the shell (plain browser) every /api call is refused by the
 * server's guard pipeline; refusals surface as explicit human states. Page
 * code itself logs nothing to the console — the only console entry a
 * refused fetch can produce is the browser's OWN network-level annotation
 * (Chromium: "Failed to load resource: … 403"), which is browser noise, not
 * page output (the /app smoke pins exactly that distinction).
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  /** Structured context the server rides BESIDE the error envelope
   * (e.g. `notFound` on the first-run CLIS_NOT_FOUND refusal). Never a
   * credential; the humanizers translate the fields they know. */
  readonly details: Readonly<Record<string, unknown>>;

  constructor(status: number, code: string, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
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
    let details: Readonly<Record<string, unknown>> = {};
    try {
      const body: unknown = await response.json();
      if (body !== null && typeof body === "object" && !Array.isArray(body)) {
        const record = body as Record<string, unknown>;
        const error = record["error"];
        if (error !== null && typeof error === "object" && !Array.isArray(error)) {
          const envelope = error as { code?: unknown; message?: unknown };
          if (typeof envelope.code === "string") code = envelope.code;
          if (typeof envelope.message === "string") message = envelope.message;
        }
        // Everything beside the envelope is structured detail (M11-02
        // first-run's notFound etc.).
        const extra: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
          if (key !== "error") extra[key] = value;
        }
        details = extra;
      }
    } catch {
      // keep the HTTP status fallback
    }
    if (response.status === 403 && code === "") {
      code = "NOT_AUTHENTICATED";
      message = "本页在浏览器直开时没有会话凭据;请在桌面应用内使用,或在旧页面(/)以令牌登录。";
    }
    throw new ApiError(response.status, code, message, details);
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

// ---------------------------------------------------------------------------
// M11-02 首启零配置: the setup surface (GET /api/v1/setup/status,
// POST /api/v1/setup/first-run). The client projects the endpoint's
// zod-pinned shape down to exactly what the wizard renders — no internal
// identifiers (no profile ids, no source paths) ever reach component state.
// ---------------------------------------------------------------------------

/** The profiles file state, verbatim from the endpoint (four frozen values). */
export type SetupFileState = "unwired" | "absent" | "unparseable" | "configured";

export interface SetupStatus {
  readonly claudeFound: boolean;
  readonly codexFound: boolean;
  readonly profiles: {
    readonly fileState: SetupFileState;
    readonly usableProfiles: number;
    readonly loadedProfiles: number;
  };
}

const FILE_STATES: readonly SetupFileState[] = ["unwired", "absent", "unparseable", "configured"];

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const body = (await requestJson("/api/v1/setup/status")) as {
    clis?: unknown;
    profiles?: unknown;
  };
  const clis = (body.clis ?? null) as { claude?: { found?: unknown }; codex?: { found?: unknown } } | null;
  const profiles = (body.profiles ?? null) as {
    fileState?: unknown;
    usableProfiles?: unknown;
    loadedProfiles?: unknown;
  } | null;
  const fileState = profiles?.fileState;
  if (
    clis === null ||
    profiles === null ||
    typeof clis.claude?.found !== "boolean" ||
    typeof clis.codex?.found !== "boolean" ||
    typeof fileState !== "string" ||
    !FILE_STATES.includes(fileState as SetupFileState) ||
    typeof profiles.usableProfiles !== "number" ||
    typeof profiles.loadedProfiles !== "number"
  ) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的检测状态。");
  }
  return {
    claudeFound: clis.claude!.found as boolean,
    codexFound: clis.codex!.found as boolean,
    profiles: {
      fileState: fileState as SetupFileState,
      usableProfiles: profiles.usableProfiles as number,
      loadedProfiles: profiles.loadedProfiles as number
    }
  };
}

export interface FirstRunResult {
  readonly mode: "created" | "replaced";
  readonly profileCount: number;
}

/** The first-run body is EXACTLY {} (the endpoint takes no parameters). */
export async function applyFirstRun(csrfToken: string): Promise<FirstRunResult> {
  const body = (await requestJson("/api/v1/setup/first-run", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: "{}"
  })) as { applied?: unknown; mode?: unknown; profiles?: unknown };
  const profileCount = Array.isArray(body.profiles) ? body.profiles.length : -1;
  if (body.applied !== true || (body.mode !== "created" && body.mode !== "replaced") || profileCount < 0) {
    throw new ApiError(500, "BAD_BODY", "服务接受了生成请求,但没有返回可确认的结果。");
  }
  return { mode: body.mode as "created" | "replaced", profileCount };
}
