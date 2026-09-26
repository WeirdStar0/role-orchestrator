/**
 * Typed error for invariant violations inside the verification probes.
 *
 * The probes are read-only compositions over already-validated control
 * surfaces; this error only fires when the package's own frozen data is
 * incomplete (e.g. a runtime without recorded M0 evidence), which the tests
 * pin as impossible. It follows the repository's typed-error + cause
 * convention so a probe failure is never an anonymous string.
 */
export class ImplicitVerifyProbeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImplicitVerifyProbeError";
  }
}
