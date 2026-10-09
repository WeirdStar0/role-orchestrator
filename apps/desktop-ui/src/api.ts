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
  /**
   * M11-03: the owning project's internal id — the wire field the server has
   * always served (M9-01 list view); the projects page joins runs to projects
   * through it (project ids reach THIS page by way of the role-bindings
   * lookup, the same surface the old workbench uses). Never rendered.
   */
  readonly projectId: string | null;
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
          projectId: typeof row["projectId"] === "string" ? row["projectId"] : null,
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
 * objective + projectDir (+ the optional multi-node `workflow` declaration,
 * M10-03 shape: nodes of {id, role, kind, objective, dependencies}), nothing
 * else (A02: no model/Profile carriers anywhere). */
export interface CreateRunWorkflowNode {
  readonly id: string;
  readonly role: "coordinator" | "architect" | "developer" | "reviewer";
  readonly kind: "agent" | "integration" | "review";
  readonly objective: string;
  readonly dependencies: readonly string[];
}

export interface CreateRunInput {
  readonly objective: string;
  readonly projectDir: string;
  /** Absent/empty = the single-node run (the wizard's default face). */
  readonly workflow?: readonly CreateRunWorkflowNode[];
}

export async function createRun(csrfToken: string, input: CreateRunInput): Promise<string> {
  // Explicit allowlist build: the request body carries exactly these keys —
  // `workflow` only when non-empty (the server's strict schema would refuse
  // an empty nodes array anyway).
  const payload: Record<string, unknown> = {
    objective: input.objective,
    projectDir: input.projectDir
  };
  if (input.workflow !== undefined && input.workflow.length > 0) {
    payload["workflow"] = {
      nodes: input.workflow.map((node) => ({
        id: node.id,
        role: node.role,
        kind: node.kind,
        objective: node.objective,
        dependencies: [...node.dependencies]
      }))
    };
  }
  const body = (await requestJson("/api/v1/runs", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
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
  /**
   * M11-03: the recommended default role→runtime template (ROLE_IDS order),
   * verbatim from the endpoint; null when neither CLI was found (no template
   * to suggest). Drives the binding step's prefill — runtimes only, never
   * rendered as identifiers.
   */
  readonly defaultBindingTemplate: readonly { readonly roleId: SetupRoleId; readonly runtime: "claude" | "codex" }[] | null;
}

/** The four built-in roles, as the binding surfaces spell them. */
export type SetupRoleId = "coordinator" | "architect" | "developer" | "reviewer";

const FILE_STATES: readonly SetupFileState[] = ["unwired", "absent", "unparseable", "configured"];
const ROLE_IDS: readonly SetupRoleId[] = ["coordinator", "architect", "developer", "reviewer"];

function parseTemplate(value: unknown):
  | readonly { readonly roleId: SetupRoleId; readonly runtime: "claude" | "codex" }[]
  | null {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 4) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的检测状态。");
  }
  const entries: { roleId: SetupRoleId; runtime: "claude" | "codex" }[] = [];
  for (const item of value) {
    const row = (item ?? null) as { roleId?: unknown; runtime?: unknown } | null;
    if (
      row === null ||
      typeof row.roleId !== "string" ||
      !ROLE_IDS.includes(row.roleId as SetupRoleId) ||
      (row.runtime !== "claude" && row.runtime !== "codex")
    ) {
      throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的检测状态。");
    }
    entries.push({ roleId: row.roleId as SetupRoleId, runtime: row.runtime });
  }
  return entries;
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  const body = (await requestJson("/api/v1/setup/status")) as {
    clis?: unknown;
    profiles?: unknown;
    defaultBindingTemplate?: unknown;
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
    },
    defaultBindingTemplate: parseTemplate(body.defaultBindingTemplate)
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

// ---------------------------------------------------------------------------
// M11-03 项目与绑定: the project registration surface (POST /api/v1/projects),
// the read-only binding lookup (GET /api/v1/projects/role-bindings), the
// transactional binding write (PUT /api/v1/projects/:id/role-bindings) and
// the loaded-profiles list the binding selects choose from. Projection
// discipline unchanged: ids travel ONLY as handles the next call needs
// (profileId as the select value / projectId for the PUT path), the role
// cards render product names, never identifiers.
// ---------------------------------------------------------------------------

/** A loaded profile, projected to the binding face: id (the handle) +
 * runtime + optional model (the human-facing lines). M11-05 settings page:
 * the advanced face reads GET /api/v1/profiles — the server projects ONLY
 * id/runtime/executionTarget/model/timeoutSeconds (credentialGroup and
 * maxConcurrency are deliberately not served, so those two render the
 * honest 未知 in the advanced face); since M10-01 POST /api/v1/runs no
 * longer selects profiles from this list — the executing profile comes
 * from the project role bindings. A field that is not a string/number
 * projects to null — never an invented value. */
export interface ProfileSummary {
  readonly id: string;
  readonly runtime: string;
  readonly model: string | null;
  readonly credentialGroup: string | null;
  readonly timeoutSeconds: number | null;
  readonly maxConcurrency: number | null;
}

export async function fetchProfiles(): Promise<readonly ProfileSummary[]> {
  const body = (await requestJson("/api/v1/profiles")) as { profiles?: unknown };
  const profiles = Array.isArray(body.profiles) ? body.profiles : [];
  const parsed: ProfileSummary[] = [];
  for (const item of profiles) {
    if (item !== null && typeof item === "object") {
      const row = item as Record<string, unknown>;
      if (typeof row["id"] === "string" && typeof row["runtime"] === "string") {
        parsed.push({
          id: row["id"],
          runtime: row["runtime"],
          model: typeof row["model"] === "string" ? row["model"] : null,
          credentialGroup: typeof row["credentialGroup"] === "string" ? row["credentialGroup"] : null,
          timeoutSeconds: typeof row["timeoutSeconds"] === "number" ? row["timeoutSeconds"] : null,
          maxConcurrency: typeof row["maxConcurrency"] === "number" ? row["maxConcurrency"] : null
        });
      }
    }
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// M11-06 角色配置模型选择: the profiles CONFIG FILE surface (M9-03's
// GET/PUT /api/v1/profiles/full) reaches the new UI. NO new endpoint — the
// same guarded pair the old workbench 配置 page has always used. GET serves
// the file's CURRENT full text + parse result; PUT validates through the
// EXISTING frozen parser and atomically replaces the file (temp+rename).
// The write-back does NOT hot-reload the running process (the response note
// and serveProfilesFullPut's own doc say so) — every caller states 重启.
// ---------------------------------------------------------------------------

/** One profile entry as the FILE carries it — the full frozen shape
 * (credentialGroup/configDir/executable included, unlike the reduced
 * selection summary). `extraArgs` is pinned empty by the v1 schema and is
 * projected as a constant, never edited here. */
export interface ProfileFullEntry {
  readonly id: string;
  readonly runtime: string;
  readonly executable: string;
  readonly executionTarget: string;
  readonly configDir: string;
  readonly model: string | null;
  readonly credentialGroup: string;
  readonly maxConcurrency: number;
  readonly timeoutSeconds: number;
}

/** The GET /api/v1/profiles/full view (client projection). `profiles: null`
 * with a non-null parseError = the file exists but does not parse — the
 * caller guides to a repair instead of diff-merging against a guess. */
export interface ProfilesFullView {
  readonly sourcePath: string;
  readonly parseError: string | null;
  readonly profiles: readonly ProfileFullEntry[] | null;
}

function parseFullProfileRow(row: Record<string, unknown>): ProfileFullEntry | null {
  if (
    typeof row["id"] !== "string" ||
    typeof row["runtime"] !== "string" ||
    typeof row["executable"] !== "string" ||
    typeof row["executionTarget"] !== "string" ||
    typeof row["configDir"] !== "string" ||
    typeof row["credentialGroup"] !== "string" ||
    typeof row["maxConcurrency"] !== "number" ||
    typeof row["timeoutSeconds"] !== "number"
  ) {
    return null;
  }
  return {
    id: row["id"],
    runtime: row["runtime"],
    executable: row["executable"],
    executionTarget: row["executionTarget"],
    configDir: row["configDir"],
    model: typeof row["model"] === "string" ? row["model"] : null,
    credentialGroup: row["credentialGroup"],
    maxConcurrency: row["maxConcurrency"],
    timeoutSeconds: row["timeoutSeconds"]
  };
}

export async function fetchProfilesFull(): Promise<ProfilesFullView> {
  const body = (await requestJson("/api/v1/profiles/full")) as Record<string, unknown>;
  if (typeof body["sourcePath"] !== "string") {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的 AI 配置文件视图。");
  }
  const rawProfiles = Array.isArray(body["profiles"]) ? body["profiles"] : null;
  const parseError = typeof body["parseError"] === "string" ? body["parseError"] : null;
  let profiles: readonly ProfileFullEntry[] | null = null;
  if (rawProfiles !== null && parseError === null) {
    const parsed: ProfileFullEntry[] = [];
    for (const item of rawProfiles) {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const entry = parseFullProfileRow(item as Record<string, unknown>);
        if (entry !== null) parsed.push(entry);
      }
    }
    profiles = parsed;
  }
  return { sourcePath: body["sourcePath"], parseError, profiles };
}

/** PUT /api/v1/profiles/full — body EXACTLY `{ content }` (the FULL file
 * text); the server validates through the frozen parser BEFORE any
 * filesystem mutation and answers with the re-parsed set. */
export async function putProfilesFull(
  csrfToken: string,
  content: string
): Promise<readonly ProfileFullEntry[]> {
  const body = (await requestJson("/api/v1/profiles/full", {
    method: "PUT",
    headers: { "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ content })
  })) as Record<string, unknown>;
  const rawProfiles = Array.isArray(body["profiles"]) ? body["profiles"] : null;
  if (rawProfiles === null) {
    throw new ApiError(500, "BAD_BODY", "服务接受了配置写入,但没有返回可确认的结果。");
  }
  const parsed: ProfileFullEntry[] = [];
  for (const item of rawProfiles) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      const entry = parseFullProfileRow(item as Record<string, unknown>);
      if (entry !== null) parsed.push(entry);
    }
  }
  return parsed;
}

/** One binding row, verbatim from the lookup (null profileId = unbound). */
export interface RoleBindingRow {
  readonly roleId: SetupRoleId;
  readonly profileId: string | null;
  readonly profileRevision: number | null;
}

// ---------------------------------------------------------------------------
// M11-07 接入配置管理面: two small read-side additions composed from the
// EXISTING surfaces (no write primitive is added anywhere):
//
// - GET /api/v1/profiles/path-check — the ONE new read-only endpoint (the
//   ask's 只读 stat): the browser cannot stat the filesystem, so the
//   management face's executable/configDir existence check rides this
//   guarded, zod-strict, stat-only probe. It answers three booleans and
//   never reads file content; the path is never echoed into logs (the
//   server's request log strips query strings).
// - fetchAllProjectBindings — the delete reference check's data: the
//   EXISTING GET /api/v1/projects list joined with the EXISTING per-project
//   binding lookup (GET /api/v1/projects/role-bindings?projectDir=). No
//   aggregate endpoint; a profile referenced by any project's role bindings
//   is refuse-to-delete material for profileManager.ts.
// ---------------------------------------------------------------------------

/** The path-check view: three booleans, nothing else. */
export interface ProfilePathCheck {
  readonly exists: boolean;
  readonly isFile: boolean;
  readonly isDirectory: boolean;
}

export async function checkProfilePath(path: string): Promise<ProfilePathCheck> {
  const body = (await requestJson(`/api/v1/profiles/path-check?path=${encodeURIComponent(path)}`)) as Record<
    string,
    unknown
  >;
  if (
    typeof body["exists"] !== "boolean" ||
    typeof body["isFile"] !== "boolean" ||
    typeof body["isDirectory"] !== "boolean"
  ) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的路径检查结果。");
  }
  return { exists: body["exists"], isFile: body["isFile"], isDirectory: body["isDirectory"] };
}

/** One registered project's bindings, joined with its repo root. */
export interface ProjectBindingsRow {
  readonly repoRoot: string;
  readonly projectId: string;
  readonly bindings: readonly RoleBindingRow[];
}

/** Read every registered project's bindings through the EXISTING lookup
 * (sequential per project — the registry is small and local). A project
 * whose lookup fails (404 PROJECT_UNKNOWN — deleted between list and read)
 * is skipped: a gone project cannot reference anything. */
export async function fetchAllProjectBindings(repoRoots: readonly string[]): Promise<readonly ProjectBindingsRow[]> {
  const rows: ProjectBindingsRow[] = [];
  for (const repoRoot of repoRoots) {
    try {
      const view = await fetchRoleBindings(repoRoot);
      rows.push({ repoRoot, projectId: view.projectId, bindings: view.bindings });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) continue;
      throw error;
    }
  }
  return rows;
}

export interface RoleBindingsView {
  /** The handle the binding PUT addresses; the lookup's contract serves it. */
  readonly projectId: string;
  readonly bindings: readonly RoleBindingRow[];
}

/** Read-only lookup by repo root. Refuses 404 PROJECT_UNKNOWN when the
 * directory has no project row (the caller guides instead of guessing). */
export async function fetchRoleBindings(projectDir: string): Promise<RoleBindingsView> {
  const body = (await requestJson(
    `/api/v1/projects/role-bindings?projectDir=${encodeURIComponent(projectDir)}`
  )) as Record<string, unknown>;
  const raw = Array.isArray(body["bindings"]) ? body["bindings"] : [];
  const bindings: RoleBindingRow[] = [];
  for (const item of raw) {
    const row = (item ?? null) as Record<string, unknown> | null;
    if (
      row === null ||
      typeof row["roleId"] !== "string" ||
      !ROLE_IDS.includes(row["roleId"] as SetupRoleId)
    ) {
      continue;
    }
    bindings.push({
      roleId: row["roleId"] as SetupRoleId,
      profileId: typeof row["profileId"] === "string" && row["profileId"] !== "" ? row["profileId"] : null,
      profileRevision: typeof row["profileRevision"] === "number" ? row["profileRevision"] : null
    });
  }
  return {
    projectId: typeof body["projectId"] === "string" ? body["projectId"] : "",
    bindings
  };
}

/** The transactional write body: EXACTLY four {roleId, profileId} entries. */
export interface RoleBindingSelection {
  readonly roleId: SetupRoleId;
  readonly profileId: string;
}

export async function putRoleBindings(
  csrfToken: string,
  projectId: string,
  bindings: readonly RoleBindingSelection[]
): Promise<void> {
  await requestJson(`/api/v1/projects/${encodeURIComponent(projectId)}/role-bindings`, {
    method: "PUT",
    headers: { "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ bindings: bindings.map((entry) => ({ roleId: entry.roleId, profileId: entry.profileId })) })
  });
}

/** The registration result: the operator-facing identity only (repoRoot +
 * createdAt — no internal id, like the GET list). `existing` distinguishes a
 * fresh registration from the idempotent re-registration of a known
 * directory. */
export interface RegisterProjectResult {
  readonly existing: boolean;
  readonly repoRoot: string;
  readonly createdAt: string;
}

/** POST /api/v1/projects — strict single-field body; the four fail-closed
 * directory gates are the server's (each refusal is a typed 400 the
 * humanizers translate). */
export async function registerProject(csrfToken: string, projectDir: string): Promise<RegisterProjectResult> {
  const body = (await requestJson("/api/v1/projects", {
    method: "POST",
    headers: { "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({ projectDir })
  })) as {
    registered?: unknown;
    existing?: unknown;
    project?: { repoRoot?: unknown; createdAt?: unknown };
  };
  if (
    body.registered !== true ||
    typeof body.existing !== "boolean" ||
    body.project === null ||
    typeof body.project !== "object" ||
    typeof body.project.repoRoot !== "string" ||
    typeof body.project.createdAt !== "string"
  ) {
    throw new ApiError(500, "BAD_BODY", "服务接受了登记请求,但没有返回可确认的结果。");
  }
  return {
    existing: body.existing,
    repoRoot: body.project.repoRoot,
    createdAt: body.project.createdAt
  };
}

// ---------------------------------------------------------------------------
// M11-03 任务详情: the run detail, the node graph, the approval view, the
// per-execution event log and the candidate diff — all EXISTING read-only
// surfaces (M9-01/M5-01/M5-03/M5-04); the client projects each down to what
// the page renders. Internal ids ride along only as handles (the events
// path, the diff query) and fold into the page's 开发者详情 block; they are
// never rendered in the default view.
// ---------------------------------------------------------------------------

export interface RunExecutionView {
  readonly id: string;
  readonly nodeId: string;
  readonly attempt: number;
  readonly phase: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RunDetailView {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly graphRevision: number;
  readonly status: string;
  readonly outcome: string | null;
  readonly baseSha: string;
  readonly createdAt: string;
  readonly executions: readonly RunExecutionView[];
}

export async function fetchRunDetail(runId: string): Promise<RunDetailView> {
  const body = (await requestJson(`/api/v1/runs/${encodeURIComponent(runId)}`)) as {
    run?: Record<string, unknown>;
  };
  const run = body.run ?? null;
  if (run === null || typeof run["id"] !== "string" || typeof run["status"] !== "string") {
    throw new ApiError(404, "NOT_FOUND", "找不到这个任务(可能已被移除,或标识不正确)。");
  }
  const executionsRaw = Array.isArray(run["executions"]) ? run["executions"] : [];
  const executions: RunExecutionView[] = [];
  for (const item of executionsRaw) {
    const row = (item ?? null) as Record<string, unknown> | null;
    if (
      row !== null &&
      typeof row["id"] === "string" &&
      typeof row["nodeId"] === "string" &&
      typeof row["attempt"] === "number" &&
      typeof row["phase"] === "string" &&
      typeof row["createdAt"] === "string" &&
      typeof row["updatedAt"] === "string"
    ) {
      executions.push({
        id: row["id"],
        nodeId: row["nodeId"],
        attempt: row["attempt"],
        phase: row["phase"],
        createdAt: row["createdAt"],
        updatedAt: row["updatedAt"]
      });
    }
  }
  return {
    id: run["id"],
    projectId: typeof run["projectId"] === "string" ? run["projectId"] : "",
    taskId: typeof run["taskId"] === "string" ? run["taskId"] : "",
    graphRevision: typeof run["graphRevision"] === "number" ? run["graphRevision"] : 0,
    status: run["status"],
    outcome: typeof run["outcome"] === "string" ? run["outcome"] : null,
    baseSha: typeof run["baseSha"] === "string" ? run["baseSha"] : "",
    createdAt: typeof run["createdAt"] === "string" ? run["createdAt"] : "",
    executions
  };
}

export interface RunGraphNode {
  readonly nodeId: string;
  readonly role: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly state: string;
}

export interface RunGraphView {
  readonly runId: string;
  readonly graphRevision: number;
  readonly nodes: readonly RunGraphNode[];
}

export async function fetchRunGraph(runId: string): Promise<RunGraphView> {
  const body = (await requestJson(`/api/v1/runs/${encodeURIComponent(runId)}/graph`)) as {
    graph?: Record<string, unknown>;
  };
  const graph = body.graph ?? null;
  if (graph === null || !Array.isArray(graph["nodes"])) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的任务结构。");
  }
  const nodes: RunGraphNode[] = [];
  for (const item of graph["nodes"]) {
    const row = (item ?? null) as Record<string, unknown> | null;
    if (
      row !== null &&
      typeof row["nodeId"] === "string" &&
      typeof row["role"] === "string" &&
      typeof row["state"] === "string" &&
      Array.isArray(row["dependencies"])
    ) {
      nodes.push({
        nodeId: row["nodeId"],
        role: row["role"],
        objective: typeof row["objective"] === "string" ? row["objective"] : "",
        dependencies: row["dependencies"].filter((dependency): dependency is string => typeof dependency === "string"),
        state: row["state"]
      });
    }
  }
  return {
    runId: typeof graph["runId"] === "string" ? graph["runId"] : runId,
    graphRevision: typeof graph["graphRevision"] === "number" ? graph["graphRevision"] : 0,
    nodes
  };
}

export interface ApprovalItemView {
  readonly approvalId: string;
  readonly status: string;
  readonly riskGrade: string;
  readonly riskReasons: readonly string[];
  readonly expiresAt: string;
  readonly argv: readonly string[];
  readonly permissionIncrements: readonly string[];
  readonly requestedNodeId: string | null;
  /** Empty = a live PENDING approval the operator may decide. */
  readonly invalidations: readonly string[];
  readonly actionable: boolean;
}

export interface RunApprovalsView {
  readonly runId: string;
  readonly approvals: readonly ApprovalItemView[];
}

export async function fetchRunApprovals(runId: string): Promise<RunApprovalsView> {
  const body = (await requestJson(`/api/v1/runs/${encodeURIComponent(runId)}/approvals`)) as {
    approval?: Record<string, unknown>;
  };
  const approval = body.approval ?? null;
  if (approval === null || !Array.isArray(approval["approvals"])) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的审批信息。");
  }
  const approvals: ApprovalItemView[] = [];
  for (const item of approval["approvals"]) {
    const row = (item ?? null) as Record<string, unknown> | null;
    if (row === null || typeof row["approvalId"] !== "string" || typeof row["status"] !== "string") continue;
    const action = (row["action"] ?? null) as Record<string, unknown> | null;
    const argv = action !== null && Array.isArray(action["argv"]) ? action["argv"] : [];
    const requestedBy = (row["requestedBy"] ?? null) as Record<string, unknown> | null;
    approvals.push({
      approvalId: row["approvalId"],
      status: row["status"],
      riskGrade: typeof row["riskGrade"] === "string" ? row["riskGrade"] : "",
      riskReasons: Array.isArray(row["riskReasons"])
        ? row["riskReasons"].filter((reason): reason is string => typeof reason === "string")
        : [],
      expiresAt: typeof row["expiresAt"] === "string" ? row["expiresAt"] : "",
      argv: argv.filter((part): part is string => typeof part === "string"),
      permissionIncrements: Array.isArray(row["permissionIncrements"])
        ? row["permissionIncrements"].filter((entry): entry is string => typeof entry === "string")
        : [],
      requestedNodeId:
        requestedBy !== null && typeof requestedBy["nodeId"] === "string" ? requestedBy["nodeId"] : null,
      invalidations: Array.isArray(row["invalidations"])
        ? row["invalidations"].filter((entry): entry is string => typeof entry === "string")
        : [],
      actionable: row["actionable"] === true
    });
  }
  return {
    runId: typeof approval["runId"] === "string" ? approval["runId"] : runId,
    approvals
  };
}

/** POST /api/v1/approvals/:id/decision — the EXISTING guarded decision
 * surface (per-actionDigest; reject requires a reason; a decision never
 * executes the action). decidedBy is the honest fixed operator identity. */
export const LOCAL_OPERATOR_IDENTITY = "local-operator";

export async function decideApproval(
  csrfToken: string,
  approvalId: string,
  input: { readonly decision: "approve" | "reject"; readonly reason?: string }
): Promise<{ readonly status: string; readonly decision: string }> {
  const body = (await requestJson(`/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`, {
    method: "POST",
    headers: { "x-csrf-token": csrfToken, "Content-Type": "application/json" },
    body: JSON.stringify({
      decision: input.decision,
      decidedBy: LOCAL_OPERATOR_IDENTITY,
      ...(input.reason !== undefined && input.reason !== "" ? { reason: input.reason } : {})
    })
  })) as Record<string, unknown>;
  return {
    status: typeof body["status"] === "string" ? body["status"] : "",
    decision: typeof body["decision"] === "string" ? body["decision"] : input.decision
  };
}

export interface ExecutionEventView {
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
  readonly occurredAt: string;
  readonly payload: Record<string, unknown>;
}

/** The event page size the client requests (M11-04 review handover ⑨): a
 * page coming back EXACTLY this full means the log may continue beyond it —
 * the page renders the honest truncation hint. */
export const EXECUTION_EVENT_PAGE_SIZE = 200;

export async function fetchExecutionEvents(executionId: string): Promise<readonly ExecutionEventView[]> {
  const body = (await requestJson(
    `/api/v1/executions/${encodeURIComponent(executionId)}/events?limit=${String(EXECUTION_EVENT_PAGE_SIZE)}`
  )) as { events?: unknown };
  const events = Array.isArray(body.events) ? body.events : [];
  const parsed: ExecutionEventView[] = [];
  for (const item of events) {
    const row = (item ?? null) as Record<string, unknown> | null;
    if (
      row !== null &&
      typeof row["eventId"] === "string" &&
      typeof row["type"] === "string" &&
      typeof row["occurredAt"] === "string" &&
      row["payload"] !== null &&
      typeof row["payload"] === "object" &&
      !Array.isArray(row["payload"])
    ) {
      parsed.push({
        eventId: row["eventId"],
        seq: typeof row["seq"] === "number" ? row["seq"] : 0,
        type: row["type"],
        occurredAt: row["occurredAt"],
        payload: row["payload"] as Record<string, unknown>
      });
    }
  }
  return parsed;
}

export interface DiffFileEntry {
  readonly path: string;
  readonly status: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean;
}

export interface RunDiffView {
  readonly nodeId: string;
  readonly candidateSha: string | null;
  /** files + the truncation marker of the candidate diff (null = no candidate). */
  readonly files: readonly DiffFileEntry[] | null;
  readonly filesTruncated: boolean;
  /** The server-capped unified -U3 diff text (M11-04: rendered per-line by
   * the page's own lightweight painter). Empty when no candidate exists. */
  readonly unified: string;
  readonly unifiedTruncated: boolean;
  readonly conflictFiles: readonly string[] | null;
}

export async function fetchRunDiff(runId: string, nodeId: string): Promise<RunDiffView> {
  const body = (await requestJson(
    `/api/v1/runs/${encodeURIComponent(runId)}/diff?nodeId=${encodeURIComponent(nodeId)}`
  )) as { diff?: Record<string, unknown> };
  const view = body.diff ?? null;
  if (view === null) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的 Diff 信息。");
  }
  const candidate = (view["diff"] ?? null) as Record<string, unknown> | null;
  const filesRaw = candidate !== null && Array.isArray(candidate["files"]) ? candidate["files"] : null;
  const files: DiffFileEntry[] | null = filesRaw === null ? null : [];
  for (const item of filesRaw ?? []) {
    const row = (item ?? null) as Record<string, unknown> | null;
    if (row !== null && typeof row["path"] === "string" && typeof row["status"] === "string") {
      files!.push({
        path: row["path"],
        status: row["status"],
        additions: typeof row["additions"] === "number" ? row["additions"] : null,
        deletions: typeof row["deletions"] === "number" ? row["deletions"] : null,
        binary: row["binary"] === true
      });
    }
  }
  const integration = (view["integration"] ?? null) as Record<string, unknown> | null;
  return {
    nodeId: typeof view["nodeId"] === "string" ? view["nodeId"] : nodeId,
    candidateSha: typeof view["candidateSha"] === "string" ? view["candidateSha"] : null,
    files,
    filesTruncated: candidate !== null && candidate["fileListTruncated"] === true,
    unified: candidate !== null && typeof candidate["unified"] === "string" ? candidate["unified"] : "",
    unifiedTruncated: candidate !== null && candidate["unifiedTruncated"] === true,
    conflictFiles:
      integration !== null && Array.isArray(integration["conflictFiles"])
        ? integration["conflictFiles"].filter((entry): entry is string => typeof entry === "string")
        : null
  };
}

// ---------------------------------------------------------------------------
// M11-04 执行可视化: the rework-round lineage (the EXISTING M5-02 expansion
// view — zero server change) and the per-review-node verdict records (the
// NEW read-only /review-records view). Projection discipline unchanged:
// ids ride only as handles; findings/verdicts render as product words.
// ---------------------------------------------------------------------------

/** One executed rework round: the failed review trigger, the minted fix and
 * re-review nodes (with live states), and the round's findings. */
export interface RunExpansionItem {
  readonly triggerReviewNodeId: string;
  readonly generation: number;
  readonly fixNode: { readonly nodeId: string; readonly role: string; readonly state: string };
  readonly reviewNode: { readonly nodeId: string; readonly role: string; readonly state: string };
  readonly findings: readonly string[];
}

export interface RunExpansionsView {
  readonly maxReviewRounds: number;
  readonly expansions: readonly RunExpansionItem[];
  readonly unresolvedHold: { readonly reason: string; readonly attemptedGeneration: number } | null;
}

export async function fetchRunExpansions(runId: string): Promise<RunExpansionsView> {
  const body = (await requestJson(`/api/v1/runs/${encodeURIComponent(runId)}/expansions`)) as {
    expansion?: Record<string, unknown>;
  };
  const view = body.expansion ?? null;
  if (view === null) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的返工轮次信息。");
  }
  const rawExpansions = Array.isArray(view["expansions"]) ? view["expansions"] : [];
  const expansions: RunExpansionItem[] = [];
  for (const item of rawExpansions) {
    const row = (item ?? null) as Record<string, unknown> | null;
    const fixNode = (row?.["fixNode"] ?? null) as Record<string, unknown> | null;
    const reviewNode = (row?.["reviewNode"] ?? null) as Record<string, unknown> | null;
    if (
      row === null ||
      typeof row["triggerReviewNodeId"] !== "string" ||
      typeof row["generation"] !== "number" ||
      fixNode === null ||
      typeof fixNode["nodeId"] !== "string" ||
      typeof fixNode["role"] !== "string" ||
      typeof fixNode["state"] !== "string" ||
      reviewNode === null ||
      typeof reviewNode["nodeId"] !== "string" ||
      typeof reviewNode["role"] !== "string" ||
      typeof reviewNode["state"] !== "string"
    ) {
      continue;
    }
    expansions.push({
      triggerReviewNodeId: row["triggerReviewNodeId"],
      generation: row["generation"],
      fixNode: { nodeId: fixNode["nodeId"], role: fixNode["role"], state: fixNode["state"] },
      reviewNode: { nodeId: reviewNode["nodeId"], role: reviewNode["role"], state: reviewNode["state"] },
      findings: Array.isArray(row["findings"])
        ? row["findings"].filter((entry): entry is string => typeof entry === "string")
        : []
    });
  }
  const rawHold = (view["unresolvedHold"] ?? null) as Record<string, unknown> | null;
  return {
    maxReviewRounds: typeof view["maxReviewRounds"] === "number" ? view["maxReviewRounds"] : 3,
    expansions,
    unresolvedHold:
      rawHold !== null && typeof rawHold["reason"] === "string" && typeof rawHold["attemptedGeneration"] === "number"
        ? { reason: rawHold["reason"], attemptedGeneration: rawHold["attemptedGeneration"] }
        : null
  };
}

/** One A12 verdict record of a review node (pass|fail; `blocked` never
 * settles a session). Findings are plain strings — the persistence carries
 * NO severity field, and the UI says so instead of inventing one. */
export interface ReviewRecordView {
  readonly state: "IN_PROGRESS" | "COMPLETED" | "INVALID";
  readonly verdict: "pass" | "fail" | null;
  readonly findings: readonly string[];
  readonly invalidatedReason: string | null;
  readonly completedAt: string | null;
  readonly candidateSha: string;
}

export interface RunReviewRecordsView {
  readonly nodeId: string;
  readonly records: readonly ReviewRecordView[];
}

const REVIEW_RECORD_STATES = ["IN_PROGRESS", "COMPLETED", "INVALID"] as const;

export async function fetchReviewRecords(runId: string, nodeId: string): Promise<RunReviewRecordsView> {
  const body = (await requestJson(
    `/api/v1/runs/${encodeURIComponent(runId)}/review-records?nodeId=${encodeURIComponent(nodeId)}`
  )) as { reviewRecords?: Record<string, unknown> };
  const view = body.reviewRecords ?? null;
  if (view === null || !Array.isArray(view["records"])) {
    throw new ApiError(500, "BAD_BODY", "服务返回了无法解析的评审记录。");
  }
  const records: ReviewRecordView[] = [];
  for (const item of view["records"]) {
    const row = (item ?? null) as Record<string, unknown> | null;
    if (
      row === null ||
      typeof row["state"] !== "string" ||
      !REVIEW_RECORD_STATES.includes(row["state"] as "IN_PROGRESS" | "COMPLETED" | "INVALID") ||
      typeof row["candidateSha"] !== "string"
    ) {
      continue;
    }
    const verdict = row["verdict"];
    records.push({
      state: row["state"] as ReviewRecordView["state"],
      verdict: verdict === "pass" || verdict === "fail" ? verdict : null,
      findings: Array.isArray(row["findings"])
        ? row["findings"].filter((entry): entry is string => typeof entry === "string")
        : [],
      invalidatedReason: typeof row["invalidatedReason"] === "string" ? row["invalidatedReason"] : null,
      completedAt: typeof row["completedAt"] === "string" ? row["completedAt"] : null,
      candidateSha: row["candidateSha"]
    });
  }
  return {
    nodeId: typeof view["nodeId"] === "string" ? view["nodeId"] : nodeId,
    records
  };
}
