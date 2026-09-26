import { describe, expect, it } from "vitest";
import {
  ConcurrencyPolicySchema,
  ExecutionResultSchema,
  LimitsPolicySchema,
  ProfileConfigSchema,
  ProfilesFileSchema,
  ProjectConfigSchema,
  PoliciesFileSchema,
  RolesFileSchema,
  SecurityPolicySchema,
  TaskNodeSchema,
  TaskRequestSchema,
  WorkflowDefinitionSchema,
  WorkflowsFileSchema
} from "../src/index.js";
import {
  expectRejected,
  loadExample,
  loadValidated,
  parseYamlStrict,
  replaceElement,
  withProps
} from "./helpers.js";

// Parsed once with the schemas themselves; if a positive example ever breaks,
// the examples.test.ts failures name it first.
const workflowsFile = loadValidated(WorkflowsFileSchema, "workflows.yaml");
const sampleWorkflow = workflowsFile.workflows[0]!; // "feature-delivery"
const sampleNode = sampleWorkflow.nodes[2]!; // the "frontend" node
const rolesFile = loadValidated(RolesFileSchema, "roles.yaml");
const profilesFile = loadValidated(ProfilesFileSchema, "profiles.example.yaml");
const sampleProfile = profilesFile.profiles[0]!; // "claude-main"
const executionResult = loadValidated(ExecutionResultSchema, "result.example.json");
const taskRequest = loadValidated(TaskRequestSchema, "task-request.example.json");
const policiesFile = loadValidated(PoliciesFileSchema, "policies.yaml");

describe("public definitions reject Profile/model overrides (R13)", () => {
  it.each([
    ["node_profile_override", { profileId: "claude-main" }],
    ["node_model_override", { model: "arbitrary-model" }],
    ["node_profiles_array", { profiles: ["claude-main"] }]
  ] as const)("TaskNodeSchema rejects %s", (caseName, patch) => {
    expectRejected(
      TaskNodeSchema,
      withProps(sampleNode, patch),
      `${caseName}: task nodes must not accept override fields`
    );
  });

  it("workflow_profile_override — the workflow container is strict as well", () => {
    expectRejected(
      WorkflowDefinitionSchema,
      withProps(sampleWorkflow, { profileId: "claude-main" }),
      "workflows must not carry a profileId override"
    );
  });

  it("workflow_catalog_model_override — the workflows file rejects model", () => {
    expectRejected(
      WorkflowsFileSchema,
      withProps(workflowsFile, { model: "x" }),
      "the workflows catalog must not carry a model override"
    );
  });

  it("task_profile_override / task_model_override — task requests reject overrides", () => {
    expectRejected(TaskRequestSchema, withProps(taskRequest, { profileId: "claude-main" }));
    expectRejected(TaskRequestSchema, withProps(taskRequest, { model: "x" }));
  });

  it("node overrides are rejected through the fully nested workflows file", () => {
    const badWorkflow = {
      ...sampleWorkflow,
      nodes: replaceElement(
        sampleWorkflow.nodes,
        2,
        withProps(sampleNode, { model: "arbitrary-model" })
      )
    };
    const badFile = {
      ...workflowsFile,
      workflows: replaceElement(workflowsFile.workflows, 0, badWorkflow)
    };
    expectRejected(WorkflowsFileSchema, badFile);
  });

  it("proposed nodes in execution results reject overrides too", () => {
    const badProposal = withProps(sampleNode, { profileId: "claude-main" });
    const badResult = {
      ...executionResult,
      taskProposals: [badProposal]
    };
    expectRejected(ExecutionResultSchema, badResult);
  });
});

describe("role bindings stay single-selection with fixed roles", () => {
  it("role_multiselect — profileId must be one string, not a list", () => {
    const badDeveloper = withProps(rolesFile.roles.developer, {
      profileId: ["codex-main"]
    });
    expectRejected(
      RolesFileSchema,
      { ...rolesFile, roles: { ...rolesFile.roles, developer: badDeveloper } },
      "a role must bind exactly one profile"
    );
  });

  it("unknown_role — only the four fixed roles exist", () => {
    expectRejected(
      RolesFileSchema,
      {
        ...rolesFile,
        roles: {
          ...rolesFile.roles,
          tester: { profileId: "codex-main", canCreateSubtasks: false }
        }
      },
      "unknown roles must be rejected"
    );
  });

  it("missing_role — all four role bindings are required", () => {
    const { reviewer: _omitted, ...incomplete } = rolesFile.roles;
    expectRejected(RolesFileSchema, { ...rolesFile, roles: incomplete });
  });
});

describe("profiles cannot smuggle fallbacks or CLI argument overrides", () => {
  it("implicit_profile_fallback — no fallbackProfileId field exists", () => {
    expectRejected(
      ProfileConfigSchema,
      withProps(sampleProfile, { fallbackProfileId: "codex-main" }),
      "implicit profile fallback must be rejected"
    );
    expectRejected(
      ProfilesFileSchema,
      {
        ...profilesFile,
        profiles: replaceElement(
          profilesFile.profiles,
          0,
          withProps(sampleProfile, { fallbackProfileId: "codex-main" })
        )
      },
      "implicit profile fallback must be rejected at file level"
    );
  });

  it("args_model_override / args_skip_permissions — extraArgs stays empty in v1", () => {
    expectRejected(
      ProfileConfigSchema,
      withProps(sampleProfile, { extraArgs: ["--model", "x"] }),
      "extraArgs must not become a model override channel"
    );
    expectRejected(
      ProfileConfigSchema,
      withProps(sampleProfile, { extraArgs: ["--dangerously-skip-permissions"] }),
      "extraArgs must not become a permissions override channel"
    );
  });
});

describe("execution results cannot claim success without review evidence", () => {
  it("missing_review_evidence — verdicts may only cite artifacts this result reports", () => {
    const review = executionResult.review!;
    const badReview = withProps(review, { evidenceRefs: ["missing"] });
    expectRejected(
      ExecutionResultSchema,
      { ...executionResult, review: badReview },
      "a pass verdict without locatable evidence must not be judged a success"
    );
  });

  it("empty review evidence is rejected by the schema itself", () => {
    const review = executionResult.review!;
    expectRejected(
      ExecutionResultSchema,
      { ...executionResult, review: withProps(review, { evidenceRefs: [] }) },
      "review evidenceRefs requires at least one entry"
    );
  });

  it("fact_without_evidence — fact/decision/project_rule memories need evidence", () => {
    const badResult = {
      ...executionResult,
      memoryProposals: [
        ...executionResult.memoryProposals,
        { type: "fact", content: "Claim", evidenceRefs: [] }
      ]
    };
    expectRejected(ExecutionResultSchema, badResult);
  });

  it("unknown_result_approval — results cannot self-approve via unknown fields", () => {
    expectRejected(
      ExecutionResultSchema,
      withProps(executionResult, { approved: true }),
      "results must not gain approval semantics through unknown fields"
    );
  });
});

describe("policy security posture is pinned, not configurable", () => {
  it.each([
    ["unauthenticated_local_api", { requireLocalApiAuth: false }],
    ["allow_unknown_capabilities", { unknownRequiredCapability: "allow" }],
    ["unmanaged_native_delegation", { allowUnmanagedNativeDelegation: true }],
    ["agent_rule_promotion", { projectRulePromotion: "agent" }]
  ] as const)("SecurityPolicySchema rejects %s", (caseName, patch) => {
    expectRejected(
      SecurityPolicySchema,
      withProps(policiesFile.security, patch),
      `${caseName}: the security baseline must not be weakened through config`
    );
  });

  it.each([
    ["negative_concurrency", ConcurrencyPolicySchema, "concurrency", { globalMax: -1 }],
    ["zero_attempts", LimitsPolicySchema, "limits", { maxAttempts: 0 }]
  ] as const)("policies reject %s", (caseName, schema, section, patch) => {
    const section_ = policiesFile[section];
    expectRejected(schema, withProps(section_, patch), `${caseName} must be rejected`);
  });
});

describe("unknown fields are rejected by default (strict objects)", () => {
  it.each([
    ["profiles.example.yaml", ProfilesFileSchema],
    ["roles.yaml", RolesFileSchema],
    ["workflows.yaml", WorkflowsFileSchema],
    ["policies.yaml", PoliciesFileSchema],
    ["project.example.yaml", ProjectConfigSchema],
    ["task-request.example.json", TaskRequestSchema],
    ["result.example.json", ExecutionResultSchema]
  ] as const)("unknown top-level field rejected in %s", (fileName, schema) => {
    const data = loadExample(fileName) as object;
    expectRejected(
      schema,
      withProps(data, { __unexpectedField: { nested: [1, 2, 3] } }),
      `${fileName}: unknown fields must be rejected by default`
    );
  });
});

describe("duplicate YAML keys", () => {
  it("duplicate_yaml_key — rejected like UniqueKeyLoader in validate_bundle.py", () => {
    expect(() => parseYamlStrict("id: first\nid: second\n")).toThrow(/unique/i);
  });
});
