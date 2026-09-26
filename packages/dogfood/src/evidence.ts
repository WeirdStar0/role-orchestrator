/**
 * Evidence collection for the M6-04 dogfood (the 完成标准 asks for a
 * recorded failure/recovery run). One `Evidence` instance per driver run:
 * it owns a fresh directory under `packages/dogfood/evidence/<label>-<UTC
 * stamp>/`, appends timestamped lines to `driver.log.txt` and persists
 * structured artifacts (the timeline, the A11/A17/A22 records). Nothing
 * here fabricates content: a line is written when the driver observed the
 * fact from the store, git or a typed product result.
 *
 * Same discipline as the M5-05 browser evidence, minus the browser: the
 * dogfood drives the chain, not the UI.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package-local evidence root, stable under src (vitest) and dist layouts. */
const packagesDir = fileURLToPath(new URL("../..", import.meta.url));
export const DOGFOOD_EVIDENCE_ROOT = join(packagesDir, "dogfood", "evidence");

export class Evidence {
  readonly dir: string;
  private readonly logPath: string;
  private readonly startedAtMs = Date.now();

  private constructor(dir: string, logPath: string) {
    this.dir = dir;
    this.logPath = logPath;
  }

  /** Create `<root>/<label>-<stamp>/` and write the run header. */
  static start(label: string, header: Readonly<Record<string, string>>): Evidence {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const dir = join(DOGFOOD_EVIDENCE_ROOT, `${label}-${stamp}`);
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "driver.log.txt");
    const evidence = new Evidence(dir, logPath);
    evidence.log(`=== dogfood evidence: ${label} ===`);
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

  /** Persist a structured artifact (timeline, acceptance records). */
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
