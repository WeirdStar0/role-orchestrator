/**
 * The SCMProvider client factories — where the read/write separation becomes
 * a DOUBLE fact (M7-01):
 *
 * Static-type fact: `ScmReadOnlyClient` (and its `ScmReadTransport`
 * dependency) simply have no write members — the exported compile-time
 * assertions below fail the build if that ever drifts. Write methods take the
 * ApprovalRef as a REQUIRED second argument, so omitting it is an arity error
 * for typed callers.
 *
 * Runtime fact: `assertNoWriteCapability` re-checks a constructed client's own
 * AND prototype property names against the closed write-operation enum. The
 * write client's guards run in a fixed order, cheapest and most absolute first:
 *
 *   1. ApprovalRef PRESENT?  → ScmApprovalRequiredError (fires before anything else)
 *   2. ApprovalRef shape?    → strict schema (ScmRequestValidationError)
 *   3. Provider surface verified in the compatibility matrix lookup?
 *                            → ScmProviderNotVerifiedError (default matrix = always)
 *   4. Operation declared in the capability? → ScmOperationNotDeclaredError
 *   5. Command strict schema → unknown fields/values rejected
 *   6. Digest binding: actionDigest(command) vs ApprovalRef.actionDigest
 *                            → ScmApprovalDigestMismatchError (approval NOT burned)
 *   7. Consumption: the host's consume callback (wired to approval's guarded
 *      CAS consumeApproval) — exactly one winner, ever; typed approval errors
 *      propagate unchanged
 *   8. Transport call + strict projection parse → ScmTransportContractError
 *   9. Receipt built HERE (structural facts + content digest computed here)
 *
 * Consumption happens BEFORE the transport call on purpose: the CAS is the
 * authorization commit point. A transport failure after consumption means the
 * approval WAS spent and nothing was written — the retry needs a NEW approval
 * (no silent auto-retry; the same "结果未知不自动重跑" discipline as A22).
 *
 * Both clients emit audit events through the optional ScmAuditSink for every
 * terminal outcome (success / refused / failed) — refusals are audit material,
 * not noise.
 */
import {
  ApprovalAlreadyConsumedError,
  ApprovalDigestMismatchError,
  ApprovalExpiredError,
  ApprovalStateError,
  UnknownApprovalError,
  type ActionDescriptor
} from "@role-orchestrator/approval";
import type { Equal, Expect } from "@role-orchestrator/contracts";
import { z } from "zod";
import {
  WRITE_OPERATIONS,
  assertSurfaceVerified,
  matrixVerificationLookup,
  ScmProviderCapabilitySchema,
  type ScmOperation,
  type ScmProvider,
  type ScmProviderCapability,
  type ScmSurfaceKind,
  type ScmVerificationLookup,
  type ScmWriteOperation
} from "./capability.js";
import { assertResolvedCredentialHandle, type ResolvedCredentialHandle } from "./credential.js";
import {
  ScmApprovalDigestMismatchError,
  ScmApprovalRequiredError,
  ScmInvariantViolationError,
  ScmOperationNotDeclaredError,
  ScmRequestValidationError,
  ScmTransportContractError
} from "./errors.js";
import {
  buildScmAuditEvent,
  type ScmAuditEvent,
  type ScmAuditRefusalCode
} from "./events.js";
import type {
  ScmChecksPage,
  ScmIssuePage,
  ScmListChecksQuery,
  ScmListIssuesQuery,
  ScmListPullRequestsQuery,
  ScmListStatusesQuery,
  ScmPullRequestPage,
  ScmStatusesPage
} from "./reads.js";
import {
  ScmChecksPageSchema,
  ScmIssuePageSchema,
  ScmListChecksQuerySchema,
  ScmListIssuesQuerySchema,
  ScmListPullRequestsQuerySchema,
  ScmListStatusesQuerySchema,
  ScmPullRequestPageSchema,
  ScmStatusesPageSchema
} from "./reads.js";
import {
  scmContentSha256,
  scmWriteActionDescriptor,
  scmWriteActionDigest,
  scmWriteRiskAssessment,
  type ScmWriteCommand
} from "./write-binding.js";
import type {
  ScmApprovalRef,
  ScmConsumptionEvidence,
  ScmCreateIssueCommentCommand,
  ScmCreatePullRequestCommand,
  ScmIssueCommentProjection,
  ScmIssueCommentReceipt,
  ScmPullRequestProjection,
  ScmPullRequestReceipt,
  ScmUpdatePullRequestTextCommand
} from "./writes.js";
import {
  ScmApprovalRefSchema,
  ScmConsumptionEvidenceSchema,
  ScmCreateIssueCommentCommandSchema,
  ScmCreatePullRequestCommandSchema,
  ScmIssueCommentProjectionSchema,
  ScmIssueCommentReceiptSchema,
  ScmPullRequestProjectionSchema,
  ScmPullRequestReceiptSchema,
  ScmUpdatePullRequestTextCommandSchema
} from "./writes.js";

// ---------------------------------------------------------------------------
// Transport seams — the ONLY I/O boundary. Adapters implement these against
// real providers in a future, separately-verified task; this package ships no
// transport implementation and performs no network I/O of its own.
// ---------------------------------------------------------------------------

export interface ScmReadTransport {
  listIssues(query: ScmListIssuesQuery, credential: ResolvedCredentialHandle): Promise<unknown>;
  listPullRequests(
    query: ScmListPullRequestsQuery,
    credential: ResolvedCredentialHandle
  ): Promise<unknown>;
  listChecks(query: ScmListChecksQuery, credential: ResolvedCredentialHandle): Promise<unknown>;
  listStatuses(query: ScmListStatusesQuery, credential: ResolvedCredentialHandle): Promise<unknown>;
}

export interface ScmWriteTransport {
  createIssueComment(
    command: ScmCreateIssueCommentCommand,
    credential: ResolvedCredentialHandle
  ): Promise<unknown>;
  createPullRequest(
    command: ScmCreatePullRequestCommand,
    credential: ResolvedCredentialHandle
  ): Promise<unknown>;
  updatePullRequestText(
    command: ScmUpdatePullRequestTextCommand,
    credential: ResolvedCredentialHandle
  ): Promise<unknown>;
}

export interface ScmAuditSink {
  now(): string;
  emit(event: ScmAuditEvent): void;
}

// ---------------------------------------------------------------------------
// Static-type facts (compile-time; violated = build failure)
// ---------------------------------------------------------------------------

type WriteOperationName = (typeof WRITE_OPERATIONS)[number];

/** The read-only client and its transport expose NO write operation. */
export type WriteMethodsAbsentFromReadOnlySurface = Expect<
  Equal<Extract<keyof ScmReadOnlyClient | keyof ScmReadTransport, WriteOperationName>, never>
>;

/** The write client exposes EXACTLY the closed write-operation set. */
export type WriteMethodsPresentOnWriteClient = Expect<
  Equal<Extract<keyof ScmControlledWriteClient, WriteOperationName>, WriteOperationName>
>;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface ScmReadOnlyClient {
  readonly provider: ScmProvider;
  readonly capability: ScmProviderCapability;
  listIssues(query: ScmListIssuesQuery, credential: ResolvedCredentialHandle): Promise<ScmIssuePage>;
  listPullRequests(
    query: ScmListPullRequestsQuery,
    credential: ResolvedCredentialHandle
  ): Promise<ScmPullRequestPage>;
  listChecks(query: ScmListChecksQuery, credential: ResolvedCredentialHandle): Promise<ScmChecksPage>;
  listStatuses(
    query: ScmListStatusesQuery,
    credential: ResolvedCredentialHandle
  ): Promise<ScmStatusesPage>;
}

export interface ScmControlledWriteClient {
  readonly provider: ScmProvider;
  readonly capability: ScmProviderCapability;
  createIssueComment(
    command: ScmCreateIssueCommentCommand,
    approvalRef: ScmApprovalRef
  ): Promise<ScmIssueCommentReceipt>;
  createPullRequest(
    command: ScmCreatePullRequestCommand,
    approvalRef: ScmApprovalRef
  ): Promise<ScmPullRequestReceipt>;
  updatePullRequestText(
    command: ScmUpdatePullRequestTextCommand,
    approvalRef: ScmApprovalRef
  ): Promise<ScmPullRequestReceipt>;
}

export interface ScmReadOnlyClientInput {
  capability: ScmProviderCapability;
  transport: ScmReadTransport;
  credential: ResolvedCredentialHandle;
  /** Defaults to the shipped compatibility matrix (all-unverified). */
  verification?: ScmVerificationLookup | undefined;
  audit?: ScmAuditSink | undefined;
}

export interface ScmControlledWriteClientInput {
  capability: ScmProviderCapability;
  transport: ScmWriteTransport;
  credential: ResolvedCredentialHandle;
  /**
   * Host-wired consumption — production wiring is approval's `consumeApproval`
   * (guarded CAS: status=APPROVED AND digest match AND expiry live). Typed
   * approval errors propagate unchanged.
   */
  consume(input: {
    readonly action: ActionDescriptor;
    readonly approvalRef: ScmApprovalRef;
  }): Promise<unknown>;
  /** Defaults to the shipped compatibility matrix (all-unverified). */
  verification?: ScmVerificationLookup | undefined;
  audit?: ScmAuditSink | undefined;
}

function parseStrict<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (result.success === false) {
    throw new ScmRequestValidationError({ context }, result.error);
  }
  return result.data;
}

function approvalRefusalCode(error: unknown): ScmAuditRefusalCode | null {
  if (error instanceof UnknownApprovalError) return "unknown-approval";
  if (error instanceof ApprovalStateError) return "approval-state";
  if (error instanceof ApprovalExpiredError) return "approval-expired";
  if (error instanceof ApprovalAlreadyConsumedError) return "approval-already-consumed";
  if (error instanceof ApprovalDigestMismatchError) return "approval-digest-mismatch";
  return null;
}

/**
 * Runtime re-check that a client surface carries no write method (defense vs.
 * drift): walks own properties AND the prototype chain, so both instance
 * fields and class methods are covered.
 */
export function assertNoWriteCapability(client: object): void {
  const names = new Set<string>();
  for (let level: object | null = client; level !== null && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const name of Object.getOwnPropertyNames(level)) {
      names.add(name);
    }
  }
  for (const name of names) {
    if ((WRITE_OPERATIONS as readonly string[]).includes(name)) {
      throw new ScmInvariantViolationError(
        `read-only surface carries write method "${name}" — read/write separation violated`
      );
    }
  }
}

abstract class ScmClientBase {
  readonly provider: ScmProvider;
  readonly capability: ScmProviderCapability;
  readonly verification: ScmVerificationLookup;
  private readonly audit: ScmAuditSink | null;

  constructor(input: {
    capability: ScmProviderCapability;
    verification?: ScmVerificationLookup | undefined;
    audit?: ScmAuditSink | undefined;
    surface: ScmSurfaceKind;
  }) {
    this.capability = parseStrict(ScmProviderCapabilitySchema, input.capability, "capability");
    this.provider = this.capability.provider;
    this.verification = input.verification ?? matrixVerificationLookup;
    this.audit = input.audit ?? null;
    // Construction-time gate: with the shipped matrix this throws immediately.
    assertSurfaceVerified(this.verification, this.provider, input.surface);
  }

  protected assertDeclared(operation: string, surface: ScmSurfaceKind, declared: readonly string[]): void {
    if (!declared.includes(operation)) {
      throw new ScmOperationNotDeclaredError({
        provider: this.provider,
        operation,
        surface
      });
    }
  }

  protected emit(input: {
    readonly kind: "scm.read" | "scm.write";
    readonly operation: ScmOperation;
    readonly outcome: "success" | "refused" | "failed";
    readonly refusalCode: ScmAuditRefusalCode | null;
    readonly approvalId: string | null;
    readonly actionDigest: string | null;
    readonly repo: { readonly owner: string; readonly name: string } | null;
    readonly contentSha256: string | null;
    readonly executionId: string | null;
    readonly detail: string;
  }): void {
    const sink = this.audit;
    if (sink === null) {
      return;
    }
    const event = buildScmAuditEvent({
      kind: input.kind,
      provider: this.provider,
      operation: input.operation,
      outcome: input.outcome,
      refusalCode: input.refusalCode,
      approvalId: input.approvalId,
      actionDigest: input.actionDigest,
      repo: input.repo,
      contentSha256: input.contentSha256,
      executionId: input.executionId,
      at: sink.now(),
      detail: input.detail
    });
    sink.emit(event);
  }
}

class ScmReadOnlyClientImpl extends ScmClientBase implements ScmReadOnlyClient {
  private readonly transport: ScmReadTransport;

  constructor(input: ScmReadOnlyClientInput) {
    super({
      capability: input.capability,
      verification: input.verification,
      audit: input.audit,
      surface: "read"
    });
    this.transport = input.transport;
  }

  async listIssues(query: ScmListIssuesQuery, credential: ResolvedCredentialHandle): Promise<ScmIssuePage> {
    return this.runRead(
      "listIssues",
      ScmListIssuesQuerySchema,
      query,
      credential,
      ScmIssuePageSchema,
      (parsed, handle) => this.transport.listIssues(parsed, handle)
    );
  }

  async listPullRequests(
    query: ScmListPullRequestsQuery,
    credential: ResolvedCredentialHandle
  ): Promise<ScmPullRequestPage> {
    return this.runRead(
      "listPullRequests",
      ScmListPullRequestsQuerySchema,
      query,
      credential,
      ScmPullRequestPageSchema,
      (parsed, handle) => this.transport.listPullRequests(parsed, handle)
    );
  }

  async listChecks(query: ScmListChecksQuery, credential: ResolvedCredentialHandle): Promise<ScmChecksPage> {
    return this.runRead(
      "listChecks",
      ScmListChecksQuerySchema,
      query,
      credential,
      ScmChecksPageSchema,
      (parsed, handle) => this.transport.listChecks(parsed, handle)
    );
  }

  async listStatuses(
    query: ScmListStatusesQuery,
    credential: ResolvedCredentialHandle
  ): Promise<ScmStatusesPage> {
    return this.runRead(
      "listStatuses",
      ScmListStatusesQuerySchema,
      query,
      credential,
      ScmStatusesPageSchema,
      (parsed, handle) => this.transport.listStatuses(parsed, handle)
    );
  }

  private async runRead<
    Q extends { readonly repo: { readonly owner: string; readonly name: string } },
    P extends { readonly items: readonly unknown[]; readonly malformedDropped: number }
  >(
    operation: ScmOperation,
    querySchema: z.ZodType<Q>,
    rawQuery: Q,
    credential: ResolvedCredentialHandle,
    pageSchema: z.ZodType<P>,
    call: (parsedQuery: Q, handle: ResolvedCredentialHandle) => Promise<unknown>
  ): Promise<P> {
    // Per-call re-check: a custom lookup may answer differently over time.
    assertSurfaceVerified(this.verification, this.provider, "read");
    this.assertDeclared(operation, "read", this.capability.reads);
    assertResolvedCredentialHandle(credential, this.provider);
    const parsedQuery = parseStrict(querySchema, rawQuery, `${operation}.query`);
    const raw = await call(parsedQuery, credential);
    const result = pageSchema.safeParse(raw);
    if (result.success === false) {
      this.emit({
        kind: "scm.read",
        operation,
        outcome: "failed",
        refusalCode: "transport-contract",
        approvalId: null,
        actionDigest: null,
        repo: parsedQuery.repo,
        contentSha256: null,
        executionId: null,
        detail: "transport response violated the strict projection schema"
      });
      throw new ScmTransportContractError({ operation }, result.error);
    }
    this.emit({
      kind: "scm.read",
      operation,
      outcome: "success",
      refusalCode: null,
      approvalId: null,
      actionDigest: null,
      repo: parsedQuery.repo,
      contentSha256: null,
      executionId: null,
      detail: `items=${String(result.data.items.length)} malformedDropped=${String(result.data.malformedDropped)}`
    });
    return result.data;
  }
}

class ScmControlledWriteClientImpl extends ScmClientBase implements ScmControlledWriteClient {
  private readonly transport: ScmWriteTransport;
  private readonly credential: ResolvedCredentialHandle;
  private readonly consume: (input: {
    readonly action: ActionDescriptor;
    readonly approvalRef: ScmApprovalRef;
  }) => Promise<unknown>;

  constructor(input: ScmControlledWriteClientInput) {
    super({
      capability: input.capability,
      verification: input.verification,
      audit: input.audit,
      surface: "controlledWrite"
    });
    this.transport = input.transport;
    this.credential = input.credential;
    this.consume = input.consume;
  }

  async createIssueComment(
    command: ScmCreateIssueCommentCommand,
    approvalRef: ScmApprovalRef
  ): Promise<ScmIssueCommentReceipt> {
    const receipt = await this.executeWrite("createIssueComment", command, approvalRef);
    return receipt as ScmIssueCommentReceipt;
  }

  async createPullRequest(
    command: ScmCreatePullRequestCommand,
    approvalRef: ScmApprovalRef
  ): Promise<ScmPullRequestReceipt> {
    const receipt = await this.executeWrite("createPullRequest", command, approvalRef);
    return receipt as ScmPullRequestReceipt;
  }

  async updatePullRequestText(
    command: ScmUpdatePullRequestTextCommand,
    approvalRef: ScmApprovalRef
  ): Promise<ScmPullRequestReceipt> {
    const receipt = await this.executeWrite("updatePullRequestText", command, approvalRef);
    return receipt as ScmPullRequestReceipt;
  }

  private async executeWrite(
    operation: ScmWriteOperation,
    rawCommand: unknown,
    rawApprovalRef: unknown
  ): Promise<ScmIssueCommentReceipt | ScmPullRequestReceipt> {
    // (1) The dedicated, absolute refusal — before any validation or I/O.
    if (rawApprovalRef === undefined || rawApprovalRef === null) {
      this.emitWrite(operation, "refused", "approval-required", {
        approvalId: null,
        actionDigest: null,
        repo: null,
        contentSha256: null,
        executionId: null,
        detail: "ApprovalRef argument missing"
      });
      throw new ScmApprovalRequiredError({ operation });
    }
    // (2) ApprovalRef shape.
    const approvalRef = parseStrict(ScmApprovalRefSchema, rawApprovalRef, "approvalRef");
    // (3) Provider surface verification (compatibility matrix by default).
    assertSurfaceVerified(this.verification, this.provider, "controlledWrite");
    // (4) Operation declared in the capability?
    this.assertDeclared(operation, "controlledWrite", this.capability.writes);
    // (5) Command strict schema, per operation.
    let command: ScmWriteCommand["command"];
    let repo: { readonly owner: string; readonly name: string };
    switch (operation) {
      case "createIssueComment": {
        const parsed = parseStrict(
          ScmCreateIssueCommentCommandSchema,
          rawCommand,
          `${operation}.command`
        );
        command = parsed;
        repo = parsed.repo;
        break;
      }
      case "createPullRequest": {
        const parsed = parseStrict(
          ScmCreatePullRequestCommandSchema,
          rawCommand,
          `${operation}.command`
        );
        command = parsed;
        repo = parsed.repo;
        break;
      }
      case "updatePullRequestText": {
        const parsed = parseStrict(
          ScmUpdatePullRequestTextCommandSchema,
          rawCommand,
          `${operation}.command`
        );
        command = parsed;
        repo = parsed.repo;
        break;
      }
    }
    // The pairing operation↔command is established by the switch above.
    const intent = { operation, command } as ScmWriteCommand;
    // (6) A17-by-analogy digest binding, reusing approval's actionDigest.
    const action = scmWriteActionDescriptor(this.provider, intent);
    const assessment = scmWriteRiskAssessment(this.provider, intent);
    if (assessment.requiresApproval === false) {
      // Cannot happen while the mapping pins network+external-side-effect+write
      // (all grade high) — if it ever does, fail closed.
      throw new ScmInvariantViolationError(
        "remote SCM write did not grade high; refusing to consume any approval for it"
      );
    }
    const presentedDigest = scmWriteActionDigest(this.provider, intent);
    if (approvalRef.actionDigest !== presentedDigest) {
      this.emitWrite(operation, "refused", "approval-digest-mismatch", {
        approvalId: approvalRef.approvalId,
        actionDigest: approvalRef.actionDigest,
        repo,
        contentSha256: null,
        executionId: null,
        detail: "presented command digest differs from the approvalRef binding"
      });
      throw new ScmApprovalDigestMismatchError({
        approvalId: approvalRef.approvalId,
        operation,
        boundDigest: approvalRef.actionDigest,
        presentedDigest
      });
    }
    // (7) Consumption — the host-wired single-shot gate (approval CAS).
    let evidence: ScmConsumptionEvidence;
    try {
      const rawEvidence = await this.consume({ action, approvalRef });
      evidence = parseStrict(ScmConsumptionEvidenceSchema, rawEvidence, "consume.evidence");
      if (evidence.approvalId !== approvalRef.approvalId) {
        throw new ScmInvariantViolationError("consume evidence approvalId differs from the ApprovalRef");
      }
      if (evidence.actionDigest !== presentedDigest) {
        throw new ScmInvariantViolationError("consume evidence digest differs from the presented digest");
      }
    } catch (error) {
      const code = approvalRefusalCode(error);
      if (code !== null) {
        this.emitWrite(operation, "refused", code, {
          approvalId: approvalRef.approvalId,
          actionDigest: presentedDigest,
          repo,
          contentSha256: null,
          executionId: null,
          detail: `approval consumption refused (${error instanceof Error ? error.name : "unknown"})`
        });
      }
      throw error;
    }
    // (8) Transport + strict projection. Failures here leave the approval
    // consumed with nothing written — retry needs a NEW approval.
    const contentSha256 = scmContentSha256Of(operation, command);
    let projection: ScmIssueCommentProjection | ScmPullRequestProjection;
    try {
      projection = await this.callTransport(operation, command);
    } catch (error) {
      this.emitWrite(operation, "failed", "transport-contract", {
        approvalId: approvalRef.approvalId,
        actionDigest: presentedDigest,
        repo,
        contentSha256,
        executionId: evidence.consumedByExecutionId,
        detail: `transport failed after consumption (${error instanceof Error ? error.name : "unknown"})`
      });
      throw error;
    }
    // (9) Receipt built HERE — structural facts + digest computed here.
    const receipt = buildReceipt(operation, this.provider, command, projection, contentSha256);
    this.emitWrite(operation, "success", null, {
      approvalId: approvalRef.approvalId,
      actionDigest: presentedDigest,
      repo,
      contentSha256,
      executionId: evidence.consumedByExecutionId,
      detail: "write completed"
    });
    return receipt;
  }

  private async callTransport(
    operation: ScmWriteOperation,
    command: ScmWriteCommand["command"]
  ): Promise<ScmIssueCommentProjection | ScmPullRequestProjection> {
    const raw = await (async (): Promise<unknown> => {
      switch (operation) {
        case "createIssueComment":
          return this.transport.createIssueComment(
            command as ScmCreateIssueCommentCommand,
            this.credential
          );
        case "createPullRequest":
          return this.transport.createPullRequest(command as ScmCreatePullRequestCommand, this.credential);
        case "updatePullRequestText":
          return this.transport.updatePullRequestText(
            command as ScmUpdatePullRequestTextCommand,
            this.credential
          );
      }
    })();
    switch (operation) {
      case "createIssueComment": {
        const result = ScmIssueCommentProjectionSchema.safeParse(raw);
        if (result.success === false) {
          throw new ScmTransportContractError({ operation }, result.error);
        }
        return result.data;
      }
      case "createPullRequest":
      case "updatePullRequestText": {
        const result = ScmPullRequestProjectionSchema.safeParse(raw);
        if (result.success === false) {
          throw new ScmTransportContractError({ operation }, result.error);
        }
        return result.data;
      }
    }
  }

  private emitWrite(
    operation: ScmWriteOperation,
    outcome: "success" | "refused" | "failed",
    refusalCode: ScmAuditRefusalCode | null,
    facts: {
      readonly approvalId: string | null;
      readonly actionDigest: string | null;
      readonly repo: { readonly owner: string; readonly name: string } | null;
      readonly contentSha256: string | null;
      readonly executionId: string | null;
      readonly detail: string;
    }
  ): void {
    this.emit({
      kind: "scm.write",
      operation,
      outcome,
      refusalCode,
      approvalId: facts.approvalId,
      actionDigest: facts.actionDigest,
      repo: facts.repo,
      contentSha256: facts.contentSha256,
      executionId: facts.executionId,
      detail: facts.detail
    });
  }
}

function scmContentSha256Of(operation: ScmWriteOperation, command: ScmWriteCommand["command"]): string {
  switch (operation) {
    case "createIssueComment":
      return scmContentSha256({ body: command.body });
    case "createPullRequest":
    case "updatePullRequestText": {
      const cmd = command as ScmCreatePullRequestCommand;
      return scmContentSha256({ title: cmd.title, body: cmd.body });
    }
  }
}

function buildReceipt(
  operation: ScmWriteOperation,
  provider: ScmProvider,
  command: ScmWriteCommand["command"],
  projection: ScmIssueCommentProjection | ScmPullRequestProjection,
  contentSha256: string
): ScmIssueCommentReceipt | ScmPullRequestReceipt {
  switch (operation) {
    case "createIssueComment": {
      const cmd = command as ScmCreateIssueCommentCommand;
      const proj = projection as ScmIssueCommentProjection;
      return ScmIssueCommentReceiptSchema.parse({
        provider,
        operation,
        repo: cmd.repo,
        issueNumber: cmd.issueNumber,
        commentId: proj.commentId,
        contentSha256,
        createdAt: proj.createdAt
      });
    }
    case "createPullRequest":
    case "updatePullRequestText": {
      const cmd = command as ScmCreatePullRequestCommand;
      const proj = projection as ScmPullRequestProjection;
      return ScmPullRequestReceiptSchema.parse({
        provider,
        operation,
        repo: cmd.repo,
        pullRequestNumber: proj.pullRequestNumber,
        headSha: proj.headSha,
        contentSha256,
        updatedAt: proj.updatedAt
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

export function createReadOnlyScmClient(input: ScmReadOnlyClientInput): ScmReadOnlyClient {
  const client = new ScmReadOnlyClientImpl(input);
  assertNoWriteCapability(client);
  return Object.freeze(client);
}

export function createControlledScmWriteClient(
  input: ScmControlledWriteClientInput
): ScmControlledWriteClient {
  const client = new ScmControlledWriteClientImpl(input);
  return Object.freeze(client);
}
