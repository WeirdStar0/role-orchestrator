/**
 * M11-06 — the model-selection save flow, browser end to end over a REAL
 * Chromium, against a server whose orchestration is wired to a REAL profiles
 * FILE (the M9-03 GET/PUT /api/v1/profiles/full pair is the save's
 * write-back primitive — in-process definitions alone would 409 it):
 *
 *   登记项目 → 向导绑定步 ((CLI×模型) 编辑器,模板预填=CLI+默认) 保存
 *   → 设置页把 开发 角色改为 (Claude, sonnet) → 保存 = 配置文件 upsert
 *   (新增 claude-sonnet,既有条目逐字节保留) + 绑定诚实地"待重启"
 *   (新 profile 未载入,绑定 PUT 不发,不硬打一个必然 422 的请求)
 *   → 重启模拟 (关服→重读文件→以载入态重启,serve 启动语义同构)
 *   → 再次保存 (绑定事务切换成功) → 建任务 (fake-cli 面) → 终态
 *   → 断言 CLI argv 逐项 == ["-p","--output-format","stream-json",
 *     "--verbose","--model","sonnet"] —— model 透传到子进程 argv 的端到端证据。
 *
 * The argv observation plane: the profiles entries point at a tiny WRAPPER
 * script (written by this test into its own temp dir; a TEST FIXTURE, not an
 * engine change) that records `process.argv.slice(2)` to a file and then
 * delegates to the built fake-cli's main() — the engine's spawn path
 * (lifecycle.ts spawn → invocation.ts dialectProtocolArgs) is exercised
 * unmodified; the wrapper only makes the argv VISIBLE (fake-cli itself
 * accepts-and-discards --model, args.ts:22-25, and records nothing).
 *
 * The restart is the composition-root restart, same as serve: the RUNNING
 * process never hot-reloads (server.ts serveProfilesFullPut note), so the
 * second server is started over the SAME store + the RE-READ profiles file —
 * exactly what `serve --profiles` does at startup.
 *
 * Authentication: the ADR-010 shell injection, simulated at the context
 * level (setExtraHTTPHeaders), same as app-product-flow.
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
  type BrowserE2eWorld
} from "../src/index.js";
import { fakeBinPath } from "../src/index.js";
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

const OBJECTIVE = "M11-06 模型透传:开发者角色按所选模型执行";

/** A FRESH git repository (registration must see a never-seen directory). */
function createFreshGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), "ro-modelflow-repo-"));
  const git = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: repoPath, stdio: "ignore" });
  };
  git(["init"]);
  git(["config", "user.email", "modelflow@example.invalid"]);
  git(["config", "user.name", "model-flow-fixture"]);
  writeFileSync(join(repoPath, "README.md"), "model flow fixture\n", "utf8");
  git(["add", "."]);
  git(["commit", "-m", "base"]);
  return repoPath;
}

/**
 * The argv-recording wrapper: a generated TEST FIXTURE (not a product file,
 * not an engine change). It delegates to the BUILT fake-cli so the engine's
 * protocol pipeline sees a legitimate claude-dialect stream.
 */
function writeArgvRecordingWrapper(directory: string, fakeCliMainJs: string, argvFile: string): string {
  const wrapperPath = join(directory, "record-argv-cli.mjs");
  const content = `// M11-06 e2e fixture: record the spawned argv, then delegate to fake-cli.
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

/** Parse a profiles file the way the serve composition root does at startup
 * (the frozen shape; the in-process options carry no invocationArgs — the
 * file-loaded default). */
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

describe.skipIf(!LAUNCHER_APPLIES)("M11-06 flow: 模型选择保存 → 重启 → 再保存 → 任务按所选模型执行 (browser e2e)", () => {
  test("the (CLI×model) save chain lands the model flag in the spawned CLI argv", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "ro-modelflow-scratch-"));
    const worktreesRoot = join(scratch, "worktrees");
    const configDir = join(scratch, "config", "claude");
    const codexConfigDir = join(scratch, "config", "codex");
    // The profile config dirs must EXIST: the binding write baselines the
    // revision's external-config manifest from them (run-creation.ts
    // ensureProfileRevision → createProfileRevision hashes what exists).
    mkdirSync(configDir, { recursive: true });
    mkdirSync(codexConfigDir, { recursive: true });
    const argvFile = join(scratch, "last-argv.json");
    const profilesPath = join(scratch, "profiles.json");
    const repoPath = createFreshGitRepo();
    const evidence = Evidence.start("app-model-flow", {
      "node.js": process.version,
      platform: `${process.platform} ${process.arch}`,
      "clock-base": WORLD_T0,
      note: "M11-06 model-selection e2e: file upsert → restart → rebind → spawn argv carries the model"
    });
    const world = await createWorld("app-model-flow");
    evidence.log(`world ready: db=${world.dbPath} repo=${world.repoPath}`);
    // The wrapper delegates to fake-cli's dist main.js (the bin is dist/bin/fake-claude.js).
    const fakeClaudeBin = fakeBinPath("claude");
    const fakeCliMainJs = fakeClaudeBin.replace(/bin[\\/]fake-claude\.js$/, "main.js");
    const wrapperPath = writeArgvRecordingWrapper(scratch, fakeCliMainJs, argvFile);
    evidence.log(`argv wrapper: ${wrapperPath} (delegates to ${fakeCliMainJs})`);

    // The INITIAL profiles file: first-run-shaped defaults (id <cli>-default,
    // model null) pointing at the wrapper — combos the wizard's template
    // prefill reuses, nothing model-custom yet.
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
              configDir,
              model: null,
              credentialGroup: "modelflow-claude",
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
              credentialGroup: "modelflow-codex",
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
      // The template prefill: CLI chosen, model at CLI 默认 (value "").
      const devCli = await page.$eval("#role-cli-developer", (element) => (element as HTMLSelectElement).value);
      const devModel = await page.$eval("#role-model-developer", (element) => (element as HTMLSelectElement).value);
      expect(devCli).toBe("codex");
      expect(devModel).toBe("");
      evidence.log(`wizard prefill: developer=(${devCli}, ${devModel === "" ? "CLI 默认" : devModel})`);
      await page.click('button:has-text("保存绑定")');
      await page.waitForSelector("text=四个角色已绑定", { timeout: 20_000 });
      evidence.log("four roles bound through the (CLI×model) save (combo reuse, all targets loaded)");

      // ---- ② settings: switch 开发 to (Claude, sonnet) -------------------
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
        "ro-modelflow-repo-"
      );
      expect(optionValue).not.toBe("");
      await page.selectOption("#settings-project-select", optionValue);
      await page.waitForSelector('button:has-text("修改")', { timeout: 15_000 });
      await page.click('button:has-text("修改")');
      await page.waitForSelector("#role-cli-developer", { timeout: 15_000 });
      await page.selectOption("#role-cli-developer", "claude");
      await page.selectOption("#role-model-developer", "sonnet");
      await page.click('button:has-text("保存绑定")');
      // The honest pending state: the file was written, the binding PUT was
      // NOT fired (the minted profile is not loaded), and the restart-
      // and-resave instruction is on the page.
      await page.waitForSelector("text=写入配置文件", { timeout: 20_000 });
      const pendingText = await page.textContent(".app-main");
      expect(pendingText ?? "").toContain("重启桌面应用");
      expect(pendingText ?? "").toContain("再点一次「保存」");
      evidence.log("save #1: claude-sonnet written to the file; binding honestly deferred (pending restart)");

      // The file on disk: ADD-ONLY merge — both original entries preserved,
      // the minted entry cloned from the same-runtime base.
      const afterSave = JSON.parse(readFileSync(profilesPath, "utf8")) as {
        profiles: { id: string; runtime: string; model: string | null; executable: string; configDir: string; credentialGroup: string; maxConcurrency: number; timeoutSeconds: number; extraArgs: unknown[] }[];
      };
      expect(afterSave.profiles).toHaveLength(3);
      const minted = afterSave.profiles.find((profile) => profile.id === "claude-sonnet");
      expect(minted).toBeDefined();
      expect(minted?.model).toBe("sonnet");
      expect(minted?.runtime).toBe("claude");
      expect(minted?.executable).toBe(wrapperPath);
      expect(minted?.configDir).toBe(configDir);
      expect(minted?.credentialGroup).toBe("modelflow-claude");
      const untouchedCodex = afterSave.profiles.find((profile) => profile.id === "codex-default");
      expect(untouchedCodex).toEqual({
        id: "codex-default",
        runtime: "codex",
        executable: fakeBinPath("codex"),
        executionTarget: "windows-native",
        configDir: codexConfigDir,
        model: null,
        credentialGroup: "modelflow-codex",
        maxConcurrency: 2,
        timeoutSeconds: 600,
        extraArgs: []
      });
      const untouchedClaude = afterSave.profiles.find((profile) => profile.id === "claude-default");
      expect(untouchedClaude?.model).toBeNull();
      evidence.log("file after save #1: 3 entries; codex-default byte-equal; claude-sonnet cloned from claude-default");

      // The DB kept the OLD binding (the pending path never wrote one) —
      // scoped to THIS project (the world pre-seeds bindings for its own
      // seeded project, which must not leak into the assertion).
      const boundBefore = db
        .prepare(
          "SELECT rb.role_id AS role_id, rb.profile_id AS profile_id FROM role_bindings rb " +
            "JOIN projects p ON rb.project_id = p.id WHERE p.repo_root = ? ORDER BY rb.role_id"
        )
        .all(repoPath) as { role_id: string; profile_id: string }[];
      expect(boundBefore.find((row) => row.role_id === "developer")?.profile_id).toBe("codex-default");
      evidence.log("binding rows untouched by the pending save (developer still codex-default)");

      // ---- ③ restart: the composition-root restart (close → re-read →
      // start over the SAME store + profiles file; the serve --profiles
      // startup semantics, no hot reload anywhere) -------------------------
      await server.close();
      evidence.log("server closed (restart simulation)");
      server = await startServer(world, profilesPath, worktreesRoot);
      evidence.log(`server restarted on ${server.boundAddress}:${String(server.port)} with the re-read profiles file`);
      await browser.context.setExtraHTTPHeaders({ Authorization: `Bearer ${server.token}` });

      // ---- ④ settings again: the same selections now save the binding ----
      await page.goto(`${appUrl()}/settings`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector("#settings-project-select", { timeout: 15_000 });
      await page.selectOption("#settings-project-select", optionValue);
      await page.waitForSelector('button:has-text("修改")', { timeout: 15_000 });
      await page.click('button:has-text("修改")');
      await page.waitForSelector("#role-cli-developer", { timeout: 15_000 });
      // The prefill reflects the CURRENT binding (developer still codex-default
      // → Codex); switch it back to the saved combo and save.
      await page.selectOption("#role-cli-developer", "claude");
      await page.selectOption("#role-model-developer", "sonnet");
      await page.click('button:has-text("保存绑定")');
      await page.waitForSelector("text=对该项目的新建任务立即生效", { timeout: 20_000 });
      evidence.log("save #2 (post-restart): binding PUT landed; claude-sonnet now loaded AND bound");
      const boundAfter = db
        .prepare(
          "SELECT rb.role_id AS role_id, rb.profile_id AS profile_id FROM role_bindings rb " +
            "JOIN projects p ON rb.project_id = p.id WHERE p.repo_root = ? ORDER BY rb.role_id"
        )
        .all(repoPath) as { role_id: string; profile_id: string }[];
      expect(boundAfter.find((row) => row.role_id === "developer")?.profile_id).toBe("claude-sonnet");

      // ---- ⑤ the task: runs on the bound profile; argv carries the model -
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

      // THE assertion of the batch: the spawned CLI argv (recorded by the
      // wrapper at process start) is EXACTLY the engine's claude protocol
      // args plus the model flag — the model traveled file → revision →
      // frozen snapshot → dialectProtocolArgs → spawn, end to end.
      const recorded = JSON.parse(readFileSync(argvFile, "utf8")) as string[];
      expect(recorded).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--model", "sonnet"]);
      evidence.log(`spawned CLI argv: ${JSON.stringify(recorded)}`);

      // ---- console cleanliness (same filter as app-product-flow) ---------
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
      evidence.log(`model-flow scratch removed: ${scratch}`);
      evidence.close("M11-06 /app model flow: upsert save → restart → rebind → task runs with --model sonnet in argv");
    }
  });
});
