/**
 * Transport authentication scheme comparison (M7-03 design deliverable) as
 * DATA. All three candidate schemes are recorded with their threat surface;
 * every verification cell is `unverified` with `null` evidence because this
 * package has never performed a real handshake (red line: no network calls).
 *
 * The comparison is design input for the future real transport task, not a
 * selection that ships a working credential system today.
 */
import { z } from "zod";

export const TRANSPORT_AUTH_SCHEMES = ["loopback-token", "mtls", "lease-token"] as const;
export type TransportAuthScheme = (typeof TRANSPORT_AUTH_SCHEMES)[number];
export const TransportAuthSchemeSchema = z.enum(TRANSPORT_AUTH_SCHEMES);

/**
 * Verification status is a literal: data cannot express "verified" here.
 * Flipping a cell requires a code change plus real evidence (review-visible),
 * mirroring the scm-contracts capability-matrix discipline (M7-01 D5).
 */
export const UnverifiedEvidenceSchema = z.strictObject({
  verification: z.literal("unverified"),
  evidence: z.null()
});
export type UnverifiedEvidence = z.output<typeof UnverifiedEvidenceSchema>;

export interface TransportAuthProfile {
  readonly scheme: TransportAuthScheme;
  /** Where the credential lives and how long it lives. */
  readonly mintedPer: string;
  readonly lifetime: string;
  readonly revocation: string;
  /** What an attacker who reads the credential can do. */
  readonly theftImpact: string;
  /** Whether the credential touches disk. */
  readonly diskExposure: string;
  /** The threat surface this scheme leaves open. */
  readonly threatSurface: readonly string[];
  /** Role in the M7-03 design. */
  readonly designRole: string;
  readonly verification: UnverifiedEvidence;
}

export const AUTH_SCHEME_PROFILES: Readonly<Record<TransportAuthScheme, TransportAuthProfile>> = {
  "loopback-token": {
    scheme: "loopback-token",
    mintedPer: "one token per daemon start (the local-web bootstrap pattern, docs/SECURITY_MODEL.md)",
    lifetime: "process lifetime of the local daemon",
    revocation: "daemon restart only — no independent revocation",
    theftImpact: "a same-user local process that reads the token can impersonate the orchestrator on loopback",
    diskExposure: "must stay in process memory; passing via env exposes it to every child process env listing",
    threatSurface: [
      "meaningless across hosts — loopback binding only protects same-host channels",
      "any same-user process can attempt the connection; the token is the only secret",
      "token accidentally landing in argv/env/log files leaks it to the very processes being supervised"
    ],
    designRole:
      "the baseline for a SAME-HOST container worker (worker on localhost): reuses the existing local-web one-shot token bootstrap; NOT sufficient for a remote host",
    verification: { verification: "unverified" as const, evidence: null }
  },
  mtls: {
    scheme: "mtls",
    mintedPer: "long-lived client+server certificates from a dedicated orchestrator CA",
    lifetime: "months (certificate validity)",
    revocation: "requires a working revocation story (CRL/OCSP) — operationally the hard part",
    theftImpact: "a stolen client key impersonates the orchestrator until the cert expires or is revoked",
    diskExposure: "private keys on disk on both ends unless a TPM/KMS holds them",
    threatSurface: [
      "CA and key-management lifecycle is a new trusted computing base",
      "long-lived key material is the highest-value theft target of the three schemes",
      "does not by itself scope WHAT the peer may do — authorization still needs the lease/fencing layer"
    ],
    designRole:
      "the strongest CHANNEL authentication for a cross-host worker; recommended only in combination with short-lived execution leases so a stolen channel cannot rewrite history",
    verification: { verification: "unverified" as const, evidence: null }
  },
  "lease-token": {
    scheme: "lease-token",
    mintedPer: "one token per execution assignment, bound to the executionId + resourceKey",
    lifetime: "the lease TTL (seconds to minutes), renewable only by the live holder",
    revocation: "expiry is the revocation; fencing tokens make any post-expiry write provably rejectable",
    theftImpact: "a token stolen mid-execution can act ONLY until expiry, and its writes are fenced: once the slot is re-leased the stolen token's token value is stale and refused",
    diskExposure: "designed to exist only in worker memory; nothing to rotate on disk",
    threatSurface: [
      "within the TTL window a thief acts with the holder's authority (mitigated by short TTL + fencing, not eliminated)",
      "clock skew between orchestrator and worker shifts the effective window — the authority (orchestrator side) is the single expiry judge"
    ],
    designRole:
      "the M7-03 RECOMMENDATION: it composes with the @role-orchestrator/store lease + fencing model this package reuses, making zombie write-backs rejectable by data, not by trust",
    verification: { verification: "unverified" as const, evidence: null }
  }
};

/** Resolve a scheme name (validated against the closed enum) to its profile. */
export function resolveTransportAuthScheme(requested: string): TransportAuthProfile {
  const scheme = TransportAuthSchemeSchema.parse(requested);
  return AUTH_SCHEME_PROFILES[scheme];
}
