/**
 * M3-04 deliveries 1+2 — the cross-dialect dogfood and its negative mirror.
 *
 * Happy path (delivery 1): the fake-claude producer's structured artifact
 * reaches the fake-codex consumer ONLY through the assembled, persisted
 * context bundle — manifest-traceable to the artifact reference the
 * producer's OWN final result event declared, to the producer's accepted
 * output commit SHA, and to authorized memory (rule + fact) — and the codex
 * node's REAL subprocess consumes the bundle-rendered prompt via stdin.
 *
 * Negative path (delivery 2): a full-chain grep over EVERY persisted byte of
 * both executions (event payloads, bundle fragments, bundle manifest, prompt
 * file, execution rows) asserts that NOTHING crosses the dialect boundary as
 * session state — no session id, no credential-shaped string — and that the
 * bundle carries only controlled, structured facts.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readRunRoleProfile } from "@role-orchestrator/runtime-profile";
import { findFragmentsBySource, getContextBundle, traceFragment, verifyContextBundle } from "@role-orchestrator/context";
import {
  CONSUME_NODE,
  DESIGN_ARTIFACT_CONTENT,
  DESIGN_ARTIFACT_REL,
  DESIGN_NODE
} from "../src/index.js";
import { runHandoffHarness, type HandoffHarness } from "./helpers.js";

const DESIGN_OUTPUT_SHA = /^[0-9a-f]{40}$/;

/** Credential-shaped strings must not appear anywhere on the wire. */
const SECRET_SHAPE =
  /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{6,}|\b(?:token|api[-_]?key|apikey|access[-_]?token|secret|password|authorization)\s*[=:]\s*["']?[A-Za-z0-9._~+/=-]{8,}/gi;

const CLAUDE_SYNTH_SESSION = "session_synth_0001";
const CODEX_SYNTH_THREAD = "thread_synth_0001";

let harness: HandoffHarness;

beforeAll(async () => {
  harness = await runHandoffHarness("handoff");
}, 240_000);

afterAll(() => {
  harness?.cleanup();
});

describe("M3-04 跨方言消费 dogfood（fake-claude 产物 -> bundle -> fake-codex 真实子进程）", () => {
  it("两个方言节点沿真实链路 SUCCEEDED，消费者基线 = 生产者输出 SHA", () => {
    const { result, world } = harness;
    expect(result.rounds).toBeGreaterThanOrEqual(1);
    const design = result.trace.find((entry) => entry.nodeId === DESIGN_NODE.id);
    const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);
    expect(design?.finalPhase).toBe("SUCCEEDED");
    expect(consume?.finalPhase).toBe("SUCCEEDED");
    expect(design?.outputSha ?? "").toMatch(DESIGN_OUTPUT_SHA);
    // The consumer's worktree was created exactly at the producer's output.
    expect(consume?.baselineSha).toBe(design?.outputSha);
    // Each dialect ran on its own bound profile (A01; the frozen snapshots
    // are what the engine actually resolved).
    expect(readRunRoleProfile(world.db, { runId: harness.runId, roleId: "architect" }).snapshot.runtime).toBe("claude");
    expect(readRunRoleProfile(world.db, { runId: harness.runId, roleId: "developer" }).snapshot.runtime).toBe("codex");
  });

  it("生产者声明 artifact 引用来自其最终结果事件，并进入消费者 bundle 依赖片段", async () => {
    const { result, world } = harness;
    const design = result.trace.find((entry) => entry.nodeId === DESIGN_NODE.id);
    const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);
    // The producer's own subprocess declared the artifact (synthetic fixed id).
    expect(design?.artifactRefIds).toContain("artifact_fake_report");

    const bundleId = consume?.bundleId ?? "";
    const verification = verifyContextBundle(world.db, bundleId);
    expect(verification.ok).toBe(true);

    const bundle = getContextBundle(world.db, bundleId);
    expect(bundle).not.toBeNull();
    const dependency = bundle?.fragments.find(
      (fragment) => fragment.layer === "dependency" && fragment.source.id === DESIGN_NODE.id
    );
    expect(dependency?.source.kind).toBe("dependency_output");
    expect(dependency?.source.commitSha).toBe(design?.outputSha);
    expect(dependency?.source.artifactId).toBe("artifact_fake_report");
    // The shared fact is the structured artifact content, byte-for-byte.
    expect(dependency?.content).toBe(DESIGN_ARTIFACT_CONTENT);

    // Reverse traceability both ways (bundle manifest 可追溯).
    const traced = traceFragment(world.db, { bundleId, sequence: dependency?.sequence ?? -1 });
    expect(traced.source.commitSha).toBe(design?.outputSha);
    expect(traced.source.artifactId).toBe("artifact_fake_report");
    const reverse = findFragmentsBySource(world.db, {
      sourceId: DESIGN_NODE.id,
      commitSha: design?.outputSha ?? ""
    });
    expect(reverse.map((hit) => hit.bundleId)).toContain(bundleId);

    // The artifact content is really in git at the accepted output SHA.
    const committed = await world.fixture.git.run(world.repoPath, [
      "show",
      `${design?.outputSha ?? ""}:${DESIGN_ARTIFACT_REL}`
    ]);
    expect(committed.stdout).toBe(DESIGN_ARTIFACT_CONTENT);
  });

  it("codex 真实子进程经 stdin 消费 bundle 渲染的提示词（与持久化 manifest 一致）", () => {
    const { result } = harness;
    const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);
    const bundleId = consume?.bundleId ?? "";
    const prompt = harness.promptFileOf(consume?.executionId ?? "", consume?.worktreePath ?? "");
    // The engine fed EXACTLY the rendered bundle text.
    expect(prompt).toBe(consume?.renderedPrompt);
    // The prompt carries the persisted manifest identity + ordered layers.
    expect(prompt).toContain(`bundleId: ${bundleId}`);
    expect(prompt).toContain("[context-bundle v1]");
    // Structured handoff content the consumer actually received:
    expect(prompt).toContain("source=dependency_output/design");
    expect(prompt).toContain(`commitSha=${consume?.baselineSha}`);
    expect(prompt).toContain("artifactId=artifact_fake_report");
    expect(prompt).toContain(DESIGN_ARTIFACT_CONTENT.trim());
    // Authorized memory rode along as its own labeled layer.
    expect(prompt).toContain(`source=memory_entry/${harness.seeded.factId}`);
    expect(prompt).toContain(`source=project_rule/${harness.seeded.ruleId}`);
    expect(prompt).toContain("trust=untrusted-content");
  });
});

describe("M3-04 不复制 session/credentials（全链路负向断言）", () => {
  it("两方言各自持有自己的 session/thread id，互不出现在对方持久化面", () => {
    const { result } = harness;
    const design = result.trace.find((entry) => entry.nodeId === DESIGN_NODE.id);
    const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);

    const designEvents = harness.eventsOf(design?.executionId ?? "");
    const consumeEvents = harness.eventsOf(consume?.executionId ?? "");
    expect(designEvents.length).toBeGreaterThan(0);
    expect(consumeEvents.length).toBeGreaterThan(0);

    const allDesignBytes = JSON.stringify(designEvents.map((event) => event.raw));
    const allConsumeBytes = JSON.stringify(consumeEvents.map((event) => event.raw));
    // Claude's session id never crosses into the codex side...
    expect(allConsumeBytes).not.toContain(CLAUDE_SYNTH_SESSION);
    expect(allConsumeBytes).not.toContain("session_");
    // ...and codex's thread id never crosses into the claude side.
    expect(allDesignBytes).not.toContain(CODEX_SYNTH_THREAD);
    expect(allDesignBytes).not.toContain("thread_");
    // Each side's own dialect identifier is present exactly in its own stream.
    expect(allDesignBytes).toContain(CLAUDE_SYNTH_SESSION);
    expect(allConsumeBytes).toContain(CODEX_SYNTH_THREAD);
  });

  it("消费者 bundle、prompt 文件无任何会话标识与凭据形态字符串；事件流无凭据、无对方会话", () => {
    const { result, world } = harness;
    const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);
    const bundle = getContextBundle(world.db, consume?.bundleId ?? "");
    expect(bundle).not.toBeNull();

    const fragmentBytes = JSON.stringify(
      bundle?.fragments.map((fragment) => ({ source: fragment.source, content: fragment.content }))
    );
    const manifestBytes = JSON.stringify(bundle?.manifest);
    const prompt = harness.promptFileOf(consume?.executionId ?? "", consume?.worktreePath ?? "");
    const consumeEvents = JSON.stringify(harness.eventsOf(consume?.executionId ?? "").map((event) => event.raw));

    // The CONTEXT layer (bundle + prompt) carries NO session state at all —
    // neither dialect's session identifier — and no credential shapes.
    for (const surface of [fragmentBytes, manifestBytes, prompt]) {
      expect(surface.match(SECRET_SHAPE)).toBeNull();
      expect(surface).not.toContain(CLAUDE_SYNTH_SESSION);
      expect(surface).not.toContain(CODEX_SYNTH_THREAD);
    }
    // The consumer's own event stream legitimately holds its OWN dialect
    // thread id and must hold neither the producer's session id nor secrets.
    expect(consumeEvents.match(SECRET_SHAPE)).toBeNull();
    expect(consumeEvents).not.toContain(CLAUDE_SYNTH_SESSION);
    expect(consumeEvents).not.toContain("session_");
  });

  it("bundle 片段只含受控事实：恰好 5 层、来源全部可指认", () => {
    const { result, world } = harness;
    const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);
    const bundle = getContextBundle(world.db, consume?.bundleId ?? "");
    const kept = bundle?.manifest.fragments ?? [];
    const byLayer = Object.fromEntries(kept.map((fragment) => [fragment.layer, fragment]));
    // Controlled facts only — the frozen layer plan of docs section 1:
    expect(Object.keys(byLayer).sort()).toEqual(
      ["dependency", "memory", "project_rule", "role", "task"].sort()
    );
    expect(byLayer["project_rule"]?.source.id).toBe(harness.seeded.ruleId);
    expect(byLayer["role"]?.source.kind).toBe("role_binding");
    // The role layer cites the CONSUMER's own binding (developer -> codex).
    expect(byLayer["role"]?.source.profileId).toBe("profile-ctxe2e-codex");
    expect(byLayer["task"]?.source.id).toBe(CONSUME_NODE.id);
    expect(byLayer["dependency"]?.source.id).toBe(DESIGN_NODE.id);
    expect(byLayer["memory"]?.source.id).toBe(harness.seeded.factId);
    // Every kept fragment cites version provenance: revision for all layers
    // except dependency, whose version reference is the commit SHA itself.
    for (const fragment of kept) {
      if (fragment.layer === "dependency") {
        expect(fragment.source.commitSha).toMatch(DESIGN_OUTPUT_SHA);
      } else {
        expect(fragment.source.revision).not.toBeNull();
      }
    }
  });
});
