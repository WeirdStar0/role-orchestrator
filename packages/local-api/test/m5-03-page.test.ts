/**
 * M5-03 page tests: the SERVED app.js (the exact string the server sends) is
 * evaluated in a DOM-less sandbox and the new render functions are asserted
 * snapshot-style:
 * - the approval card shows EVERY actionDigest constituent BEFORE a decision,
 *   and an invalidated (candidate-changed / expired / decided) approval shows
 *   已失效 with NO approve affordance (A17 UI 呈现);
 * - the global-grant vocabulary ("全部允许" etc.) appears NOWHERE (A17:
 *   审批不诱导全局放权 — structural pin over the served assets);
 * - the diff panel renders the unified diff as inert escaped text and shows
 *   已失效 — never an old pass — for a changed candidate (A12 UI 呈现);
 * - the context panel renders layer/trust/truncation markers.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildStaticPageAssets } from "../src/index.js";

const assets = buildStaticPageAssets();

interface PageApi {
  esc(text: unknown): string;
  FORBIDDEN_UI_PHRASES: readonly string[];
  DECISION_FIELD_ALLOWLIST: readonly string[];
  buildApprovalDecisionPayload(
    approvalId: string,
    fields: Record<string, unknown>
  ): Record<string, unknown>;
  invalidationTexts(codes: readonly string[]): readonly string[];
  renderApprovalCard(view: unknown): string;
  renderApprovalPanel(container: { innerHTML: string; hidden: boolean }, view: unknown): void;
  approvalDecisionFailureText(error: unknown): string;
  verdictText(verdict: string): string;
  renderDiffPanel(container: { innerHTML: string; hidden: boolean }, view: unknown): void;
  renderContextPanel(container: { innerHTML: string; hidden: boolean }, view: unknown): void;
}

function loadPageApi(): PageApi {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(assets.appJs, sandbox, { filename: "app.js" });
  const api = sandbox["__roleOrchestratorPage"] as PageApi | undefined;
  if (api === undefined) {
    throw new Error("served app.js did not expose __roleOrchestratorPage");
  }
  return api;
}

const ALLOWED_RAW_TAGS = /^<\/?(li|span|time|div|ul|h2|h3|p|table|thead|tbody|tr|th|td|code|pre|form|label|input|button|br)\b[^>]*\/?>$/;

function rawTags(html: string): string[] {
  return html.match(/<[^>]+>/g) ?? [];
}

/** A full PENDING approval fixture: every digest constituent present. */
function liveApproval(): Record<string, unknown> {
  return {
    approvalId: "approval-abc123",
    actionDigest: "d".repeat(64),
    status: "PENDING",
    riskGrade: "high",
    requiresApproval: true,
    riskReasons: [
      { code: "permission-elevation", detail: "需要 repo.write（权限提升由用户批准）" },
      { code: "capability-not-verified", detail: "capability \"x.y\" is unverified" }
    ],
    expiresAt: "2026-10-22T00:00:00.000Z",
    createdAt: "2026-09-22T00:00:00.000Z",
    updatedAt: "2026-09-22T00:00:00.000Z",
    action: {
      runtime: "claude",
      argv: ["claude", "--print", "<script>alert('argv-xss')</script>"],
      cwd: "h:/worktrees/x",
      repo: { root: "h:/repos/x", baseSha: "b".repeat(40), targetSha: "t".repeat(40) },
      profileRevision: "1",
      requiredPermissions: ["repo.read", "repo.write"],
      grantedPermissions: ["repo.read"],
      dimensions: ["write"],
      writeScope: "managed-worktree",
      requiredCapabilities: []
    },
    permissionIncrements: ["repo.write"],
    requestedBy: { runId: "run-1", nodeId: "b", attempt: 1 },
    checkpoint: null,
    currentCandidateSha: "t".repeat(40),
    invalidations: [],
    actionable: true
  };
}

describe("the M5-03 sections of the served page shell", () => {
  it("carries the approvals/diff/context sections and keeps the no-inline-handler contract", () => {
    expect(assets.indexHtml).toContain('id="approval-panel"');
    expect(assets.indexHtml).toContain('id="load-approvals-button"');
    expect(assets.indexHtml).toContain('id="diff-panel"');
    expect(assets.indexHtml).toContain('id="load-diff-button"');
    expect(assets.indexHtml).toContain('id="diff-node-input"');
    expect(assets.indexHtml).toContain('id="context-panel"');
    expect(assets.indexHtml).toContain('id="load-contexts-button"');
    expect(assets.indexHtml).not.toMatch(/\son(click|load|error|mouseover|submit)=/i);
  });

  it("pins the A17 copy: per-actionDigest decisions only, global-grant phrases nowhere", () => {
    // The approvals hint states the single-digest discipline and the
    // invalidation presentation.
    expect(assets.indexHtml).toContain("只对单个 actionDigest 生效");
    expect(assets.indexHtml).toContain("已失效");
    expect(assets.indexHtml).toContain("不可批准");
    // The global-grant vocabulary appears NOWHERE in the served page shell,
    // and in the served script ONLY inside the blocklist literal itself
    // (which exists to be asserted against, never rendered).
    const api = loadPageApi();
    expect(assets.appJs).toMatch(/var FORBIDDEN_UI_PHRASES = \[[^\]]*\];/);
    const appJsWithoutBlocklist = assets.appJs.replace(/var FORBIDDEN_UI_PHRASES = \[[^\]]*\];/g, "");
    for (const phrase of api.FORBIDDEN_UI_PHRASES) {
      expect(assets.indexHtml).not.toContain(phrase);
      expect(appJsWithoutBlocklist).not.toContain(phrase);
    }
    expect(api.FORBIDDEN_UI_PHRASES).toContain("全部允许");
    expect(api.FORBIDDEN_UI_PHRASES).toContain("信任此站点");
  });
});

describe("renderApprovalCard — every digest constituent visible before a decision (A17)", () => {
  const api = loadPageApi();

  it("shows the complete action essentials and one per-digest decision form", () => {
    const html = api.renderApprovalCard(liveApproval());
    // argv 完整可见（含 argv[0]，逐元素）。
    expect(html).toContain("命令 argv");
    expect(html).toContain("claude");
    expect(html).toContain("--print");
    // 目标 SHA、基线、仓库根、cwd、冻结 revision。
    expect(html).toContain("目标 SHA");
    expect(html).toContain("t".repeat(40));
    expect(html).toContain("基线");
    expect(html).toContain("b".repeat(40));
    expect(html).toContain("h:/repos/x");
    expect(html).toContain("h:/worktrees/x");
    expect(html).toContain("1"); // profileRevision
    // 权限增量、风险等级、过期时间、digest。
    expect(html).toContain("权限增量");
    expect(html).toContain("repo.write");
    expect(html).toContain("风险等级");
    expect(html).toContain("high");
    expect(html).toContain("过期时间");
    expect(html).toContain("2026-10-22T00:00:00.000Z");
    expect(html).toContain("d".repeat(64));
    // The decision form binds exactly ONE actionDigest.
    expect(html).toContain('class="approval-decision-form"');
    expect(html).toContain('data-approval-id="approval-abc123"');
    expect(html).toContain(`data-approval-digest="${"d".repeat(64)}"`);
    expect(html).toContain('value="approve"');
    expect(html).toContain('value="reject"');
    // No model/Profile field anywhere in the form (A02 UI layer).
    expect(html).not.toMatch(/name="(model|modelId|profile|profileId|profiles|fallbackProfileIds?)"/);
  });

  it("renders a candidate-changed approval as 已失效 with NO approve affordance", () => {
    const approval = liveApproval();
    approval["invalidations"] = ["CANDIDATE_CHANGED"];
    approval["actionable"] = false;
    approval["currentCandidateSha"] = "9".repeat(40);
    const html = api.renderApprovalCard(approval);
    expect(html).toContain("已失效");
    expect(html).toContain("候选 SHA 已变化");
    expect(html).toContain("A17");
    expect(html).not.toContain("<form");
    expect(html).not.toContain('value="approve"');
    expect(html).toContain("9".repeat(40)); // the current candidate is shown
  });

  it("renders decided/expired states without a form and escapes hostile values", () => {
    const decided = liveApproval();
    decided["invalidations"] = ["STATUS_APPROVED"];
    decided["actionable"] = false;
    expect(api.renderApprovalCard(decided)).not.toContain("<form");

    const expired = liveApproval();
    expired["invalidations"] = ["EXPIRED"];
    expired["actionable"] = false;
    const expiredHtml = api.renderApprovalCard(expired);
    expect(expiredHtml).toContain("已过期");
    expect(expiredHtml).not.toContain('value="approve"');

    const hostile = liveApproval();
    hostile["approvalId"] = '"><img src=x onerror=alert(1)>@approval';
    const hostileHtml = api.renderApprovalCard(hostile);
    expect(hostileHtml).not.toMatch(/<img/i);
    expect(hostileHtml).toContain("&quot;&gt;&lt;img");
    for (const tag of rawTags(hostileHtml)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
  });

  it("the argv hostile sample is inert text (A36 渲染消毒延续)", () => {
    const html = api.renderApprovalCard(liveApproval());
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(&#39;argv-xss&#39;)&lt;/script&gt;");
  });
});

describe("buildApprovalDecisionPayload — the UI-layer allowlist for decisions", () => {
  const api = loadPageApi();

  it("builds approve and reject bodies from the allowlist only", () => {
    expect(api.buildApprovalDecisionPayload("a1", { decision: "approve", decidedBy: " user " })).toEqual({
      decision: "approve",
      decidedBy: "user"
    });
    expect(
      api.buildApprovalDecisionPayload("a1", { decision: "reject", decidedBy: "user", reason: "目标已变化" })
    ).toEqual({ decision: "reject", decidedBy: "user", reason: "目标已变化" });
  });

  it("refuses override carriers, unknown decisions and reason-less rejections", () => {
    expect(() => api.buildApprovalDecisionPayload("a1", { decision: "approve", decidedBy: "u", model: "x" })).toThrow(/A02/);
    expect(() => api.buildApprovalDecisionPayload("a1", { decision: "approve-all", decidedBy: "u" })).toThrow(/approve/);
    expect(() => api.buildApprovalDecisionPayload("a1", { decision: "reject", decidedBy: "u" })).toThrow(/原因/);
    expect(() => api.buildApprovalDecisionPayload("a1", { decision: "approve", decidedBy: "  " })).toThrow(/decidedBy/);
  });
});

describe("renderDiffPanel — A12 verdict binding + escaped diff", () => {
  const api = loadPageApi();

  function diffView(review: Record<string, unknown> | null): Record<string, unknown> {
    return {
      runId: "run-1",
      nodeId: "b",
      runBaseSha: "b".repeat(40),
      candidateSha: "c".repeat(40),
      integration: {
        integrationId: "integ-1",
        state: "COMPLETED",
        integrationBranch: "task/run-1",
        baseSha: "b".repeat(40),
        parents: [{ nodeId: "a", headSha: "a".repeat(40) }],
        conflictFiles: null
      },
      diff: {
        baseSha: "b".repeat(40),
        candidateSha: "c".repeat(40),
        files: [
          { path: "src/app.txt", status: "M", additions: 1, deletions: 1, binary: false },
          { path: "bin/blob", status: "M", additions: null, deletions: null, binary: true }
        ],
        fileListTruncated: false,
        unified: "diff --git a/src/app.txt b/src/app.txt\n-<script>alert('diff-xss')</script>\n+ok\n",
        unifiedTruncated: false,
        unifiedChars: 80
      },
      review
    };
  }

  it("valid binding: shows the verdict for THIS candidate", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderDiffPanel(container, diffView({
      kind: "valid",
      reviewId: "review-1",
      candidateSha: "c".repeat(40),
      verdict: "pass",
      evidenceRefs: ["art-1"],
      findings: [],
      completedAt: "2026-09-22T01:00:00.000Z"
    }));
    const html = container.innerHTML;
    expect(html).toContain("审查绑定");
    expect(html).toContain("通过（pass）");
    expect(html).toContain("review-1");
    expect(html).toContain("c".repeat(40));
    expect(html).not.toContain("已失效");
  });

  it("invalidated binding: shows 已失效 and NEVER an old pass (A12 UI 呈现)", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderDiffPanel(container, diffView({
      kind: "invalidated",
      runId: "run-1",
      nodeId: "b",
      queriedCandidateSha: "c".repeat(40),
      recordedCandidateShas: ["c".repeat(40).slice(0, 39) + "0"]
    }));
    const html = container.innerHTML;
    expect(html).toContain("已失效");
    expect(html).toContain("A12");
    expect(html).toContain("candidateSha 已变化");
    expect(html).not.toContain("通过（pass）");
    expect(html).not.toContain("未通过（fail）");
    expect(html).not.toContain("review-valid");
    expect(html).toContain("review-invalidated");
  });

  it("none binding: says there is no review record", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderDiffPanel(container, diffView({ kind: "none", runId: "run-1", nodeId: "b", queriedCandidateSha: "c".repeat(40) }));
    expect(container.innerHTML).toContain("没有审查记录");
  });

  it("renders the unified diff as inert text (no HTML activity) and marks binary files", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderDiffPanel(container, diffView(null));
    const html = container.innerHTML;
    // The hostile diff line survives as escaped TEXT, never as markup.
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&lt;script&gt;alert(&#39;diff-xss&#39;)&lt;/script&gt;");
    expect(html).toContain("diff --git a/src/app.txt");
    expect(html).toContain("（二进制）");
    for (const tag of rawTags(html)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
  });

  it("no candidate yet: an honest empty state without diff or review", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderDiffPanel(container, {
      runId: "run-1",
      nodeId: "c",
      runBaseSha: null,
      candidateSha: null,
      integration: null,
      diff: null,
      review: null
    });
    const html = container.innerHTML;
    expect(html).toContain("尚未产生候选提交");
    expect(html).not.toContain("<pre");
    expect(html).not.toContain("审查绑定");
  });
});

describe("approvalDecisionFailureText — the A17 refusals read as 已失效, never retryable", () => {
  const api = loadPageApi();

  it("maps the typed codes to explicit texts", () => {
    expect(api.approvalDecisionFailureText({ status: 409, code: "APPROVAL_INVALIDATED", message: "候选 SHA 已变化" })).toContain("已失效");
    expect(api.approvalDecisionFailureText({ status: 409, code: "APPROVAL_INVALIDATED", message: "x" })).toContain("A17");
    expect(api.approvalDecisionFailureText({ status: 409, code: "APPROVAL_EXPIRED", message: "x" })).toContain("过期");
    expect(api.approvalDecisionFailureText({ status: 404, code: "NOT_FOUND", message: "x" })).toContain("404");
    expect(api.approvalDecisionFailureText({ status: 403, code: "PROFILE_OVERRIDE_REJECTED", message: "x" })).toContain("A02");
  });

  it("the invalidation vocabulary maps CANDIDATE_CHANGED to the A17 wording", () => {
    expect(api.invalidationTexts(["CANDIDATE_CHANGED"])).toEqual(["候选 SHA 已变化（A17：原审批已无法消费）"]);
    expect(api.invalidationTexts(["EXPIRED"])).toEqual(["已过期（过期审批不可批准）"]);
  });
});

describe("renderContextPanel — layer/trust/truncation inventory", () => {
  const api = loadPageApi();

  it("renders trust classes, truncation markers and the selection order", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderContextPanel(container, {
      runId: "run-1",
      projectId: "proj-1",
      bundles: [
        {
          bundleId: "ctx-bundle-1",
          nodeId: "b",
          roleId: "developer",
          budgetMethod: "estimated-bytes",
          budgetBytes: 4096,
          budgetExceeded: false,
          contentHash: "c".repeat(64),
          manifestHash: "m".repeat(64),
          byteCount: 1024,
          fragmentCount: 3,
          includedCount: 2,
          omittedReasons: ["budget-bytes-exceeded"],
          createdAt: "2026-09-22T00:00:00.000Z",
          fragments: [
            {
              sequence: 0,
              layer: "project_rule",
              layerPriority: 0,
              trust: "policy",
              source: { kind: "project_rule", id: "rule-1", revision: "3", profileId: null, commitSha: null, artifactId: null },
              contentHash: "1".repeat(64),
              contentBytes: 120,
              included: true,
              omittedReason: null,
              trace: { bundleId: "ctx-bundle-1", projectId: "proj-1", runId: "run-1", nodeId: "b", sequence: 0, layer: "project_rule", source: { kind: "project_rule", id: "rule-1", revision: "3", profileId: null, commitSha: null, artifactId: null }, contentHash: "1".repeat(64), contentBytes: 120, included: true, omittedReason: null }
            },
            {
              sequence: 1,
              layer: "memory",
              layerPriority: 4,
              trust: "untrusted-content",
              source: { kind: "memory_entry", id: "mem-1", revision: "4", profileId: null, commitSha: null, artifactId: null },
              contentHash: "2".repeat(64),
              contentBytes: 80,
              included: false,
              omittedReason: "budget-bytes-exceeded",
              trace: { bundleId: "ctx-bundle-1", projectId: "proj-1", runId: "run-1", nodeId: "b", sequence: 1, layer: "memory", source: { kind: "memory_entry", id: "mem-1", revision: "4", profileId: null, commitSha: null, artifactId: null }, contentHash: "2".repeat(64), contentBytes: 80, included: false, omittedReason: "budget-bytes-exceeded" }
            }
          ]
        }
      ]
    });
    const html = container.innerHTML;
    expect(html).toContain("estimated-bytes");
    expect(html).toContain("trust-policy");
    expect(html).toContain("trust-untrusted-content");
    expect(html).toContain("已截断");
    expect(html).toContain("budget-bytes-exceeded");
    expect(html).toContain("入选（层级优先级 0）");
    expect(html).toContain("untrusted-content");
    expect(html).not.toMatch(/<img/i);
    for (const tag of rawTags(html)) {
      expect(ALLOWED_RAW_TAGS.test(tag)).toBe(true);
    }
  });

  it("renders an empty inventory honestly", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderContextPanel(container, { runId: "run-1", projectId: "proj-1", bundles: [] });
    expect(container.innerHTML).toContain("没有已持久化的 context bundle");
  });
});
