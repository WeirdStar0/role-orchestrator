/**
 * M8-03a serve-entry tests: zod-strict CLI parsing, the standalone
 * run/serve/shutdown loop with its one-line listening diagnostic, and a
 * smoke test for the BUILT bin (skipped when dist is absent).
 *
 * Guard expectations follow the shipped server design: the bearer/CSRF
 * checks gate `/api` paths (server.ts guard pipeline); `GET /` is the
 * static token-entry page and answers 200 WITHOUT auth by design — the
 * unauthenticated-refusal evidence therefore lives on the API path.
 *
 * The v0.1.1 block adds the schema-initialization contract: runServe must
 * carry a FRESH empty db through the controlled-expansion migration chain
 * (v0.1.0 answered `no such table: executions` on first start), re-serving
 * an initialized db must be a migration no-op, and a migration failure must
 * propagate instead of starting a half-migrated server.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import {
  CONTROLLED_EXPANSION_MIGRATIONS,
  applyControlledExpansionMigrations
} from "@role-orchestrator/expand";
import {
  MigrationError,
  appliedMigrationRecords,
  openDatabase
} from "@role-orchestrator/store";
import {
  LocalApiConfigurationError,
  parseServeArgs,
  runServe,
  ServeArgsError,
  tokenFileLocationProblem,
  type ServeHandle
} from "../src/index.js";
import { rawRequest, seedMatrixData } from "./helpers.js";

const tempRoots: string[] = [];

function makeServeDir(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `ro-localapi-serve-${label}-`));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    // retries for Windows: the killed bin child may release its WAL files late
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Incremental stdout/stderr line collection (same recipe as cli-events). */
class LineCollector {
  readonly lines: string[] = [];
  private readonly decoder = new StringDecoder("utf8");
  private remainder = "";

  attach(stream: NodeJS.ReadableStream): void {
    stream.on("data", (chunk: Buffer) => {
      this.remainder += this.decoder.write(chunk);
      let index = this.remainder.indexOf("\n");
      while (index >= 0) {
        const line = this.remainder.slice(0, index);
        this.remainder = this.remainder.slice(index + 1);
        if (line.trim() !== "") this.lines.push(line);
        index = this.remainder.indexOf("\n");
      }
    });
  }
}

/** Swallow-and-record writes so the test can assert the diagnostic line. */
function captureStdoutWrites(): { readonly text: () => string; readonly restore: () => void } {
  const chunks: string[] = [];
  const original = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(Buffer.from(chunk).toString("utf8"));
    return true;
  }) as unknown as typeof process.stdout.write;
  return {
    text: (): string => chunks.join(""),
    restore: (): void => {
      process.stdout.write = original;
    }
  };
}

function extractListeningDiagnostic(text: string): Record<string, unknown> {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (value["event"] === "listening") return value;
    } catch {
      // request-log lines are not JSON; keep scanning
    }
  }
  throw new Error(`no listening diagnostic line found in captured stdout: ${text.slice(0, 400)}`);
}

/** Resolves only when the port refuses connections (ECONNREFUSED). */
function expectPortClosed(port: number, timeoutMs = 5_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = net.connect({ host: "127.0.0.1", port });
    const refuse = (message: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(message));
    };
    const timer = setTimeout(() => {
      refuse(`port ${String(port)} still accepts connections after shutdown`);
    }, timeoutMs);
    socket.on("connect", () => {
      refuse(`port ${String(port)} still accepts connections after shutdown`);
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error.code === "ECONNREFUSED") {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

describe("parseServeArgs", () => {
  it("parses --db and --port; port defaults to 0 (ephemeral)", () => {
    expect(parseServeArgs(["--db", "h:/tmp/store.db", "--port", "8123"])).toEqual({
      db: "h:/tmp/store.db",
      port: 8123
    });
    expect(parseServeArgs(["--db", "store.db"])).toEqual({ db: "store.db", port: 0 });
  });

  it("rejects duplicate flags (exactly one db, one port)", () => {
    expect(() => parseServeArgs(["--db", "a.db", "--db", "b.db"])).toThrow(ServeArgsError);
    expect(() => parseServeArgs(["--db", "a.db", "--port", "1", "--port", "2"])).toThrow(ServeArgsError);
  });

  it("rejects unknown arguments, positionals and --flag=value forms", () => {
    expect(() => parseServeArgs(["--verbose"])).toThrow(ServeArgsError);
    expect(() => parseServeArgs(["--db", "a.db", "stray.db"])).toThrow(ServeArgsError);
    expect(() => parseServeArgs(["--db=h:/tmp/a.db"])).toThrow(ServeArgsError);
  });

  it("rejects missing values (including a following flag token)", () => {
    expect(() => parseServeArgs([])).toThrow(ServeArgsError); // --db itself is required
    expect(() => parseServeArgs(["--db"])).toThrow(ServeArgsError);
    expect(() => parseServeArgs(["--db", "a.db", "--port"])).toThrow(ServeArgsError);
    // `--port` after `--db` is a MISSING value, never an implicit consume.
    expect(() => parseServeArgs(["--db", "--port", "5"])).toThrow(ServeArgsError);
  });

  it("rejects illegal ports and empty values", () => {
    for (const bad of ["abc", "70000", "-1", "12.5", ""]) {
      expect(() => parseServeArgs(["--db", "a.db", "--port", bad])).toThrow(ServeArgsError);
    }
    expect(() => parseServeArgs(["--db", ""])).toThrow(ServeArgsError);
  });

  it("parses --profiles and rejects duplicates (M9-01)", () => {
    expect(parseServeArgs(["--db", "a.db", "--profiles", "profiles.json"])).toEqual({
      db: "a.db",
      port: 0,
      profiles: "profiles.json"
    });
    expect(() =>
      parseServeArgs(["--db", "a.db", "--profiles", "a.json", "--profiles", "b.json"])
    ).toThrow(ServeArgsError);
    expect(() => parseServeArgs(["--db", "a.db", "--profiles"])).toThrow(ServeArgsError);
  });

  it("attaches a one-line usage to every argument error", () => {
    expect(() => parseServeArgs(["--nope"])).toThrow(
      /usage: role-orchestrator-local-api-serve --db <path> \[--port <0\.\.65535>\]/
    );
  });
});

describe("runServe integration", () => {
  it("opens a temp store, serves with guards enforced, and shuts the port", async () => {
    const dir = makeServeDir("int");
    const dbPath = join(dir, "serve-int.db");
    const capture = captureStdoutWrites();
    let handle: ServeHandle;
    try {
      handle = await runServe({ db: dbPath, port: 0 });
    } finally {
      capture.restore();
    }
    try {
      // The diagnostic line is forwarded to stdout exactly once and carries
      // the bound address/port and the token file location (the path is not
      // a secret; the file itself is current-user-only).
      const diagnostic = extractListeningDiagnostic(capture.text());
      expect(diagnostic).toEqual({
        event: "listening",
        boundAddress: handle.server.boundAddress,
        port: handle.server.port,
        tokenFile: handle.server.tokenFile
      });
      expect(handle.server.boundAddress).toBe("127.0.0.1");
      expect(handle.server.port).toBeGreaterThan(0);

      // Direct guard evidence: an unauthenticated API request is refused...
      const refused = await rawRequest(handle.server.port, { path: "/api/v1/session" });
      expect(refused.status).toBe(403);
      expect(refused.body).toContain("TOKEN_REQUIRED");

      // ...and the same request with the session token passes.
      const authed = await rawRequest(handle.server.port, {
        path: "/api/v1/session",
        headers: { authorization: `Bearer ${handle.server.token}` }
      });
      expect(authed.status).toBe(200);

      // GET / stays 200 WITHOUT auth by design: the page IS the token-entry
      // surface (server.ts routes `/` outside the bearer check — the operator
      // pastes the token INTO that page, so it cannot demand one first).
      const page = await rawRequest(handle.server.port, { path: "/" });
      expect(page.status).toBe(200);

      // Token file: exists, in a per-user location; on POSIX also mode 0o600.
      expect(existsSync(handle.server.tokenFile)).toBe(true);
      expect(tokenFileLocationProblem(handle.server.tokenFile)).toBeNull();
      if (process.platform !== "win32") {
        // Windows: libuv mode emulation cannot express NTFS ACLs — the
        // per-user location check above IS the visibility guarantee (token.ts).
        expect(statSync(handle.server.tokenFile).mode & 0o077).toBe(0);
      }
    } finally {
      await handle.shutdown();
    }
    await expectPortClosed(handle.server.port);
  });

  it("serves WITHOUT orchestration when no profiles file is given: runs list works, create refuses 503", async () => {
    const dir = makeServeDir("orch-off");
    const handle = await runServe({ db: join(dir, "serve-orch-off.db"), port: 0 });
    try {
      const list = await rawRequest(handle.server.port, {
        path: "/api/v1/runs",
        headers: { authorization: `Bearer ${handle.server.token}` }
      });
      expect(list.status).toBe(200);
      expect(JSON.parse(list.body) as { runs: unknown[] }).toMatchObject({ runs: [] });

      const create = await rawRequest(handle.server.port, {
        method: "POST",
        path: "/api/v1/runs",
        headers: {
          authorization: `Bearer ${handle.server.token}`,
          origin: `http://127.0.0.1:${handle.server.port}`,
          "x-csrf-token": handle.server.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({ objective: "x", projectDir: "h:/nope" })
      });
      expect(create.status).toBe(503);
      expect(create.body).toContain("ORCHESTRATION_NOT_CONFIGURED");
    } finally {
      await handle.shutdown();
    }
  });

  it("with --profiles the create route is live: fail-closed projectDir validation answers 400", async () => {
    const dir = makeServeDir("orch-on");
    const profilesFile = join(dir, "profiles.json");
    writeFileSync(
      profilesFile,
      JSON.stringify({
        schemaVersion: 1,
        profiles: [
          {
            id: "claude-main",
            runtime: "claude",
            executable: "claude",
            executionTarget: "windows-native",
            configDir: join(dir, "claude-config"),
            model: null,
            credentialGroup: "claude-local",
            maxConcurrency: 2,
            timeoutSeconds: 1800,
            extraArgs: []
          }
        ]
      }),
      "utf8"
    );
    const handle = await runServe({ db: join(dir, "serve-orch-on.db"), port: 0, profiles: profilesFile });
    try {
      // Orchestration is ACTIVE: the request reaches the typed domain gate
      // (a fail-closed projectDir refusal), not the 503. Nothing executes.
      const create = await rawRequest(handle.server.port, {
        method: "POST",
        path: "/api/v1/runs",
        headers: {
          authorization: `Bearer ${handle.server.token}`,
          origin: `http://127.0.0.1:${handle.server.port}`,
          "x-csrf-token": handle.server.csrfToken,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          objective: "点烟测试",
          projectDir: join(dir, "does-not-exist")
        })
      });
      expect(create.status).toBe(400);
      expect(create.body).toContain("PROJECT_DIR_MISSING");
    } finally {
      await handle.shutdown();
    }
  });

  it("refuses to serve when the profiles file does not match the frozen schema", async () => {
    const dir = makeServeDir("orch-bad");
    const profilesFile = join(dir, "profiles.json");
    writeFileSync(
      profilesFile,
      JSON.stringify({ schemaVersion: 1, profiles: [{ id: "bad", surprise: true }] }),
      "utf8"
    );
    await expect(
      runServe({ db: join(dir, "serve-orch-bad.db"), port: 0, profiles: profilesFile })
    ).rejects.toBeInstanceOf(LocalApiConfigurationError);
  });

  it("registers SIGINT/SIGTERM handlers and removes them on shutdown", async () => {
    const dir = makeServeDir("signals");
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    const handle = await runServe({ db: join(dir, "serve-signals.db"), port: 0 });
    try {
      expect(process.listenerCount("SIGINT")).toBe(sigintBefore + 1);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore + 1);
    } finally {
      await handle.shutdown();
    }
    expect(process.listenerCount("SIGINT")).toBe(sigintBefore);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermBefore);
  });

  it("shutdown is single-flight: repeat callers get the SAME in-flight promise", async () => {
    // 审查 minor(双重信号竞态)的幂等性断言:shutdown 不得用布尔标志短路
    // ——那会让第二个调用方(或第二个信号)在 server.close() 仍在途时拿到
    // 一个立即 resolve 的假完成并提前退出。单飞记忆化下,重复调用返回的
    // 是同一条 promise,身份相等是最强的可观察证明。
    const dir = makeServeDir("single-flight");
    const handle = await runServe({ db: join(dir, "serve-flight.db"), port: 0 });
    try {
      const first = handle.shutdown();
      const second = handle.shutdown();
      expect(second).toBe(first);
      // 两条引用都最终完成,且端口确实关闭(关闭真的发生过一次)
      await Promise.all([first, second]);
    } finally {
      await handle.shutdown();
    }
    await expectPortClosed(handle.server.port);
  });

  it("refuses a database path whose parent directory does not exist (no implicit mkdir)", async () => {
    const missingDir = join(tmpdir(), `ro-localapi-serve-absent-${randomBytes(6).toString("hex")}`);
    const dbPath = join(missingDir, "never.db");
    await expect(runServe({ db: dbPath, port: 0 })).rejects.toThrow(
      /refusing to create directories implicitly/
    );
    expect(existsSync(dbPath)).toBe(false);
  });

  it("refuses a parent path that exists but is NOT a directory", async () => {
    // 审查 minor:statSync 成功 ≠ 父路径可作目录——文件当父路径时必须以
    // LocalApiConfigurationError 拒绝,而不是让 sqlite 的 open 环节报出
    // 更晦涩的底层错误。
    const dir = makeServeDir("parent-file");
    const filePath = join(dir, "not-a-dir");
    writeFileSync(filePath, "placeholder");
    const dbPath = join(filePath, "child.db");
    await expect(runServe({ db: dbPath, port: 0 })).rejects.toThrow(LocalApiConfigurationError);
    await expect(runServe({ db: dbPath, port: 0 })).rejects.toThrow(/is not a directory/);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("runServe schema initialization (v0.1.1)", () => {
  /** The versions runServe must record, derived from the shipped chain. */
  const CHAIN_VERSIONS = [...CONTROLLED_EXPANSION_MIGRATIONS]
    .map((migration) => migration.version)
    .sort((a, b) => a - b);

  it("carries a fresh empty db to the current schema: executions exists and a token'd run-detail API answers 200", async () => {
    // v0.1.0 缺口回归:v0.1.0 的冒烟只证明静态页与 /api/v1/session 200
    // (都不读业务表),空库照样通过——用户实测首启页面报
    // `no such table: executions`。本测试打在真实故障面上:
    // (a) schema 证据直接问 sqlite_master;(b) 行为证据用带 token 的
    // GET /api/v1/runs/:id(server.ts getRunDetail → listExecutionsForRun,
    // 恰好读 executions 表)拿 200,而不是 500 + no such table。
    const dir = makeServeDir("migrate-fresh");
    const dbPath = join(dir, "serve-migrate-fresh.db");
    const handle = await runServe({ db: dbPath, port: 0 });
    try {
      // (a) sqlite_master:故障报告点名的表存在,迁移链完整入账。
      const executions = handle.db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'executions'")
        .get();
      expect(executions?.name).toBe("executions");
      const recorded = handle.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all()
        .map((row) => Number(row.version));
      expect(recorded).toEqual(CHAIN_VERSIONS);

      // (b) 行为证据:经迁移后的 schema 种入 project/run/execution,再走
      // 守卫管道读 run 详情——响应 200 且携带该 execution,全程无
      // `no such table`。
      const seed = seedMatrixData(handle.db, {
        runId: "run-serve-mig",
        executionId: "exec-serve-mig"
      });
      const authed = await rawRequest(handle.server.port, {
        path: `/api/v1/runs/${seed.runId}`,
        headers: { authorization: `Bearer ${handle.server.token}` }
      });
      expect(authed.status).toBe(200);
      expect(authed.body).toContain(seed.executionId);
      expect(authed.body).not.toContain("no such table");
    } finally {
      await handle.shutdown();
    }
    await expectPortClosed(handle.server.port);
  });

  it("re-serving an already-initialized db is idempotent: no throw, no duplicate migration rows", async () => {
    // 二次启动(桌面壳重启/崩溃恢复的常态路径):迁移链重复执行必须
    // (i) 不抛,(ii) 不重复——applied 行(版本、checksum、applied_at)
    // 逐字段不变是最强的「未重复应用」证据,再加 schema_migrations 总行数
    // 恰为链长。同一连接句柄上 API 仍健康。
    const dir = makeServeDir("migrate-idempotent");
    const dbPath = join(dir, "serve-migrate-idempotent.db");

    const first = await runServe({ db: dbPath, port: 0 });
    const recordsAfterFirst = appliedMigrationRecords(first.db);
    expect(recordsAfterFirst.map((record) => record.version)).toEqual(CHAIN_VERSIONS);
    await first.shutdown();
    await expectPortClosed(first.server.port);

    const second = await runServe({ db: dbPath, port: 0 });
    try {
      const recordsAfterSecond = appliedMigrationRecords(second.db);
      expect(recordsAfterSecond).toEqual(recordsAfterFirst);
      expect(recordsAfterSecond).toHaveLength(CONTROLLED_EXPANSION_MIGRATIONS.length);
      const total = second.db
        .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
        .get();
      expect(Number(total?.n)).toBe(CONTROLLED_EXPANSION_MIGRATIONS.length);

      const session = await rawRequest(second.server.port, {
        path: "/api/v1/session",
        headers: { authorization: `Bearer ${second.server.token}` }
      });
      expect(session.status).toBe(200);
    } finally {
      await second.shutdown();
    }
    await expectPortClosed(second.server.port);
  });

  it("propagates a migration failure (schema newer than this build knows) instead of starting the server", async () => {
    // 迁移失败必须传播(fail-closed):先经公开 API 造一个「被更新构建
    // 迁移过的库」(schema_migrations 记到 99 > 本构建已知 17),runServe
    // 必须以 MigrationError 拒绝、绝不返回会监听端口的 handle;拒绝后
    // 库内容不被部分改写。只读文件路径不可用:openDatabase 的
    // journal_mode=WAL fail-closed 断言会更早触发,测不到迁移层。
    const dir = makeServeDir("migrate-failure");
    const dbPath = join(dir, "serve-migrate-failure.db");
    const planted = openDatabase(dbPath);
    await applyControlledExpansionMigrations(planted, { now: "2026-01-01T00:00:00.000Z" });
    planted
      .prepare(
        "INSERT INTO schema_migrations(version, name, checksum, applied_at) VALUES (?, ?, ?, ?)"
      )
      .run(99, "099-future", "0".repeat(64), "2026-01-01T00:00:00.000Z");
    planted.close();

    await expect(runServe({ db: dbPath, port: 0 })).rejects.toThrow(MigrationError);
    await expect(runServe({ db: dbPath, port: 0 })).rejects.toThrow(
      /newer than this build knows/
    );

    // 拒绝是干净失败:降级守卫在写任何内容之前触发,库保持原样。
    const after = openDatabase(dbPath);
    try {
      const remaining = after
        .prepare("SELECT version FROM schema_migrations ORDER BY version ASC")
        .all()
        .map((row) => Number(row.version));
      expect(remaining).toEqual([...CHAIN_VERSIONS, 99]);
    } finally {
      after.close();
    }
  });
});

describe("serve-bin smoke (only with a built dist)", () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const binPath = join(testDir, "..", "dist", "serve-bin.js");

  it("spawns the built bin (argv array, no shell) and reaches it via HTTP probe", async (ctx) => {
    if (!existsSync(binPath)) {
      console.info(
        `serve-bin smoke test skipped: ${binPath} is not built — run ` +
          `"pnpm --filter @role-orchestrator/local-api run build" to enable it`
      );
      ctx.skip();
    }
    const dir = makeServeDir("bin");
    const dbPath = join(dir, "serve-bin-smoke.db");
    // Hard rule: ARGV ARRAY, no shell. Success is NEVER judged from stdout —
    // the diagnostic line only DISCOVERS the ephemeral port; the verdict is
    // the HTTP probe below (the same flow the desktop shell must follow).
    const child = spawn(process.execPath, [binPath, "--db", dbPath], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    if (child.stdout === null || child.stderr === null) {
      throw new Error("serve-bin smoke: child stdio pipes were not created");
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
      const line = await waitForLine(
        stdout,
        (candidate) => candidate.startsWith(`{"event":"listening"`),
        20_000,
        "the listening diagnostic line"
      );
      const diagnostic = JSON.parse(line) as Record<string, unknown>;
      const port = diagnostic["port"];
      if (typeof port !== "number") {
        throw new Error(`listening diagnostic carries no numeric port: ${line}`);
      }
      // THE verdict is HTTP: a response proves the API is in position; the
      // correct Host makes the guard pipeline answer 200 on the page.
      const response = await probeUntilResponse(port, 10_000, stderr);
      expect(response.status).toBe(200);
    } finally {
      child.kill();
      await exit;
    }
  });
});

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
  stderr: LineCollector
): Promise<{ status: number; body: string }> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await rawRequest(port, { path: "/" });
    } catch (error) {
      lastError = error;
      await sleep(100);
    }
  }
  const stderrTail = stderr.lines.slice(-5).join(" | ").slice(0, 400);
  throw new Error(
    `HTTP probe got no response on 127.0.0.1:${String(port)} within ${String(timeoutMs)}ms; ` +
      `stderr tail: ${stderrTail}; last error: ${String(lastError)}`
  );
}
