import { describe, expect, it } from "vitest";
import {
  TaskNodeSchema,
  WorkflowsFileSchema,
  type Equal,
  type Expect,
  type OverrideFieldName,
  type TaskNodeDefinition,
  type TaskNodeSchemaInferenceIsFreeOfOverrides,
  type TaskNodeSchemaInferenceSatisfiesRuntimeContract
} from "../src/index.js";
import { loadValidated } from "./helpers.js";

// Re-declared here so the guarantee is exercised from the test suite as well;
// the canonical declarations in src/schema/node.ts fail tsc on every
// typecheck/build run if either side ever drifts.
type TestTaskNodeDefinitionIsFreeOfOverrides = Expect<
  Equal<Extract<keyof TaskNodeDefinition, OverrideFieldName>, never>
>;

describe("type-level contract guarantees", () => {
  it("TaskNodeDefinition carries no model/profile override field (R13)", () => {
    const assertion: TestTaskNodeDefinitionIsFreeOfOverrides = true;
    expect(assertion).toBe(true);
  });

  it("the Zod node schema inference is assignable to the runtime contract", () => {
    const assertion: TaskNodeSchemaInferenceSatisfiesRuntimeContract = true;
    expect(assertion).toBe(true);
  });

  it("the Zod node schema inference carries no override field either", () => {
    const assertion: TaskNodeSchemaInferenceIsFreeOfOverrides = true;
    expect(assertion).toBe(true);
  });

  it("the parsed example node has no override keys at runtime", () => {
    const workflowsFile = loadValidated(WorkflowsFileSchema, "workflows.yaml");
    const node = workflowsFile.workflows[0]!.nodes[2]!;
    const overrideKeys: readonly string[] = [
      "model",
      "modelId",
      "profile",
      "profileId",
      "profiles",
      "fallbackProfileId",
      "fallbackProfileIds"
    ];
    expect(Object.keys(node).filter((key) => overrideKeys.includes(key))).toEqual([]);
    expect(Object.keys(node)).toEqual([
      "id",
      "role",
      "title",
      "objective",
      "dependencies",
      "capabilityTags",
      "acceptanceCriteria"
    ]);
  });

  it("TaskNodeSchema is strict, so unknown keys cannot sneak past parse", () => {
    const outcome = TaskNodeSchema.safeParse({
      id: "probe",
      role: "developer",
      title: "probe",
      objective: "probe",
      dependencies: [],
      capabilityTags: [],
      acceptanceCriteria: ["probe"],
      model: "arbitrary-model"
    });
    expect(outcome.success).toBe(false);
  });
});
