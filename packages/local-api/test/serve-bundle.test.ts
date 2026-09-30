/**
 * M8-05 task 1: smoke test for the BUNDLED serve entry
 * (dist/serve-bundle.mjs, produced by scripts/bundle-serve.mjs).
 *
 * Skipped when the bundle is absent (dist/ is not committed — the artifact
 * is produced by the packaging step, never checked in). Expectations mirror
 * the serve-bin smoke in serve.test.ts, because the ONLY difference between
 * the two entries must be the packaging (single file vs node_modules tree):
 *
 * - Spawn is an ARGV ARRAY, never a shell; the child's stdout diagnostic
 *   line only DISCOVERS the ephemeral port — success is judged EXCLUSIVELY
 *   by HTTP probes (hard rule shared with the desktop shell).
 * - Guard expectations follow the shipped server design (see the header of
 *   serve.test.ts): the bearer check gates /api paths, while `GET /` is the
 *   static token-entry page and answers 200 WITHOUT auth by design — the
 *   unauthenticated-refusal evidence therefore lives on `/api/v1/session`
 *   (403 without Authorization, 200 with the session's Bearer token).
 * - The session token is read from the per-start token file the CHILD
 *   itself created and reported (0o600-equivalent per-user location) — the
 *   test plays exactly the role the documented operator flow assigns to the
 *   human: read the file, present the bearer token. It never passes through
 *   argv or the parent's environment beyond this read.
 * - "Closes cleanly" = the child process exits within a bounded window
 *   after kill() and its stderr stayed empty for the whole run (no crash
 *   stack, no unhandled rejection noise) — observable shutdown behavior,
 *   not a stdout verdict.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { rawRequest } from "./helpers.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const bundlePath = join(testDir, "..", "dist", "serve-bundle.mjs");

const tempRoots: string[] = [];

function makeBundleDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ro-localapi-serve-bundle-"));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    // retries for Windows: the killed child may release its WAL files late
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Incremental stdout/stderr line collection (same recipe as serve.test.ts). */
class LineCollector {
  readonly lines: string[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private remainder = "";

  attach(stream: NodeJS.ReadableStream): void {
    stream.on("data", (chunk: Buffer) => {
      this.remainder += this.decoder.write(chunk);
      let index = this.remainder.indexOf("\n");
      while (index !== -1) {
        const line = this.remainder.slice(0, index).trim();
        if (line.length > 0) this.lines.push(line);
        this.remainder = this.remainder.slice(index + 1);
        index = this.remainder.indexOf("\n");
      }
    });
  }
}

/** Polls collected lines until the predicate matches; fails with a tail. */
async function waitForLine(
  collector: LineCollector,
  predicate: (line: string) => boolean,
  timeoutMs: number,
  label: string
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const line of collector.lines) {
      if (predicate(line)) return line;
    }
    await sleep(25);
  }
  const tail = collector.lines[collector.lines.length - 1] ?? "(none)";
  throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${label}; last line: ${tail.slice(0, 200)}`);
}

/** Retries the loopback probe until ANY HTTP response (or timeout). */
async function probeUntilResponse(
  port: number,
  timeoutMs: number,
  path: string
): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await rawRequest(port, { path });
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  throw new Error(
    `HTTP probe got no response on 127.0.0.1:${String(port)}${path} within ${String(timeoutMs)}ms; ` +
      `last error: ${String(lastError)}`
  );
}

describe("serve-bundle smoke (only with a bundled dist)", () => {
  it("spawns the single-file bundle (argv array, no shell), enforces the API bearer guard, serves the page, and shuts down cleanly", async (ctx) => {
    if (!existsSync(bundlePath)) {
      console.info(
        `serve-bundle smoke test skipped: ${bundlePath} is not built — run ` +
          `"pnpm --filter @role-orchestrator/local-api run bundle:serve" (after build) to enable it`
      );
      ctx.skip();
    }
    const dir = makeBundleDir();
    const dbPath = join(dir, "serve-bundle-smoke.db");
    const child = spawn(process.execPath, [bundlePath, "--db", dbPath, "--port", "0"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    if (child.stdout === null || child.stderr === null) {
      throw new Error("serve-bundle smoke: child stdio pipes were not created");
    }
    const stdout = new LineCollector();
    const stderr = new LineCollector();
    stdout.attach(child.stdout);
    stderr.attach(child.stderr);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    try {
      // Port discovery ONLY (never a success verdict): the one listening
      // diagnostic line, then all verdicts below are HTTP.
      const line = await waitForLine(
        stdout,
        (candidate) => candidate.startsWith(`{"event":"listening"`),
        20_000,
        "the listening diagnostic line"
      );
      const diagnostic = JSON.parse(line) as Record<string, unknown>;
      const port = diagnostic["port"];
      const tokenFile = diagnostic["tokenFile"];
      if (typeof port !== "number" || typeof tokenFile !== "string") {
        throw new Error(`listening diagnostic lacks port/tokenFile: ${line}`);
      }

      // (1) Startup verdict: the page answers on the loopback (by design
      // without a token — same semantics as dist/serve-bin.js).
      const page = await probeUntilResponse(port, 10_000, "/");
      expect(page.status).toBe(200);

      // (2) Guard pipeline on the API path: no Authorization -> refused
      // (403; the guard pipeline never yields 401 — see server.ts).
      const refused = await probeUntilResponse(port, 10_000, "/api/v1/session");
      expect(refused.status).toBe(403);

      // (3) The session token comes from the child-reported per-start token
      // file (trimmed read, exactly the documented operator flow).
      const token = readFileSync(tokenFile, "utf8").trim();
      expect(token.length).toBeGreaterThan(0);
      const authed = await rawRequest(port, {
        path: "/api/v1/session",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(authed.status).toBe(200);
      const session = JSON.parse(authed.body) as { schemaVersion?: number; csrfToken?: unknown };
      expect(session.schemaVersion).toBe(1);
      expect(typeof session.csrfToken).toBe("string");

      // (4) Clean shutdown: bounded exit after kill, stderr silent all run.
      child.kill();
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("serve-bundle smoke: child did not exit within 10s of kill")), 10_000);
      });
      await Promise.race([exit, timeout]);
      expect(stderr.lines).toEqual([]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await exit;
      }
    }
  });

  it("refuses a bad db path (parent directory absent) with a stderr line and nonzero exit, like serve-bin", async (ctx) => {
    if (!existsSync(bundlePath)) {
      console.info(
        `serve-bundle smoke test skipped: ${bundlePath} is not built — run ` +
          `"pnpm --filter @role-orchestrator/local-api run bundle:serve" (after build) to enable it`
      );
      ctx.skip();
    }
    // serve never mkdir -p implicitly: a missing parent directory must fail
    // closed with the diagnostic prefix on stderr and exitCode 1.
    const dir = makeBundleDir();
    const dbPath = join(dir, "no-such-subdir", "child.db");
    const child = spawn(process.execPath, [bundlePath, "--db", dbPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    if (child.stdout === null || child.stderr === null) {
      throw new Error("serve-bundle smoke: child stdio pipes were not created");
    }
    const stdout = new LineCollector();
    const stderr = new LineCollector();
    stdout.attach(child.stdout);
    stderr.attach(child.stderr);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", reject);
    });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("serve-bundle smoke: bad-db child did not exit within 15s")), 15_000);
    });
    const outcome = await Promise.race([exit, timeout]);
    expect(outcome.code).not.toBe(0);
    expect(stdout.lines.join("\n")).not.toContain(`{"event":"listening"`);
    expect(stderr.lines.join("\n")).toContain("role-orchestrator-local-api-serve:");
  });
});
