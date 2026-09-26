/**
 * Typed errors of the M6-04 dogfood package. Every driver failure carries a
 * `cause` (the raw engine result, git error or thrown typed product error)
 * so a red dogfood run explains itself instead of guessing.
 */
export class DogfoodError extends Error {
  constructor(
    message: string,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The dogfood chain could not converge; `cause` carries the site facts. */
export class DogfoodDriverError extends DogfoodError {}

/** The built fake-cli dist bin is missing — run `pnpm build` first. */
export class FakeCliNotBuiltError extends DogfoodError {
  readonly bin: string;
  constructor(bin: string) {
    super(
      `the fake-cli dist bin "${bin}" does not exist; build the workspace first ` +
        "(pnpm build) — the dogfood never invokes a real claude/codex"
    );
    this.name = "FakeCliNotBuiltError";
    this.bin = bin;
  }
}

/** A dispatch round did not produce the one expected claim. */
export class DogfoodDispatchError extends DogfoodDriverError {}
