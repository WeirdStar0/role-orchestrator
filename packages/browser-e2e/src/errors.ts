/**
 * Typed errors of the browser E2E package. Every error carries a stable name
 * and (where one exists) the underlying `cause` — the same discipline every
 * product package here follows, so a red test explains itself instead of
 * surfacing a bare string.
 */

/** Base class: nothing in this package throws a bare Error on purpose. */
export class BrowserE2eError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The fake-cli dist bin is missing — `pnpm build` at the repo root first. */
export class FakeCliNotBuiltError extends BrowserE2eError {
  constructor(bin: string) {
    super(
      `fake-cli is not built (missing ${bin}). Run "pnpm build" at the repo root first; ` +
        "the browser E2E only ever dogfoods the built fake-cli dist bin."
    );
  }
}

/** Playwright could not launch the Chromium binary. */
export class BrowserLaunchError extends BrowserE2eError {
  constructor(cause: unknown) {
    super(
      "Chromium could not be launched by playwright-core. Browser flows cannot be verified " +
        "on this machine — they must be reported as unverified, never faked. " +
        'Install the matching browser with "npx playwright@1.61.0 install chromium" ' +
        "(see packages/browser-e2e/README.md, 运行前提).",
      { cause }
    );
  }
}

/** The pump could not converge every node to SUCCEEDED. */
export class PumpConvergenceError extends BrowserE2eError {
  constructor(detail: string, cause?: unknown) {
    super(`the graph pump did not converge: ${detail}`, { cause });
  }
}

/** A page-side wait (selector/text/WS condition) ran out of time. */
export class PageWaitTimeoutError extends BrowserE2eError {
  constructor(label: string, timeoutMs: number) {
    super(`timed out after ${String(timeoutMs)}ms waiting for ${label}`);
  }
}
