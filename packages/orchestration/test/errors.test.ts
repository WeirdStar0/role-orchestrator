/**
 * M10-02 — the orchestration package's OWN typed error family (error-carrier
 * inversion). The serving HTTP layer maps these to wire envelopes VERBATIM
 * (status/code/message/details), so the family's shape IS the mapping
 * contract: this suite pins it.
 */
import { describe, expect, it } from "vitest";
import { OrchestrationError, OrchestrationRejectionError } from "../src/errors.js";

describe("OrchestrationRejectionError (M1 own error family)", () => {
  it("carries status, machine code, message and structured details", () => {
    const error = new OrchestrationRejectionError(
      422,
      "ROLE_BINDINGS_INCOMPLETE",
      'project "proj-x" has no profile bound for: developer',
      { details: { projectId: "proj-x", missingRoles: ["developer"] } }
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(OrchestrationError);
    expect(error.name).toBe("OrchestrationRejectionError");
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe("ROLE_BINDINGS_INCOMPLETE");
    expect(error.message).toContain("proj-x");
    expect(error.details).toEqual({ projectId: "proj-x", missingRoles: ["developer"] });
  });

  it("defaults details to an empty record and preserves the cause chain", () => {
    const cause = new Error("the typed runtime-profile refusal");
    const error = new OrchestrationRejectionError(404, "PROJECT_NOT_FOUND", "project does not exist", {
      cause
    });
    expect(error.details).toEqual({});
    expect(error.cause).toBe(cause);
  });

  it("accepts every status the former in-package carrier allowed (400..422)", () => {
    for (const statusCode of [400, 403, 404, 409, 422] as const) {
      const error = new OrchestrationRejectionError(statusCode, "ANY_CODE", "message");
      expect(error.statusCode).toBe(statusCode);
    }
  });

  it("the frozen refusal codes the driver throws are DATA on one family", () => {
    // The family covers exactly the codes the former local-api orchestrator
    // threw (PROFILE_SOURCE_ABSENT stays a local-api carrier — it belongs to
    // the profiles config FILE surface, not driver semantics).
    const family: ReadonlyArray<{ readonly status: 400 | 404 | 409 | 422; readonly code: string }> = [
      { status: 400, code: "PROJECT_DIR_NOT_ABSOLUTE" },
      { status: 400, code: "PROJECT_DIR_MISSING" },
      { status: 400, code: "PROJECT_DIR_NOT_DIRECTORY" },
      { status: 400, code: "PROJECT_DIR_NOT_GIT_REPOSITORY" },
      { status: 404, code: "PROJECT_NOT_FOUND" },
      { status: 409, code: "PROFILE_DEFINITION_CONFLICT" },
      { status: 422, code: "ROLE_BINDINGS_INCOMPLETE" },
      { status: 422, code: "UNKNOWN_PROFILE" },
      { status: 422, code: "UNKNOWN_PROFILE_REVISION" },
      { status: 422, code: "EXECUTION_TARGET_MISMATCH" }
    ];
    for (const { status, code } of family) {
      const error = new OrchestrationRejectionError(status, code, "message");
      expect(error.statusCode).toBe(status);
      expect(error.code).toBe(code);
    }
  });
});
