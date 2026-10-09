/**
 * M11-07 — the 接入配置管理面 (AI 供应商自定义配置) save chain, browser end
 * to end over a REAL Chromium, against a server whose orchestration is wired
 * to a REAL profiles FILE:
 *
 *   登记项目+向导默认绑定 → 设置·接入配置: 可执行路径填不存在路径 → 保存被
 *   人话拒绝(只读 stat 硬门,配置文件一字不动) → 改填 wrapper 真路径新增
 *   claude-glm(名称「Claude GLM」自动规范化;configDir 尚不存在=如实提示
 *   非阻塞) → 磁盘 3 条目、既有两条逐字段相等 → 编辑超时 900(未载入条目
 *   可自由编辑) → Agent 团队把 开发 切到 (claude, glm-4.6) → 诚实的
 *   bind-pending(新配置未载入,绑定 PUT 不发) → 重启模拟(关服→重读文件→
 *   以载入态重启) → 再保存(绑定落地,DB 断言 developer=claude-glm) →
 *   删除被阻止(仍被该项目「开发」绑定引用,人话列出项目) → 建任务 →
 *   终态 → wrapper 记录的 argv 逐项 == ["-p","--output-format",
 *   "stream-json","--verbose","--model","glm-4.6"] → 改回 (codex, CLI 默认)
 *   → 删除成功(其余条目逐字段保留)。
 *
 * The argv observation plane is the M11-06 fixture pattern: the profile's
 * executable points at a tiny WRAPPER (written by this test into its own
 * temp dir; a TEST FIXTURE, not an engine change) that records
 * process.argv.slice(2) and delegates to the built fake-cli's main() — the
 * engine's spawn path is exercised unmodified. This is ALSO the product's
 * third-party-endpoint story executed for real: the wrapper script is
 * user-supplied, the product only checked its path EXISTS (the read-only
 * stat probe), never its content.
 *
 * The restart is the composition-root restart, same as serve: the RUNNING
 * process never hot-reloads, so the second server starts over the SAME
 * store + the RE-READ profiles file.
 *
 * Authentication: the ADR-010 shell injection, simulated at the context
 * level (setExtraHTTPHeaders), same as app-model-flow.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import {
  Evidence,
  createWorld,
  launchBrowser,
  removeScratchTree,
  WORLD_T0,
  fakeBinPath,
  type BrowserE2eWorld
} from "../src/index.js";
import {
  startLocalApiServer,
  type LocalApiServer,
  type LocalApiServerOptions,
  type OrchestrationOptions
} from "@role-orchestrator/local-api";

const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn("[browser-e2e] non-Windows platform — launcher-driven cells are skipped");
}

const OBJECTIVE = "M11-07 供应商透传:开发者角色按新增接入配置执行";

/** A FRESH git repository (registration must see a never-seen directory). */
function createFreshGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "ro-providerflow-repo-"));
  const git = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "providerflow@example.invalid"]);
  git(["config", "user.name", "provider-flow-fixture"]);
  writeFileSync(join(repoPath, "README.md"), "provider flow fixture\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  return repoPath;
}

/** The argv-recording wrapper: a generated TEST FIXTURE (not a product file,
 * not an engine change). It delegates to the BUILT fake-cli so the engine's
 * protocol pipeline sees a legitimate claude-dialect stream. */
function writeArgvRecordingWrapper(directory: string, fakeCliMainJs: string, argvFile: string): string {
  const wrapperPath = join(directory, "record-argv-provider-cli.mjs");
  const content = `// M11-07 e2e fixture: record the spawned argv, then delegate to fake-cli.
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const { main } = await import(pathToFileURL(${JSON.stringify(fakeCliMainJs)}).href);
const argv = process.argv.slice(2);
writeFileSync(${JSON.stringify(argvFile)}, JSON.stringify(argv), "utf8");
const effective = argv.includes("--scenario") ? argv : [...argv, "--scenario", "success"];
process.exitCode = await main("claude", effective);
`;
  writeFileSync(wrapperPath, content, "utf8");
  return wrapperPath;
}

/** Parse a profiles file the way the serve composition root does at startup. */
function parseProfilesFile(filePath: string): OrchestrationOptions["profiles"] {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
    profiles?: unknown;
  };
  if (!Array.isArray(parsed.profiles)) {
    throw new Error(`test fixture: ${filePath} does not carry a profiles array`);
  }
  return parsed.profiles as OrchestrationOptions["profiles"];
}

async function startServer(world: BrowserE2eWorld, profilesPath: string, worktreesRoot: string): Promise<LocalApiServer> {
  const options: LocalApiServerOptions = {
    db: world.db,
    orchestration: {
      profiles: parseProfilesFile(profilesPath),
      profilesSourcePath: profilesPath,
      worktreesRoot
    }
  };
  return await startLocalApiServer(options);
}

interface DiskProfile {
  id: string;
  runtime: string;
  executable: string;
  executionTarget: string;
  configDir: string;
  model: string | null;
  credentialGroup: string;
  maxConcurrency: number;
  timeoutSeconds: number;
  extraArgs: unknown[];
}

function readDiskProfiles(profilesPath: string): DiskProfile[] {
  return (JSON.parse(readFileSync(profilesPath, "utf8")) as { profiles: DiskProfile[] }).profiles;
}

describe.skipIf(!LAUNCHER_APPLIES)("M11-07 flow: 接入配置新增→路径硬门→编辑→重启→绑定→透传→删除阻止→删除 (browser e2e)", () => {
  test("the provider-CRUD chain lands the new profile in the spawned CLI argv and refuses the referenced delete", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ro-providerflow-scratch-"));
    const worktreesRoot = join(scratch, "worktrees");
    const claudeConfigDir = join(scratch, "config", "claude");
    const codexConfigDir = join(scratch, "config", "codex");
    // The default profiles' config dirs must EXIST (the binding write
    // baselines the revision's external-config manifest from them). The NEW
    // provider's dir deliberately does NOT exist yet — the advisory
    // configDir note (CLI will log in there later) is part of the flow.
    mkdirSync(claudeConfigDir, { recursive: true });
    mkdirSync(codexConfigDir, { recursive: true });
    const glmConfigDir = join(scratch, "config", "glm");
    const argvFile = join(scratch, "last-argv.json");
    const profilesPath = join(scratch, "profiles.json");
    const repoPath = createFreshGitRepo();
    const evidence = Evidence.start("app-provider-flow", {
      "node.js": process.version,
      platform: `${process.platform} ${process.arch}`,
      "clock-base": WORLD_T0,
      note: "M11-07 provider-CRUD e2e: stat hard gate → create/edit → restart → bind → argv carries the model → referenced-delete blocked → delete"
    });
    const world = await createWorld("app-provider-flow");
    evidence.log(`world ready: db=${world.dbPath} repo=${world.repoPath}`);
    const fakeClaudeBin = fakeBinPath("claude");
    const fakeCliMainJs = fakeClaudeBin.replace(/bin[\\/]fake-claude\.js$/, "main.js");
    const wrapperPath = writeArgvRecordingWrapper(scratch, fakeCliMainJs, argvFile);
    evidence.log(`argv wrapper: ${wrapperPath} (delegates to ${fakeCliMainJs})`);

    // The INITIAL profiles file: first-run-shaped defaults pointing at the
    // wrapper / the fake codex bin.
    writeFileSync(
      profilesPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          profiles: [
            {
              id: "claude-default",
              runtime: "claude",
              executable: wrapperPath,
              executionTarget: "windows-native",
              configDir: claudeConfigDir,
              model: null,
              credentialGroup: "providerflow-claude",
              maxConcurrency: 2,
              timeoutSeconds: 600,
              extraArgs: []
            },
            {
              id: "codex-default",
              runtime: "codex",
              executable: fakeBinPath("codex"),
              executionTarget: "windows-native",
              configDir: codexConfigDir,
              model: null,
              credentialGroup: "providerflow-codex",
              maxConcurrency: 2,
              timeoutSeconds: 600,
              extraArgs: []
            }
          ]
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    let server = await startServer(world, profilesPath, worktreesRoot);
    evidence.log(`local-api listening on ${server.boundAddress}:${String(server.port)} (profiles file wired)`);
    const browser = await launchBrowser(evidence);
    const consoleErrors: string[] = [];
    const db: DatabaseSync = world.db;

    const boundRows = (): { role_id: string; profile_id: string }[] =>
      db
        .prepare(
          "SELECT rb.role_id AS role_id, rb.profile_id AS profile_id FROM role_bindings rb " +
            "JOIN projects p ON rb.project_id = p.id WHERE p.repo_root = ? ORDER BY rb.role_id"
        )
        .all(repoPath) as { role_id: string; profile_id: string }[];

    try {
      await browser.context.setExtraHTTPHeaders({ Authorization: `Bearer ${server.token}` });
      browser.page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
      browser.page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.text());
      });
      browser.page.on("response", (response) => {
        const url = response.url();
        if (url.includes("/api/")) {
          evidence.log(`api ${response.request().method()} ${url.replace(/^https?:\/\/[^/]+/, "")} -> ${String(response.status())}`);
        }
      });
      const page = browser.page;
      const appUrl = (): string => `http://127.0.0.1:${String(server.port)}/app`;

      // ---- ① register + bind through the wizard's (CLI×model) editor ----
      await page.goto(appUrl(), { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#wizard-register-dir", { timeout: 15_000 });
      await page.fill("#wizard-register-dir", repoPath);
      await page.click('button:has-text("校验并登记")');
      await page.waitForSelector("text=已登记", { timeout: 20_000 });
      await page.waitForSelector("#role-cli-developer", { timeout: 15_000 });
      await page.click('button:has-text("保存绑定")');
      await page.waitForSelector("text=四个角色已绑定", { timeout: 20_000 });
      evidence.log("four roles bound through the (CLI×model) save (defaults, all targets loaded)");

      // ---- ② settings·接入配置: the stat hard gate -----------------------
      await page.goto(`${appUrl()}/settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#settings-project-select", { timeout: 15_000 });
      const optionValue = await page.$eval(
        "#settings-project-select",
        (element, wanted) => {
          const option = [...(element as HTMLSelectElement).options].find((candidate) =>
            candidate.textContent?.includes(wanted)
          );
          return option?.value ?? "";
        },
        "ro-providerflow-repo-"
      );
      expect(optionValue).not.toBe("");
      await page.waitForSelector('button:has-text("新增接入配置")', { timeout: 15_000 });
      await page.click('button:has-text("新增接入配置")');
      await page.waitForSelector("#provider-id", { timeout: 15_000 });
      await page.fill("#provider-id", "Claude GLM");
      await page.check("#provider-runtime-claude");
      await page.fill("#provider-executable", join(scratch, "definitely", "missing", "wrapper.cmd"));
      await page.fill("#provider-config-dir", glmConfigDir);
      await page.click('button:has-text("保存配置")');
      await page.waitForSelector("text=可执行路径不存在", { timeout: 20_000 });
      // Fail-closed proof: the refused save left the file at exactly the two
      // original entries.
      expect(readDiskProfiles(profilesPath)).toHaveLength(2);
      evidence.log("stat hard gate: missing executable refused with 人话, file untouched");

      // ---- ③ create with the real wrapper: normalization + advisory note -
      await page.fill("#provider-executable", wrapperPath);
      await page.fill("#provider-model", "glm-4.6");
      await page.click('button:has-text("保存配置")');
      await page.waitForSelector("text=已写入配置文件", { timeout: 20_000 });
      // The configDir does not exist yet — the honest ADVISORY note (CLI will
      // log in there later), never a blocker.
      await page.waitForSelector("text=凭据目录当前不存在", { timeout: 15_000 });
      evidence.log("provider created via the UI: id normalized, advisory configDir note shown");

      // The file on disk: 3 entries; the new one carries the normalized id
      // and the exact defaults; the originals are byte-equal.
      const afterCreate = readDiskProfiles(profilesPath);
      expect(afterCreate).toHaveLength(3);
      const glm = afterCreate.find((profile) => profile.id === "claude-glm");
      expect(glm).toEqual({
        id: "claude-glm",
        runtime: "claude",
        executable: wrapperPath,
        executionTarget: "windows-native",
        configDir: glmConfigDir,
        model: "glm-4.6",
        credentialGroup: "claude-glm",
        maxConcurrency: 4,
        timeoutSeconds: 1800,
        extraArgs: []
      });
      expect(afterCreate.find((profile) => profile.id === "claude-default")).toEqual({
        id: "claude-default",
        runtime: "claude",
        executable: wrapperPath,
        executionTarget: "windows-native",
        configDir: claudeConfigDir,
        model: null,
        credentialGroup: "providerflow-claude",
        maxConcurrency: 2,
        timeoutSeconds: 600,
        extraArgs: []
      });
      evidence.log("disk after create: 3 entries; claude-glm exact; claude-default byte-equal");

      // The list face shows the new entry with the honest pending badge.
      const pendingRow = await page.textContent(".app-main");
      expect(pendingRow ?? "").toContain("待重启载入");

      // ---- ④ edit the NOT-loaded entry (timeout 600→...→900) -------------
      await page.click('.provider-row:has-text("claude-glm") button:has-text("编辑")');
      await page.waitForSelector('[data-testid="provider-id-fixed"]', { timeout: 15_000 });
      // Edit mode pins the id read-only (改名=删旧建新).
      const fixedId = await page.textContent('[data-testid="provider-id-fixed"]');
      expect(fixedId).toBe("claude-glm");
      // The timeout field lives in the collapsed 高级 fold — open it.
      await page.click(".provider-form details.advanced-box summary");
      await page.waitForSelector("#provider-timeout", { timeout: 15_000 });
      await page.fill("#provider-timeout", "900");
      await page.click('button:has-text("保存配置")');
      await page.waitForSelector("text=已更新到配置文件", { timeout: 20_000 });
      const afterEdit = readDiskProfiles(profilesPath);
      expect(afterEdit.find((profile) => profile.id === "claude-glm")?.timeoutSeconds).toBe(900);
      expect(afterEdit).toHaveLength(3);
      evidence.log("edit (not-loaded entry): timeout 900 written; still 3 entries");

      // ---- ⑤ team: developer → (claude, glm-4.6) → honest bind-pending ---
      await page.selectOption("#settings-project-select", optionValue);
      await page.waitForSelector('button:has-text("修改")', { timeout: 15_000 });
      await page.click('button:has-text("修改")');
      await page.waitForSelector("#role-cli-developer", { timeout: 15_000 });
      await page.selectOption("#role-cli-developer", "claude");
      await page.selectOption("#role-model-developer", "glm-4.6");
      await page.click('button:has-text("保存绑定")');
      await page.waitForSelector("text=本次没有改动该项目的绑定", { timeout: 20_000 });
      expect(boundRows().find((row) => row.role_id === "developer")?.profile_id).toBe("codex-default");
      evidence.log("team save: combo reused (no file write), binding honestly deferred (pending restart)");

      // ---- ⑥ restart: close → re-read the file → start over -------------
      // The user's counterpart act to the advisory note: the configDir comes
      // into existence BEFORE the profile is bound (the binding write
      // baselines the revision's external-config manifest from it — a
      // missing dir is a hard stop at bind time, which is exactly what the
      // note tells the user).
      mkdirSync(glmConfigDir, { recursive: true });
      await server.close();
      evidence.log("server closed (restart simulation)");
      server = await startServer(world, profilesPath, worktreesRoot);
      evidence.log(`server restarted on ${server.boundAddress}:${String(server.port)} with the re-read profiles file`);
      await browser.context.setExtraHTTPHeaders({ Authorization: `Bearer ${server.token}` });

      // ---- ⑦ re-save the team selection: the binding PUT lands ----------
      await page.goto(`${appUrl()}/settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#settings-project-select", { timeout: 15_000 });
      await page.selectOption("#settings-project-select", optionValue);
      await page.waitForSelector('button:has-text("修改")', { timeout: 15_000 });
      await page.click('button:has-text("修改")');
      await page.waitForSelector("#role-cli-developer", { timeout: 15_000 });
      await page.selectOption("#role-cli-developer", "claude");
      await page.selectOption("#role-model-developer", "glm-4.6");
      await page.click('button:has-text("保存绑定")');
      await page.waitForSelector("text=对该项目的新建任务立即生效", { timeout: 20_000 });
      expect(boundRows().find((row) => row.role_id === "developer")?.profile_id).toBe("claude-glm");
      evidence.log("post-restart rebind: developer=claude-glm in the DB");

      // ---- ⑧ delete is BLOCKED while a project still binds it -----------
      await page.click('.provider-row:has-text("claude-glm") button:has-text("删除")');
      await page.waitForSelector('button:has-text("确认删除")', { timeout: 15_000 });
      await page.click('button:has-text("确认删除")');
      await page.waitForSelector("text=删除被阻止", { timeout: 20_000 });
      const blockedText = await page.textContent(".app-main");
      expect(blockedText ?? "").toContain("仍被角色绑定引用");
      expect(blockedText ?? "").toContain("ro-providerflow-repo-");
      expect(blockedText ?? "").toContain("开发");
      expect(readDiskProfiles(profilesPath)).toHaveLength(3);
      evidence.log("delete blocked with the referencing project + role listed; file untouched");

      // ---- ⑨ the task runs on the new provider; argv carries the model --
      await page.goto(appUrl(), { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#new-task-project", { timeout: 15_000 });
      await page.waitForSelector("text=四个角色已绑定", { timeout: 15_000 });
      await page.fill("#new-task-objective", OBJECTIVE);
      await page.click('button:has-text("开始执行")');
      await page.waitForURL(/\/app\/runs\//, { timeout: 20_000 });
      evidence.log(`task created, navigated to ${page.url()}`);
      await page.waitForSelector(".timeline-node", { timeout: 15_000 });
      await page.waitForFunction(
        () => {
          const badges = [...document.querySelectorAll(".timeline-node .status-badge")];
          return badges.some((badge) => (badge.textContent ?? "").includes("已完成"));
        },
        undefined,
        { timeout: 120_000 }
      );
      evidence.log("run reached terminal state: node badge 已完成");

      const recorded = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
      expect(recorded).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--model", "glm-4.6"]);
      evidence.log(`spawned CLI argv: ${JSON.stringify(recorded)}`);

      // ---- ⑩ unbind, then the delete goes through ------------------------
      await page.goto(`${appUrl()}/settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#settings-project-select", { timeout: 15_000 });
      await page.selectOption("#settings-project-select", optionValue);
      await page.waitForSelector('button:has-text("修改")', { timeout: 15_000 });
      await page.click('button:has-text("修改")');
      await page.waitForSelector("#role-cli-developer", { timeout: 15_000 });
      await page.selectOption("#role-cli-developer", "codex");
      await page.selectOption("#role-model-developer", "");
      await page.click('button:has-text("保存绑定")');
      await page.waitForSelector("text=对该项目的新建任务立即生效", { timeout: 20_000 });
      expect(boundRows().find((row) => row.role_id === "developer")?.profile_id).toBe("codex-default");

      await page.click('.provider-row:has-text("claude-glm") button:has-text("删除")');
      await page.waitForSelector('button:has-text("确认删除")', { timeout: 15_000 });
      await page.click('button:has-text("确认删除")');
      await page.waitForSelector("text=已从配置文件移除", { timeout: 20_000 });
      const afterDelete = readDiskProfiles(profilesPath);
      expect(afterDelete).toHaveLength(2);
      expect(afterDelete.map((profile) => profile.id).sort()).toEqual(["claude-default", "codex-default"]);
      expect(afterDelete.find((profile) => profile.id === "codex-default")).toEqual({
        id: "codex-default",
        runtime: "codex",
        executable: fakeBinPath("codex"),
        executionTarget: "windows-native",
        configDir: codexConfigDir,
        model: null,
        credentialGroup: "providerflow-codex",
        maxConcurrency: 2,
        timeoutSeconds: 600,
        extraArgs: []
      });
      evidence.log("delete after unbind: file back to the 2 originals, codex-default byte-equal");

      // ---- console cleanliness (same filter as app-model-flow) -----------
      const unexpected = consoleErrors.filter((message) => !/Failed to load resource.*403/.test(message));
      expect(unexpected).toEqual([]);
      for (const message of consoleErrors) {
        evidence.log(`console entry: ${message}`);
      }
    } finally {
      await browser.close();
      await server.close();
      evidence.log("local-api server closed");
      world.close();
      await removeScratchTree(world.fixture.scratchDir);
      evidence.log(`world scratch removed: ${world.fixture.scratchDir}`);
      if (existsSync(scratch)) rmSync(scratch, { recursive: true, force: true });
      evidence.log(`provider-flow scratch removed: ${scratch}`);
      evidence.close(
        "M11-07 /app provider flow: stat gate → create/edit → restart → bind → argv carries --model glm-4.6 → referenced-delete blocked → unbind → delete"
      );
    }
  });
});
