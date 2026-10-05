/**
 * M10-03 flow 8 — the four-role binding UI, browser end to end (the external
 * review's UX gap closed: 建任务 → 422 → 手动调 API becomes 建任务 → 引导 →
 * 配置页一次保存):
 *
 *   工作台(已绑定基线): Developer 绑定显示,表单可用
 *   工作台(未登记目录): 表单保持可用 → 首次创建以 422 登记项目(登记信号,
 *   非故障) → 同目录转入「尚未绑定」→ 表单置灰 + 指向配置页签(422 惊吓消除)
 *   配置页: 读取当前绑定(下拉 = GET /api/v1/profiles;当前值 = world 预绑
 *   profile,select 预选) → 未选满保存被 UI 门拒绝(无网络往返) → 四角色各选
 *   一个 profile 一次保存(PUT /api/v1/projects/:id/role-bindings,页面自带
 *   CSRF 流程) → 404 引导(未登记目录: 还没有项目记录)
 *   工作台: 同目录重新读取 → 新 Developer 绑定显示,表单保持可用。
 *
 * Hermetic: no CLI is ever spawned by THIS flow — binding reads/writes and
 * the refused create never reach the launcher (creation refuses 422
 * fail-closed before any execution machinery).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  fakeBinPath,
  openWorkbenchPage,
  openConfigPage,
  readDeveloperBinding,
  readCreateFormGate,
  fillCreateRunForm,
  submitCreateRun,
  loadRoleBindings,
  readBindingsPanel,
  selectBinding,
  saveRoleBindings,
  type LocalPageTarget
} from "../src/index.js";
import { startHarness } from "./helpers.js";

const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[browser-e2e] non-Windows platform — launcher-driven cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}

const DEV_PROFILE_ID = "profile-mnui-dev";
const OTHER_PROFILE_ID = "profile-mnui-other";
/** The world's own pre-bound developer profile (world.ts WORLD_ROLE_BINDINGS). */
const WORLD_CODEX_PROFILE_ID = "profile-e2e-codex";

function mkdtemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `ro-${prefix}-`));
}

/**
 * A real, MINIMAL git repository with NO project record (the registration
 * probe's target — the 422 fires only after the backend's git-baseline gate,
 * so the directory must actually be a git repo).
 */
function makeUnregisteredGitRepo(prefix: string): string {
  const dir = mkdtemp(prefix);
  const run = (args: readonly string[]): void => {
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  };
  run(["init"]);
  run(["config", "user.email", "flow8@example.invalid"]);
  run(["config", "user.name", "flow8"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "note.txt"), "flow8 unregistered repo", "utf8");
  run(["add", "src/note.txt"]);
  run(["commit", "-m", "flow8 base"]);
  return dir;
}

describe.skipIf(!LAUNCHER_APPLIES)("M10-03 flow 8: 四角色绑定 UI 与表单门控 (browser e2e)", () => {
  test("gate (incomplete disables / register enables) -> configure once -> form ready", async () => {
    const worktreesRoot = mkdtemp("ro-flow8-wt-");
    const configDir = mkdtemp("ro-flow8-cfg-");
    const unknownDir = makeUnregisteredGitRepo("ro-flow8-unregistered-");
    const harness = await startHarness("flow-8-bindings", {
      orchestration: {
        worktreesRoot,
        profiles: [
          {
            id: DEV_PROFILE_ID,
            runtime: "claude",
            executable: fakeBinPath("claude"),
            executionTarget: "windows-native",
            configDir,
            model: null,
            credentialGroup: "mnui-dev",
            maxConcurrency: 2,
            timeoutSeconds: 600,
            extraArgs: []
          },
          {
            id: OTHER_PROFILE_ID,
            runtime: "codex",
            executable: fakeBinPath("codex"),
            executionTarget: "windows-native",
            configDir,
            model: null,
            credentialGroup: "mnui-other",
            maxConcurrency: 2,
            timeoutSeconds: 600,
            extraArgs: []
          }
        ]
      }
    });
    const { server, browser, evidence, world } = harness;
    try {
      const target: LocalPageTarget = { port: server.port, token: server.token };
      const page = browser.page;

      await openWorkbenchPage(page, target);
      evidence.log("workbench open (world project pre-bound to the world profiles)");

      // ---- bound baseline: the readout names the bound profile, form ready
      await readDeveloperBinding(page, world.repoPath, "本项目 Developer 角色");
      let gate = await readCreateFormGate(page);
      expect(gate.objectiveDisabled).toBe(false);
      expect(gate.submitDisabled).toBe(false);
      expect(gate.gateHintVisible).toBe(false);

      // ---- unknown directory: the form stays ENABLED (registration probe)
      const unknownBinding = await readDeveloperBinding(page, unknownDir, "还没有项目记录");
      expect(unknownBinding).toContain("还没有项目记录");
      gate = await readCreateFormGate(page);
      expect(gate.objectiveDisabled).toBe(false);
      expect(gate.submitDisabled).toBe(false);
      expect(gate.gateHintVisible).toBe(false);

      // ---- the registration create: the typed 422 guidance, no dead end
      await fillCreateRunForm(page, { objective: "flow8 登记:未绑定目录的首次创建", projectDir: unknownDir });
      const registration = await submitCreateRun(page);
      expect(registration).toContain("422");
      expect(registration).toContain("绑定");
      evidence.log(`registration create refused as designed: ${registration.slice(0, 60)}…`);
      // The registered directory now reads as incomplete -> GATED with the
      // pointer at the 配置 tab (the 422 surprise is gone: the form says so
      // BEFORE any round trip).
      await readDeveloperBinding(page, unknownDir, "尚未绑定");
      gate = await readCreateFormGate(page);
      expect(gate.objectiveDisabled).toBe(true);
      expect(gate.submitDisabled).toBe(true);
      expect(gate.gateHintVisible).toBe(true);
      expect(gate.gateHintText).toContain("配置");
      await evidence.screenshot(page, "form-gated-incomplete");

      // ---- 配置 tab: read the world project's current bindings -------------
      await openConfigPage(page);
      const loaded = await loadRoleBindings(page, world.repoPath);
      expect(loaded.projectId).toBe(world.projectId);
      expect(loaded.rows.map((row) => row.role)).toEqual([
        "coordinator",
        "architect",
        "developer",
        "reviewer"
      ]);
      // The dropdowns carry every LOADED profile plus the placeholder. The
      // world's pre-binding points at DB-known profiles this CONFIG does not
      // load, so the placeholder holds — and the current-binding column
      // still shows the DURABLE truth (readout vs offerable options).
      for (const row of loaded.rows) {
        expect(row.options).toContain("");
        expect(row.options).toContain(DEV_PROFILE_ID);
        expect(row.options).toContain(OTHER_PROFILE_ID);
        expect(row.options).not.toContain(WORLD_CODEX_PROFILE_ID);
      }
      expect(loaded.rows.find((row) => row.role === "developer")?.value).toBe("");
      expect(loaded.rows.find((row) => row.role === "developer")?.currentText).toContain(
        WORLD_CODEX_PROFILE_ID
      );
      await evidence.screenshot(page, "bindings-loaded");

      // ---- UI allowlist gate: saving with a cleared role refuses locally --
      await selectBinding(page, "developer", "");
      const refused = await saveRoleBindings(page);
      expect(refused.saveStatus).toContain("拒绝");
      expect(refused.saveStatus).toContain("尚未选择 profile");
      expect(refused.saveStatus).toContain("coordinator"); // the first missing role

      // ---- one save rebinds all four (the page's own CSRF flow) -----------
      await selectBinding(page, "coordinator", DEV_PROFILE_ID);
      await selectBinding(page, "developer", DEV_PROFILE_ID);
      await selectBinding(page, "architect", OTHER_PROFILE_ID);
      await selectBinding(page, "reviewer", OTHER_PROFILE_ID);
      const saved = await saveRoleBindings(page);
      evidence.log(`save status: ${saved.saveStatus.slice(0, 60)}…`);
      expect(saved.saveStatus).toContain("已保存四角色绑定");
      // The page's own reload re-reads the durable bindings.
      const reloaded = await readBindingsPanel(page);
      expect(reloaded.projectId).toBe(world.projectId);
      expect(reloaded.rows.find((row) => row.role === "developer")?.value).toBe(DEV_PROFILE_ID);
      expect(reloaded.rows.find((row) => row.role === "developer")?.currentText).toContain(DEV_PROFILE_ID);
      expect(reloaded.rows.find((row) => row.role === "architect")?.value).toBe(OTHER_PROFILE_ID);
      await evidence.screenshot(page, "bindings-saved");

      // ---- 404 guidance: a directory with no project record ---------------
      const neverDir = makeUnregisteredGitRepo("ro-flow8-never-");
      const absent = await loadRoleBindings(page, neverDir);
      expect(absent.projectId).toBe("");
      expect(absent.panelText).toContain("还没有项目记录");
      expect(absent.topStatus).toContain("404");
      await evidence.screenshot(page, "bindings-absent");

      // ---- back to the workbench: the readout names the NEW binding -------
      await page.click("#tab-workbench");
      await page.waitForSelector("#tab-workbench-page:not([hidden])");
      const bound = await readDeveloperBinding(page, world.repoPath, DEV_PROFILE_ID);
      expect(bound).toContain("本项目 Developer 角色");
      gate = await readCreateFormGate(page);
      expect(gate.objectiveDisabled).toBe(false);
      expect(gate.submitDisabled).toBe(false);
      expect(gate.gateHintVisible).toBe(false);
      await evidence.screenshot(page, "form-ready-rebound");

      await harness.close("flow 8 bindings UI: OK");
    } catch (error) {
      await harness.close(`flow 8 bindings UI FAILED: ${String(error)}`);
      throw error;
    } finally {
      for (const dir of [worktreesRoot, configDir, unknownDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort scratch cleanup; never masks a test result
        }
      }
    }
  }, 180_000);
});
