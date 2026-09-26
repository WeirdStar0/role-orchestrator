/**
 * Evidence collection (M5-05 完成标准: "对应测试带真实截图/日志证据").
 *
 * One `Evidence` instance per test file run: it owns a fresh directory under
 * `packages/browser-e2e/evidence/<label>-<UTC stamp>/`, appends timestamped
 * lines to `driver.log.txt`, and saves real browser screenshots as numbered
 * PNG files. Nothing here fabricates content: a screenshot is written by
 * Chromium, a log line is written by the driver when the observed fact was
 * read back from the page or the store.
 *
 * The evidence directory name is printed on stdout so a run's artifacts can
 * be located even when the test file fails midway.
 */
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright-core";

/**
 * The package-local evidence root, resolved from THIS file's location so it
 * is identical under vitest (src/) and after the tsc build (dist/): this file
 * sits exactly one directory below the package root in both layouts, and
 * "../.." from it is the monorepo's packages/ directory.
 */
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));
export const EVIDENCE_ROOT = join(packagesDir, "browser-e2e", "evidence");

export class Evidence {
  readonly dir: string;
  private readonly logPath: string;
  private counter = 0;
  private readonly startedAtMs = Date.now();

  private constructor(dir: string) {
    this.dir = dir;
    this.logPath = join(dir, "driver.log.txt");
    mkdirSync(dir, { recursive: true });
  }

  /** Create `<root>/<label>-<stamp>/` and write the run header. */
  static start(label: string, header: Readonly<Record<string, string>>): Evidence {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(EVIDENCE_ROOT, `${label}-${stamp}`);
    const evidence = new Evidence(dir);
    evidence.log(`=== browser-e2e evidence: ${label} ===`);
    for (const [name, value] of Object.entries(header)) {
      evidence.log(`${name}: ${value}`);
    }
    return evidence;
  }

  /** Append one timestamped line (elapsed-ms + UTC clock) to the driver log. */
  log(line: string): void {
    const elapsedMs = Date.now() - this.startedAtMs;
    const lineText = `+${String(elapsedMs).padStart(6, "0")}ms ${new Date().toISOString()} ${line}`;
    appendFileSync(this.logPath, `${lineText}\n`, "utf8");
  }

  /** Save a REAL browser screenshot; returns the path written. */
  async screenshot(page: Page, name: string): Promise<string> {
    this.counter += 1;
    const fileName = `${String(this.counter).padStart(2, "0")}-${name}.png`;
    const path = join(this.dir, fileName);
    await page.screenshot({ path, fullPage: true });
    this.log(`screenshot ${fileName} url=${page.url()}`);
    return path;
  }

  /** Persist a structured artifact (e.g. a collected WS frame transcript). */
  artifact(name: string, content: string): string {
    const path = join(this.dir, name);
    writeFileSync(path, content, "utf8");
    this.log(`artifact ${name} (${String(content.length)} chars)`);
    return path;
  }

  /** Final log line; the file is flushed incrementally, nothing buffered. */
  close(summary: string): void {
    this.log(`=== done: ${summary} ===`);
  }
}
