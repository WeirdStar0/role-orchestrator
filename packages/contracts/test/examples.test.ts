import { describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import {
  ExecutionResultSchema,
  PoliciesFileSchema,
  ProfilesFileSchema,
  ProjectConfigSchema,
  RolesFileSchema,
  TaskRequestSchema,
  WorkflowsFileSchema
} from "../src/index.js";
import { loadExample } from "./helpers.js";

interface ExampleCase {
  readonly fileName: string;
  readonly schema: ZodType;
}

/** The seven frozen planning-bundle examples, mapped to their contracts. */
const EXAMPLES: readonly ExampleCase[] = [
  { fileName: "profiles.example.yaml", schema: ProfilesFileSchema },
  { fileName: "roles.yaml", schema: RolesFileSchema },
  { fileName: "workflows.yaml", schema: WorkflowsFileSchema },
  { fileName: "policies.yaml", schema: PoliciesFileSchema },
  { fileName: "project.example.yaml", schema: ProjectConfigSchema },
  { fileName: "task-request.example.json", schema: TaskRequestSchema },
  { fileName: "result.example.json", schema: ExecutionResultSchema }
];

describe("frozen bundle examples satisfy the migrated Zod contracts", () => {
  it.each(EXAMPLES)("$fileName passes its contract schema", ({ fileName, schema }) => {
    const outcome = schema.safeParse(loadExample(fileName));
    expect(outcome.success, `${fileName} must satisfy its Zod schema`).toBe(true);
  });

  it("covers all seven planning-bundle example files", () => {
    expect(EXAMPLES).toHaveLength(7);
  });
});
