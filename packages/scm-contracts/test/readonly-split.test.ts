/**
 * Read/write separation as a RUNTIME fact (the static-type fact is enforced
 * by tsc through the exported Expect<Equal<...>> assertions in src/clients.ts
 * and re-asserted compile-time below): the read-only client surface carries
 * no write method, read flows touch no approval machinery, and hostile or
 * non-projecting transport responses fail loudly as ScmTransportContractError.
 */
import { describe, expect, it } from "vitest";
import type { Equal, Expect } from "@role-orchestrator/contracts";
import type { ScmReadOnlyClient } from "../src/index.js";
import {
  ScmCredentialShapeError,
  ScmProviderNotVerifiedError,
  ScmRequestValidationError,
  ScmTransportContractError,
  WRITE_OPERATIONS,
  assertNoWriteCapability,
  createReadOnlyScmClient,
  matrixVerificationLookup
} from "../src/index.js";
import {
  githubCapability,
  githubCredential,
  recordingAuditSink,
  recordingReadTransport,
  verifiedVerification
} from "./helpers.js";

/** Compile-time echo of the src-side assertion (fails the typecheck if it drifts). */
type WriteMethodsAbsent = Extract<keyof ScmReadOnlyClient, (typeof WRITE_OPERATIONS)[number]>;
export type WriteMethodsAbsentIsNever = Expect<Equal<WriteMethodsAbsent, never>>;

function makeClient(page: unknown = { items: [], malformedDropped: 0 }) {
  const transport = recordingReadTransport(page);
  const client = createReadOnlyScmClient({
    capability: githubCapability(),
    transport,
    credential: githubCredential(),
    verification: verifiedVerification()
  });
  return { transport, client };
}

describe("construction-time verification gate", () => {
  it("with the shipped (all-unverified) matrix the read client cannot even be constructed", () => {
    expect(() =>
      createReadOnlyScmClient({
        capability: githubCapability(),
        transport: recordingReadTransport({ items: [], malformedDropped: 0 }),
        credential: githubCredential()
      })
    ).toThrow(ScmProviderNotVerifiedError);
  });
});

describe("read-only client surface has no write capability", () => {
  it("own+prototype property names exclude every write operation name", () => {
    const { client } = makeClient();
    const names = new Set<string>([
      ...Object.getOwnPropertyNames(client),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(client))
    ]);
    for (const writeOp of WRITE_OPERATIONS) {
      expect(names.has(writeOp), writeOp).toBe(false);
    }
    expect(Object.isFrozen(client)).toBe(true);
  });

  it("assertNoWriteCapability passes for the real client and rejects a smuggled write method", () => {
    const { client } = makeClient();
    expect(() => assertNoWriteCapability(client)).not.toThrow();
    const smuggled: Record<string, unknown> = { ...client };
    smuggled.createIssueComment = async () => ({});
    expect(() => assertNoWriteCapability(smuggled)).toThrow(/write method "createIssueComment"/);
  });

  it("calling a write method name on the read client is undefined at runtime", () => {
    const { client } = makeClient();
    expect((client as unknown as Record<string, unknown>)["createIssueComment"]).toBeUndefined();
  });
});

describe("read flow: validation, transport call, strict projection", () => {
  it("calls the transport once with the parsed query and the credential handle", async () => {
    const { transport, client } = makeClient({
      items: [{ number: 7, state: "open", title: "Fix bug" }],
      malformedDropped: 0
    });
    const page = await client.listIssues(
      { repo: { owner: "example-org", name: "example-repo" }, state: "open", limit: 10 },
      githubCredential()
    );
    expect(page.items).toEqual([{ number: 7, state: "open", title: "Fix bug" }]);
    expect(transport.listIssues).toHaveBeenCalledTimes(1);
    expect(transport.listIssues.mock.calls[0]?.[0]).toEqual({
      repo: { owner: "example-org", name: "example-repo" },
      state: "open",
      limit: 10
    });
    expect(transport.listIssues.mock.calls[0]?.[1]).toEqual(githubCredential());
  });

  it("rejects an invalid query before touching the transport", async () => {
    const { transport, client } = makeClient();
    await expect(
      client.listIssues(
        { repo: { owner: "bad owner", name: "r" }, state: "open" } as never,
        githubCredential()
      )
    ).rejects.toBeInstanceOf(ScmRequestValidationError);
    expect(transport.listIssues).not.toHaveBeenCalled();
  });

  it("rejects a credential handle for the wrong provider", async () => {
    const { transport, client } = makeClient();
    await expect(
      client.listIssues(
        { repo: { owner: "o", name: "r" }, state: "open" },
        { provider: "gitlab", label: "env:GITHUB_TOKEN" }
      )
    ).rejects.toBeInstanceOf(ScmCredentialShapeError);
    expect(transport.listIssues).not.toHaveBeenCalled();
  });

  it("fails loudly when the transport skips projection (unknown field or hostile item text)", async () => {
    const { client } = makeClient({
      items: [{ number: 7, state: "open", title: "t", unexpected: true }],
      malformedDropped: 0
    });
    await expect(
      client.listIssues({ repo: { owner: "o", name: "r" }, state: "open" }, githubCredential())
    ).rejects.toBeInstanceOf(ScmTransportContractError);

    const hostile = makeClient({
      items: [{ number: 8, state: "open", title: "rtl\u202Eoverride" }],
      malformedDropped: 0
    });
    await expect(
      hostile.client.listIssues({ repo: { owner: "o", name: "r" }, state: "open" }, githubCredential())
    ).rejects.toBeInstanceOf(ScmTransportContractError);
  });

  it("emits read audit events for success and failure", async () => {
    const audit = recordingAuditSink();
    const transport = recordingReadTransport({ items: [], malformedDropped: 2 });
    const client = createReadOnlyScmClient({
      capability: githubCapability(),
      transport,
      credential: githubCredential(),
      verification: verifiedVerification(),
      audit
    });
    await client.listIssues({ repo: { owner: "o", name: "r" }, state: "all" }, githubCredential());
    expect(audit.events).toHaveLength(1);
    expect(audit.events[0]).toMatchObject({
      kind: "scm.read",
      outcome: "success",
      provider: "github",
      operation: "listIssues",
      refusalCode: null
    });

    const failing = createReadOnlyScmClient({
      capability: githubCapability(),
      transport: recordingReadTransport({ items: "not-an-array" }),
      credential: githubCredential(),
      verification: verifiedVerification(),
      audit
    });
    await expect(
      failing.listIssues({ repo: { owner: "o", name: "r" }, state: "all" }, githubCredential())
    ).rejects.toBeInstanceOf(ScmTransportContractError);
    expect(audit.events).toHaveLength(2);
    expect(audit.events[1]).toMatchObject({ outcome: "failed", refusalCode: "transport-contract" });
  });

  it("per-call verification re-check refuses a client whose lookup later flips unverified", async () => {
    let verified = true;
    const client = createReadOnlyScmClient({
      capability: githubCapability(),
      transport: recordingReadTransport({ items: [], malformedDropped: 0 }),
      credential: githubCredential(),
      verification: () => (verified ? { status: "verified", evidence: "e" } : { status: "unverified", evidence: null })
    });
    await expect(
      client.listIssues({ repo: { owner: "o", name: "r" }, state: "open" }, githubCredential())
    ).resolves.toBeDefined();
    verified = false;
    await expect(
      client.listIssues({ repo: { owner: "o", name: "r" }, state: "open" }, githubCredential())
    ).rejects.toBeInstanceOf(ScmProviderNotVerifiedError);
  });

  it("the default matrix lookup stays unreachable as a verified source", () => {
    expect(matrixVerificationLookup({ provider: "github", surface: "read" }).status).toBe("unverified");
  });
});
