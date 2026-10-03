/**
 * M9-03 review handover #58 — the profiles CONFIG page, browser end to end
 * (flow 7; the page surface M9-03 shipped, now driven through a REAL
 * Chromium):
 *
 *   打开配置页 (tab-config) -> 载入当前配置 (GET /api/v1/profiles/full:
 *   编辑器逐字等于盘上文件 + 解析摘要) -> 编辑 (maxConcurrency 2 -> 4)
 *   -> 保存 (PUT, 页面自带 CSRF 流程, 原子写回成功) -> 重载确认
 *   (编辑器 = 修改后内容) -> 节点侧真相 (盘上字节逐字等于修改后内容)。
 *
 * The harness server runs WITH orchestration AND a profilesSourcePath (the
 * in-process composition root of profiles-full.test.ts) — without a source
 * path the config page honestly answers 409 and there is nothing to edit.
 * Hermetic: no CLI is ever spawned by THIS flow (the config routes only
 * view/atomically write the profiles source file).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  openWorkbenchPage,
  openConfigPage,
  loadProfilesFull,
  saveProfilesFull,
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

const CONFIG_PROFILE_ID = "profile-cfg-claude";

function profilesJson(maxConcurrency: number, configDir: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    profiles: [
      {
        id: CONFIG_PROFILE_ID,
        runtime: "claude",
        executable: "C:/tmp/fake-claude.cmd",
        executionTarget: "windows-native",
        configDir,
        model: null,
        credentialGroup: "cfg-claude",
        maxConcurrency,
        timeoutSeconds: 600,
        extraArgs: []
      }
    ]
  });
}

describe.skipIf(!LAUNCHER_APPLIES)("M9-03 #58 flow 7: 配置页编辑-写回-重载 (browser e2e)", () => {
  test("open -> edit -> atomic save -> reload confirms, disk bytes match", async () => {
    const worktreesRoot = mkdtempSync(join(tmpdir(), "ro-flow7-wt-"));
    const configDir = mkdtempSync(join(tmpdir(), "ro-flow7-cfg-"));
    const sourceDir = mkdtempSync(join(tmpdir(), "ro-flow7-src-"));
    const profilesFile = join(sourceDir, "profiles.json");
    const fileText = profilesJson(2, configDir);
    writeFileSync(profilesFile, fileText, "utf8");
    const fileProfiles = (JSON.parse(fileText) as { profiles: unknown[] }).profiles;

    const harness = await startHarness("flow-7-config", {
      orchestration: {
        worktreesRoot,
        // The SAME definitions the file carries (the composition the serve
        // --profiles path performs), plus the source path that makes the
        // config page a real view of a real file.
        profiles: fileProfiles as never,
        profilesSourcePath: profilesFile
      }
    });
    const { server, browser, evidence } = harness;
    try {
      const target: LocalPageTarget = { port: server.port, token: server.token };
      const page = browser.page;
      const onDisk = (): string => readFileSync(profilesFile, "utf8");

      await openWorkbenchPage(page, target);
      await openConfigPage(page);
      evidence.log("config tab open");

      // ---- load: the editor carries the file byte-for-byte -----------------
      const loaded = await loadProfilesFull(page);
      expect(loaded.editorValue).toBe(onDisk());
      expect(loaded.summaryText).toContain(CONFIG_PROFILE_ID);
      expect(loaded.topStatus).toContain("已载入配置");
      await evidence.screenshot(page, "config-loaded");

      // ---- edit: change one value in the full text --------------------------
      const before = onDisk();
      const edited = before.replace('"maxConcurrency":2', '"maxConcurrency":4');
      expect(edited).not.toBe(before); // the probe must really change the bytes

      // ---- save: atomic write-back through the page (CSRF handled inside) --
      const save = await saveProfilesFull(page, edited);
      evidence.log(`save status: ${save.saveStatus.slice(0, 80)} | top: ${save.topStatus}`);
      // Success anchors on the STABLE evidence: the top status only says
      // 写回后重新载入 after the PUT returned 200 and the page reloaded the
      // view (the 已原子写回 span is transient by the page's own reload).
      expect(save.topStatus).toContain("写回后重新载入");
      expect(save.topStatus).toContain("1 个 profile");
      await evidence.screenshot(page, "config-saved");

      // ---- explicit reload: the editor shows the persisted content ---------
      const reloaded = await loadProfilesFull(page);
      expect(reloaded.editorValue).toBe(edited);
      await evidence.screenshot(page, "config-reloaded");

      // ---- node-side truth: the disk holds exactly the submitted bytes -----
      expect(onDisk()).toBe(edited);
      evidence.log(`disk bytes confirmed: ${String(onDisk().length)} chars, maxConcurrency=4`);

      await harness.close("flow 7 config page: OK");
    } catch (error) {
      await harness.close(`flow 7 config page FAILED: ${String(error)}`);
      throw error;
    } finally {
      for (const dir of [worktreesRoot, configDir, sourceDir]) {
        try {
          rmSync(dir, { recursive: true, force: true });
        } catch {
          // best-effort scratch cleanup; never masks a test result
        }
      }
    }
  }, 120_000);
});
