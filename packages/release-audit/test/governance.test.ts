import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inventoryGovernance } from "../src/governance.js";
import { makeTmpRoot, writeTree } from "./helpers.js";

const PLACEHOLDER_CODEOWNERS = [
  "# Template only. Replace with verified GitHub handles before public release.",
  "# This commented file currently enforces no ownership.",
  "# * @YOUR_GITHUB_HANDLE",
  "# /AGENTS.md @YOUR_GITHUB_HANDLE",
  ""
].join("\n");

const SECURITY_DOC = [
  "# 安全政策",
  "",
  "## 报告渠道",
  "",
  "公开仓库发布之前，维护者必须启用并验证 GitHub private vulnerability reporting，",
  "或填写实际可用的私密安全联系方式。当前文档不虚构邮箱。",
  "渠道未配置前不要公开发布。",
  ""
].join("\n");

describe("inventoryGovernance", () => {
  it("a comment-only CODEOWNERS is placeholder-only: zero enforceable rules", () => {
    const root = makeTmpRoot("ro-audit-gov-");
    writeTree(root, {
      ".github/CODEOWNERS": PLACEHOLDER_CODEOWNERS,
      "SECURITY.md": SECURITY_DOC
    });
    const result = inventoryGovernance({ repoRoot: root });
    expect(result.codeowners.exists).toBe(true);
    expect(result.codeowners.status).toBe("placeholder-only");
    expect(result.codeowners.activeRules).toEqual([]);
    expect(result.codeowners.placeholderLines).toBeGreaterThan(0);
  });

  it("an active CODEOWNERS rule is detected as rules-present (no false pending state)", () => {
    const root = makeTmpRoot("ro-audit-gov-rules-");
    writeTree(root, {
      ".github/CODEOWNERS": `# comment\n* @real-maintainer\n`,
      "SECURITY.md": SECURITY_DOC
    });
    const result = inventoryGovernance({ repoRoot: root });
    expect(result.codeowners.status).toBe("rules-present");
    expect(result.codeowners.activeRules).toEqual(["* @real-maintainer"]);
  });

  it("a documented-but-unconfigured private channel stays not-configured-documented", () => {
    const root = makeTmpRoot("ro-audit-gov-sec-");
    writeTree(root, { "SECURITY.md": SECURITY_DOC });
    const result = inventoryGovernance({ repoRoot: root });
    expect(result.privateChannel.exists).toBe(true);
    expect(result.privateChannel.statesChannelNotConfigured).toBe(true);
    expect(result.privateChannel.contactPointsFound).toEqual([]);
    expect(result.privateChannel.status).toBe("not-configured-documented");
  });

  it("a concrete contact point in SECURITY.md is surfaced, never hidden", () => {
    const root = makeTmpRoot("ro-audit-gov-mail-");
    writeTree(root, { "SECURITY.md": `${SECURITY_DOC}\nContact: security@example.com\n` });
    const result = inventoryGovernance({ repoRoot: root });
    expect(result.privateChannel.contactPointsFound).toEqual(["security@example.com"]);
    expect(result.privateChannel.status).toBe("contact-points-present");
  });

  it("license formalization and release approval can only report maintainer-pending until the files exist", () => {
    const root = makeTmpRoot("ro-audit-gov-lic-");
    writeTree(root, { "SECURITY.md": SECURITY_DOC });
    const pending = inventoryGovernance({ repoRoot: root });
    expect(pending.licenseDecision.status).toBe("pending-maintainer-confirmation");
    expect(pending.licenseDecision.exists).toBe(false);
    expect(pending.releaseApproval.status).toBe("pending-maintainer");

    writeFileSync(path.join(root, "LICENSE"), "Apache License\n");
    const done = inventoryGovernance({ repoRoot: root });
    expect(done.licenseDecision.status).toBe("formalized");
  });

  it("a not-filled MAINTAINERS.md keeps maintainerIdentityRecorded false", () => {
    const root = makeTmpRoot("ro-audit-gov-mnt-");
    writeTree(root, {
      "SECURITY.md": SECURITY_DOC,
      "MAINTAINERS.md": "GitHub handle、正式仓库组织、公开联系渠道、安全私密渠道尚未填写，\n"
    });
    const result = inventoryGovernance({ repoRoot: root });
    expect(result.maintainerIdentityRecorded).toBe(false);
  });
});
