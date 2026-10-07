/**
 * M11-02 "首启零配置" — the setup domain behind GET /api/v1/setup/status and
 * POST /api/v1/setup/first-run.
 *
 * What this module IS:
 * - a zod-pinned status VIEW (CLI detection findings + the profiles config
 *   state + the recommended default role→runtime template) — the response
 *   shape is validated through SetupStatusViewSchema before it is served, so
 *   a code drift fails loudly instead of shipping a drifted shape;
 * - the first-run DEFAULTS GENERATOR: the discovered CLIs become the minimal
 *   default profiles file (recommended combination coordinator/architect/
 *   reviewer→claude, developer→codex; a single discovered CLI carries all
 *   four roles), written through the EXISTING atomic write-back primitives
 *   (temp file + fsync + rename, validated by the frozen ProfilesFileSchema
 *   parser BEFORE any filesystem mutation).
 *
 * What this module is NOT:
 * - it never executes a discovered CLI (discovery is file probing only —
 *   see cli-discovery.ts and its canary test);
 * - it never hot-reloads the running process: the orchestrator keeps its
 *   startup definitions until the next serve start. Every success answer
 *   carries `restartRequired: true` and says so — the wizard must surface
 *   this honestly, not pretend the defaults are already live;
 * - it never overwrites a usable configuration: first-run is IDEMPOTENT BY
 *   REFUSAL (409 PROFILES_ALREADY_CONFIGURED when the current profiles file
 *   parses with ≥1 profile). Design decision (registered for the batch
 *   report): an explicit refusal was chosen over an `{applied:false}` no-op
 *   flag because it matches the repository's refuse-don't-upsert semantics
 *   (the drift gate precedent) and makes a double-submit race fail loudly;
 *   the wizard is expected to consult GET /api/v1/setup/status first. A
 *   file that exists but does NOT parse (hand-broken after start) is not a
 *   usable configuration — first-run repairs it with the defaults through
 *   the replace path, and says `mode: "replaced"`.
 *
 * The honest boundaries that shape the refusals:
 * - no `--profiles` wiring in this process (no profilesSourcePath) → 409
 *   PROFILE_SOURCE_ABSENT: the server does not invent a config path;
 * - a DECLARED but not-yet-existing profiles file is the normal first-run
 *   state (serve.ts starts with zero loaded profiles in that state) —
 *   first-run CREATES the file through createProfilesFileAtomic;
 * - neither CLI found → 422 CLIS_NOT_FOUND listing the misses; nothing is
 *   written and nothing is guessed;
 * - no usable home directory (USERPROFILE/HOME unavailable) → 422
 *   HOME_DIRECTORY_UNAVAILABLE: the defaults need the CLI config dirs
 *   (~/.claude, ~/.codex) and refuse to fabricate them.
 */
import { statSync } from "node:fs";
import { z } from "zod";
import {
  EXECUTION_TARGETS,
  ProfileConfigSchema,
  ROLE_IDS,
  RoleIdSchema,
  RuntimeSchema,
  type ProfileConfig,
  type RoleId
} from "@role-orchestrator/contracts";
import {
  DISCOVERED_CLI_NAMES,
  discoverKnownClis,
  isRegularFile,
  cliDiscoveryEnvFromProcess,
  cliDiscoveryPlatform,
  platformPath,
  type CliDiscoveryEnv,
  type CliDiscoveryPlatform,
  type CliFinding
} from "./cli-discovery.js";
import { GraphEditRejectionError } from "./errors.js";
import { createProfilesFileAtomic, readProfilesFull, writeProfilesFullAtomic } from "./profiles-config.js";

/** The recommended role→runtime template: coordinator/architect/reviewer→claude, developer→codex. */
export const DEFAULT_ROLE_RUNTIME_TEMPLATE: Readonly<Record<RoleId, "claude" | "codex">> = {
  coordinator: "claude",
  architect: "claude",
  reviewer: "claude",
  developer: "codex"
};

// ---------------------------------------------------------------------------
// The status view (zod-pinned output shape)
// ---------------------------------------------------------------------------

export const CliFindingSchema = z
  .strictObject({
    found: z.boolean(),
    path: z.string().min(1).nullable(),
    source: z.enum(["path", "user-local-bin", "npm-global-prefix"]).nullable()
  })
  .refine((finding) => finding.found === (finding.path !== null && finding.source !== null), {
    message: "a CLI finding carries path and source exactly when it was found"
  });

export const SetupProfilesStatusSchema = z.strictObject({
  /** The wired profiles source path; null = this process has no profiles wiring. */
  sourcePath: z.string().min(1).nullable(),
  /** unwired | absent (declared, not created yet) | unparseable | configured */
  fileState: z.enum(["unwired", "absent", "unparseable", "configured"]),
  /** Profiles the CURRENT file content parses into (0 unless configured). */
  usableProfiles: z.number().int().min(0),
  /** Why the file does not parse (null when it parses or does not exist). */
  parseError: z.string().min(1).nullable(),
  /** Profiles the RUNNING process loaded at startup — the restart-needed delta. */
  loadedProfiles: z.number().int().min(0)
});

export const DefaultBindingTemplateEntrySchema = z.strictObject({
  roleId: RoleIdSchema,
  runtime: RuntimeSchema
});

export const SetupStatusViewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  clis: z.strictObject({
    claude: CliFindingSchema,
    codex: CliFindingSchema
  }),
  profiles: SetupProfilesStatusSchema,
  /** ROLE_IDS order; null when neither CLI was found (no template to suggest). */
  defaultBindingTemplate: z.array(DefaultBindingTemplateEntrySchema).length(4).nullable()
});

export type SetupStatusView = z.infer<typeof SetupStatusViewSchema>;

/**
 * Read the CURRENT state of the profiles source file (never a cached one):
 * the same view of the file the first-run idempotency gate consults.
 * `readProfilesFull` carries the frozen parser; a file that vanishes between
 * the existence check and the read is honestly "absent".
 */
export function readProfilesFileState(sourcePath: string | null): {
  readonly sourcePath: string | null;
  readonly fileState: "unwired" | "absent" | "unparseable" | "configured";
  readonly usableProfiles: number;
  readonly parseError: string | null;
} {
  if (sourcePath === null) {
    return { sourcePath: null, fileState: "unwired", usableProfiles: 0, parseError: null };
  }
  let exists = false;
  try {
    exists = statSync(sourcePath).isFile();
  } catch {
    exists = false;
  }
  if (!exists) {
    return { sourcePath, fileState: "absent", usableProfiles: 0, parseError: null };
  }
  let view;
  try {
    view = readProfilesFull(sourcePath);
  } catch {
    // The typed 409 carrier of readProfilesFull (vanished/unreadable between
    // the stat and the read): it is not usable right now — absent, no guess.
    return { sourcePath, fileState: "absent", usableProfiles: 0, parseError: null };
  }
  if (view.parseError !== null || view.profiles === null) {
    return {
      sourcePath,
      fileState: "unparseable",
      usableProfiles: 0,
      parseError: view.parseError ?? "the profiles file did not parse"
    };
  }
  return { sourcePath, fileState: "configured", usableProfiles: view.profiles.length, parseError: null };
}

/**
 * The recommended default role→runtime template given the detection:
 * both CLIs → coordinator/architect/reviewer→claude + developer→codex;
 * one CLI → all four roles on that CLI; neither → null.
 */
export function defaultBindingTemplate(findings: Readonly<Record<"claude" | "codex", CliFinding>>):
  | readonly { roleId: RoleId; runtime: "claude" | "codex" }[]
  | null {
  const claudeFound = findings.claude.found;
  const codexFound = findings.codex.found;
  if (!claudeFound && !codexFound) return null;
  return ROLE_IDS.map((roleId) => ({
    roleId,
    runtime:
      roleId === "developer"
        ? (claudeFound ? DEFAULT_ROLE_RUNTIME_TEMPLATE.developer : "codex")
        : (claudeFound ? DEFAULT_ROLE_RUNTIME_TEMPLATE[roleId] : "codex")
  }));
}

/** Injectable discovery/runtime inputs the status and first-run flows share. */
export interface SetupService {
  /** Fresh env snapshot per request (installs during a running server count). */
  readonly envForRequest: () => CliDiscoveryEnv;
  readonly platform: CliDiscoveryPlatform;
  /** Raw platform string driving the executionTarget mapping (win32/darwin/other). */
  readonly processPlatform: string;
  readonly isFile: (candidate: string) => boolean;
}

export interface CliDiscoveryOptions {
  /** Env snapshot override (tests). Default: the real process environment. */
  readonly env?: CliDiscoveryEnv | undefined;
  /** Path-semantics selector override (tests). Default: from process.platform. */
  readonly platform?: CliDiscoveryPlatform | undefined;
  /** Raw platform string override for the executionTarget mapping (tests). */
  readonly processPlatform?: string | undefined;
  /** Regular-file probe override (tests). Default: statSync-based. */
  readonly isFile?: ((candidate: string) => boolean) | undefined;
}

/** Production wiring: real env, real file probe, host platform. */
export function createSetupService(options?: CliDiscoveryOptions): SetupService {
  const processPlatform = options?.processPlatform ?? process.platform;
  const injectedEnv = options?.env;
  return {
    envForRequest:
      injectedEnv !== undefined
        ? () => injectedEnv
        : () => cliDiscoveryEnvFromProcess(process.env),
    platform: options?.platform ?? cliDiscoveryPlatform(processPlatform),
    processPlatform,
    isFile: options?.isFile ?? isRegularFile
  };
}

/**
 * Build (and zod-validate) the GET /api/v1/setup/status view. The parse at
 * the end is the shape contract: if a future edit drifts the shape, the
 * route answers 500 instead of serving a silently drifted payload.
 */
export function buildSetupStatusView(input: {
  readonly setup: SetupService;
  readonly profilesSourcePath: string | null;
  readonly loadedProfiles: number;
}): SetupStatusView {
  const clis = discoverKnownClis(input.setup.envForRequest(), input.setup.platform, input.setup.isFile);
  return SetupStatusViewSchema.parse({
    schemaVersion: 1,
    clis,
    profiles: {
      ...readProfilesFileState(input.profilesSourcePath),
      loadedProfiles: input.loadedProfiles
    },
    defaultBindingTemplate: defaultBindingTemplate(clis)
  });
}

// ---------------------------------------------------------------------------
// The first-run defaults
// ---------------------------------------------------------------------------

/** Safe defaults per the M11-02 ask (schema bounds: 1..32 and 30..86400). */
export const FIRST_RUN_MAX_CONCURRENCY = 4;
export const FIRST_RUN_TIMEOUT_SECONDS = 1800;

/** The executionTarget world the RUNNING process lives in (never `wsl` here: node in WSL reports linux). */
export function executionTargetForPlatform(processPlatform: string): (typeof EXECUTION_TARGETS)[number] {
  if (processPlatform === "win32") return "windows-native";
  if (processPlatform === "darwin") return "macos-native";
  return "linux-native";
}

/** The CLI's config directory (~/.claude, ~/.codex) — a path only; never read here. */
export function defaultConfigDir(cli: (typeof DISCOVERED_CLI_NAMES)[number], homeDir: string, platform: CliDiscoveryPlatform): string {
  return platformPath(platform).join(homeDir, `.${cli}`);
}

/**
 * The home directory the defaults may use, or null. Only an ABSOLUTE,
 * non-empty USERPROFILE (win32) / HOME (posix) counts — a relative or absent
 * value is not a place to anchor ~/.claude, and is refused, not guessed.
 */
export function homeDirectory(env: CliDiscoveryEnv, platform: CliDiscoveryPlatform): string | null {
  const raw = platform === "win32" ? env.USERPROFILE : env.HOME;
  const { isAbsolute } = platformPath(platform);
  if (raw === undefined || raw.trim() === "" || !isAbsolute(raw)) return null;
  return raw;
}

export interface DefaultProfilesPlan {
  /** One profile per DISCOVERED CLI (id `claude-default` / `codex-default`). */
  readonly profiles: readonly ProfileConfig[];
  /** The CLIs that were not found (drives the CLIS_NOT_FOUND details). */
  readonly notFound: readonly (typeof DISCOVERED_CLI_NAMES)[number][];
}

/**
 * Plan the default profiles from the detection findings. Pure — no I/O. The
 * plan is validated by the frozen parser at write time (the atomic
 * primitives validate before touching the filesystem), so a plan that ever
 * drifts from the schema fails loudly at the write, never silently.
 *
 * credentialGroup is DISTINCT PER CLI (claude-personal / codex-personal):
 * the two CLIs' quotas stay isolated (the scheduler's per-credential-group
 * constraint; while the credential-isolation capability is unverified, A33
 * caps each group at 1 regardless of profile.maxConcurrency — the profile
 * value is the operator's knob for the day verification lifts).
 */
export function planDefaultProfiles(input: {
  readonly findings: Readonly<Record<(typeof DISCOVERED_CLI_NAMES)[number], CliFinding>>;
  readonly platform: CliDiscoveryPlatform;
  readonly processPlatform: string;
  readonly homeDir: string;
}): DefaultProfilesPlan {
  const executionTarget = executionTargetForPlatform(input.processPlatform);
  const profiles: ProfileConfig[] = [];
  const notFound: (typeof DISCOVERED_CLI_NAMES)[number][] = [];
  for (const cli of DISCOVERED_CLI_NAMES) {
    const finding = input.findings[cli];
    if (!finding.found || finding.path === null) {
      notFound.push(cli);
      continue;
    }
    const candidate: ProfileConfig = {
      id: `${cli}-default`,
      runtime: cli,
      executable: finding.path,
      executionTarget,
      configDir: defaultConfigDir(cli, input.homeDir, input.platform),
      model: null,
      credentialGroup: `${cli}-personal`,
      maxConcurrency: FIRST_RUN_MAX_CONCURRENCY,
      timeoutSeconds: FIRST_RUN_TIMEOUT_SECONDS,
      extraArgs: []
    };
    profiles.push(ProfileConfigSchema.parse(candidate));
  }
  return { profiles, notFound };
}

/** Strict first-run body: the endpoint takes NO parameters — detection only. */
export const SetupFirstRunBodySchema = z.strictObject({});

export interface SetupFirstRunSuccess {
  readonly applied: true;
  /** `created` = the declared file did not exist yet; `replaced` = repair of a present-but-unusable file. */
  readonly mode: "created" | "replaced";
  readonly sourcePath: string;
  readonly profiles: readonly ProfileConfig[];
  readonly restartRequired: true;
  readonly note: string;
}

/**
 * Apply first-run: detect → plan → write through the EXISTING atomic
 * primitives. Refusal order (each with its explicit code, nothing is written
 * by any refusal):
 *   1. no profiles wiring → 409 PROFILE_SOURCE_ABSENT;
 *   2. already configured (current file parses with ≥1 profile) → 409
 *      PROFILES_ALREADY_CONFIGURED — the idempotency gate;
 *   3. neither CLI found → 422 CLIS_NOT_FOUND with the notFound list;
 *   4. no usable home directory → 422 HOME_DIRECTORY_UNAVAILABLE;
 *   5. the write's own refusals (422 PROFILES_CONTENT_INVALID — would be an
 *      internal bug, reported honestly; 409s of the atomic primitives).
 */
export function applySetupFirstRun(input: {
  readonly setup: SetupService;
  readonly profilesSourcePath: string | null;
}): SetupFirstRunSuccess {
  if (input.profilesSourcePath === null) {
    throw new GraphEditRejectionError(
      409,
      "PROFILE_SOURCE_ABSENT",
      "this server process has no profiles source file wired (the shell did not pass --profiles); " +
        "first-run cannot know where the per-user profiles.json lives and does not invent a path — " +
        "restart serve with --profiles <file.json> (the desktop shell's per-user convention path) and retry",
      { details: { sourcePath: null } }
    );
  }
  const state = readProfilesFileState(input.profilesSourcePath);
  if (state.fileState === "configured") {
    throw new GraphEditRejectionError(
      409,
      "PROFILES_ALREADY_CONFIGURED",
      `the profiles source file "${input.profilesSourcePath}" already parses with ` +
        `${String(state.usableProfiles)} usable profile(s); first-run never overwrites a usable ` +
        "configuration — edit it via PUT /api/v1/profiles/full instead",
      { details: { usableProfiles: state.usableProfiles } }
    );
  }
  const findings = discoverKnownClis(input.setup.envForRequest(), input.setup.platform, input.setup.isFile);
  if (!findings.claude.found && !findings.codex.found) {
    throw new GraphEditRejectionError(
      422,
      "CLIS_NOT_FOUND",
      "neither the claude nor the codex CLI was found (PATH directories, ~/.local/bin, npm global " +
        "prefix from the environment were probed; nothing was executed); install one of them or put " +
        "it on PATH and retry — no file was written",
      { details: { notFound: [...DISCOVERED_CLI_NAMES] } }
    );
  }
  const homeDir = homeDirectory(input.setup.envForRequest(), input.setup.platform);
  if (homeDir === null) {
    throw new GraphEditRejectionError(
      422,
      "HOME_DIRECTORY_UNAVAILABLE",
      "the default profiles need the CLI config directories (~/.claude, ~/.codex), but no usable home " +
        `directory environment variable is available (${input.setup.platform === "win32" ? "USERPROFILE" : "HOME"} ` +
        "is missing, empty or relative); no file was written",
      { details: { platform: input.setup.platform } }
    );
  }
  const plan = planDefaultProfiles({
    findings,
    platform: input.setup.platform,
    processPlatform: input.setup.processPlatform,
    homeDir
  });
  // Both refusals above guarantee at least one profile here.
  const content = JSON.stringify({ schemaVersion: 1, profiles: plan.profiles }, null, 2) + "\n";
  const mode: "created" | "replaced" = state.fileState === "absent" ? "created" : "replaced";
  const profiles =
    mode === "created"
      ? createProfilesFileAtomic(input.profilesSourcePath, content)
      : writeProfilesFullAtomic(input.profilesSourcePath, content);
  return {
    applied: true,
    mode,
    sourcePath: input.profilesSourcePath,
    profiles,
    restartRequired: true,
    note:
      "default profiles written (temp file + fsync + rename, frozen-schema validated); the RUNNING " +
      "process keeps its startup definitions — restart serve (or the desktop shell) to load them. " +
      "This is the no-hot-reload constraint, stated honestly: until the restart, run creation still " +
      "resolves profiles from the startup state."
  };
}
