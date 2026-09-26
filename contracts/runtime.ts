/**
 * Design contracts only; no CLI runtime is implemented by this planning bundle.
 * Public node definitions do not accept Profile/model overrides.
 */
export type RoleId = "coordinator" | "architect" | "developer" | "reviewer";
export type ExecutionTarget = "windows-native" | "wsl" | "linux-native" | "macos-native";
export type VerificationStatus = "verified" | "unsupported" | "unverified";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ProfileSnapshot {
  readonly id: string;
  readonly revision: number;
  readonly hash: string;
  readonly runtime: "claude" | "codex";
  readonly executable: string;
  readonly executionTarget: ExecutionTarget;
  readonly configDir: string;
  readonly requestedModel: string | null;
  readonly credentialGroup: string;
  readonly externalConfigHash: string;
  // Secret values must never be serialized into this object.
}

export interface TaskNodeDefinition {
  readonly id: string;
  readonly role: RoleId;
  readonly title: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly capabilityTags: readonly string[];
  readonly acceptanceCriteria: readonly string[];
}

export interface TaskRunSnapshot {
  readonly runId: string;
  readonly projectId: string;
  readonly graphRevision: number;
  readonly configHash: string;
  readonly baseSha: string;
  readonly bindings: Readonly<Record<RoleId, string>>;
  readonly profileRevisions: Readonly<Record<string, ProfileSnapshot>>;
}

export type CapabilityName =
  | "streaming" | "structuredOutput" | "resumeSession" | "interactiveApproval"
  | "filesystemBoundary" | "networkBoundary" | "processTreeTermination"
  | "nativeDelegationControl" | "credentialIsolation" | "modelSelection"
  | "externalConfigControl";

export interface CapabilityEvidence {
  readonly status: VerificationStatus;
  readonly evidenceRefs: readonly string[];
  readonly explanation: string;
}
export interface CapabilityReport {
  readonly runtime: "claude" | "codex";
  readonly cliVersion: string;
  readonly binaryFingerprint: string;
  readonly target: ExecutionTarget;
  readonly probedAt: string;
  readonly capabilities: Readonly<Record<CapabilityName, CapabilityEvidence>>;
}

export interface ContextManifest {
  readonly contentHash: string;
  readonly items: readonly {
    sourceId: string;
    sourceRevision: string;
    contentHash: string;
    scope: "project" | "task" | "role" | "execution";
    trust: "policy" | "verified-evidence" | "untrusted-content";
  }[];
  readonly budgetMethod: "verified-tokenizer" | "estimated-characters";
  readonly omittedReasons: readonly string[];
}

export interface ExecutionRequest {
  readonly executionId: string;
  readonly runId: string;
  readonly node: TaskNodeDefinition;
  readonly snapshot: TaskRunSnapshot;
  // Already resolved by trusted application code; never taken from node overrides.
  readonly resolvedProfile: ProfileSnapshot;
  readonly inputSha: string;
  readonly worktreePath: string;
  readonly context: ContextManifest;
  readonly policyDigest: string;
  readonly approvedActionDigests: readonly string[];
  readonly dispatchToken: string;
  readonly fencingToken: number;
}

export interface PreparedInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdinFile: string;
  readonly runtimeSecretRefs: readonly string[];
  readonly manifestHash: string;
  readonly timeoutSeconds: number;
  readonly requiredCapabilities: readonly CapabilityName[];
  // Resolution of secret refs occurs only at the trusted launch boundary.
}

export type NormalizedEventType =
  | "started" | "message_delta" | "tool_started" | "tool_completed"
  | "permission_denied" | "approval_requested" | "usage_reported"
  | "artifact_reported" | "result_reported" | "process_exited"
  | "error" | "diagnostic";

export interface NormalizedEvent {
  readonly schemaVersion: 1;
  readonly eventId: string;
  readonly executionId: string;
  readonly seq: number;
  readonly type: NormalizedEventType;
  readonly sourceType: string;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, JsonValue>>;
}

export interface ProcessIdentity {
  readonly pid: number;
  readonly creationTime: string;
  readonly executionNonce: string;
  readonly target: ExecutionTarget;
}
export interface ExecutionHandle {
  readonly executionId: string;
  readonly process: ProcessIdentity;
  readonly sessionId: string | null;
}
export type RecoveryAssessment =
  | { readonly kind: "known-exited"; readonly evidenceRefs: readonly string[] }
  | { readonly kind: "supervised-running"; readonly handle: ExecutionHandle }
  | { readonly kind: "manual-required"; readonly reasons: readonly string[] };

export interface CancellationResult {
  readonly allManagedProcessesExited: boolean;
  readonly unresolvedProcessIds: readonly number[];
  readonly evidenceRefs: readonly string[];
}

export interface CliAdapter {
  probe(profile: ProfileSnapshot): Promise<CapabilityReport>;
  prepare(request: ExecutionRequest): Promise<PreparedInvocation>;
  start(invocation: PreparedInvocation): Promise<ExecutionHandle>;
  events(handle: ExecutionHandle): AsyncIterable<NormalizedEvent>;
  cancel(handle: ExecutionHandle): Promise<CancellationResult>;
  reconcile(executionId: string): Promise<RecoveryAssessment>;
  // Optional; capability gate must be verified before invocation.
  resume?(request: ExecutionRequest, explicitSessionId: string): Promise<ExecutionHandle>;
}

export interface UsageRecord {
  readonly availability: "measured" | "estimated" | "unavailable";
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly costUsd: number | null;
  readonly costBasis: "provider-reported" | "client-estimate" | "unknown";
}
