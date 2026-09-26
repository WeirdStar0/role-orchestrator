/**
 * M3-04 delivery 3 — the A36 diagnostic export ("落盘前脱敏").
 *
 * Hostile, secret-shaped content is injected through TWO channels:
 *  1. a VERIFIED memory whose content carries Bearer / api_key / password
 *     shapes (the memory data plane stores content plaintext — it is data —
 *     so the EXPORT is the sink that must not leak);
 *  2. an event row appended directly through the store's raw `appendEvent`
 *     (bypassing the engine's pre-persist redaction — a legacy/out-of-band
 *     writer), carrying token=/Bearer shapes.
 *
 * The export must then still be safe: the diagnostic package (graph state +
 * events + bundle fragments + memory references) passes the redact pipeline
 * before the local file sink, and the file is read back and grepped for the
 * planted values. Pre-assertions prove the secrets really were present in
 * the store, so a green run means the EXPORT redacted them — not that the
 * sources were clean.
 */
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { appendEvent } from "@role-orchestrator/store";
import { BASELINE_T0 } from "@role-orchestrator/e2e-baseline";
import { openMemoryAccess } from "@role-orchestrator/memory-search";
import { proposeMemory, verifyMemory } from "@role-orchestrator/memory";
import { exportDiagnosticPackage, CONSUME_NODE, DESIGN_NODE } from "../src/index.js";
import { runHandoffHarness, type HandoffHarness } from "./helpers.js";

/**
 * The driver executes through the engine launcher, which is implemented for
 * the windows-native world only and refuses other targets
 * (UnsupportedExecutionTargetError). These end-to-end cells are therefore
 * win32-gated; on other platforms the decision/scan units they compose stay
 * covered by the per-package unit suites.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[context-e2e] non-Windows platform — launcher-driven e2e cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}


const HOSTILE_MEMORY_ID = "mem-ctxe2e-hostile-1";
const BEARER_TOKEN = "sk-hostile1234567890abcdef";
const API_KEY_VALUE = "0123456789abcdef0123";
const PASSWORD_VALUE = "hunter2hunter2";
const EVENT_TOKEN_VALUE = "aaaabbbbccccdddd1234";
const EVENT_BEARER_VALUE = "eyJwtHostilePayload00112233";
const PLANTED_SECRETS = [
  BEARER_TOKEN,
  API_KEY_VALUE,
  PASSWORD_VALUE,
  EVENT_TOKEN_VALUE,
  EVENT_BEARER_VALUE
] as const;

const HOSTILE_EVENT_ID = "evt-ctxe2e-hostile-1";

let harness: HandoffHarness;
let exportPath: string;
let exportBytes: string;

beforeAll(async () => {
  if (!LAUNCHER_APPLIES) return;
  harness = await runHandoffHarness("diag-export", {
    withProjectB: true,
    seedExtra: (world, projectId): void => {
      proposeMemory(world.db, {
        id: HOSTILE_MEMORY_ID,
        projectId,
        type: "fact",
        content:
          `ctxe2e 敌意样本（验证导出脱敏）：Authorization: Bearer ${BEARER_TOKEN}; ` +
          `api_key=${API_KEY_VALUE}; password: ${PASSWORD_VALUE}; ` +
          "<script>alert('xss')</script>",
        evidenceRefs: ["design"],
        actor: { kind: "role", roleId: "architect" },
        now: BASELINE_T0
      });
      verifyMemory(world.db, {
        projectId,
        memoryId: HOSTILE_MEMORY_ID,
        expectedVersion: 1,
        actor: { kind: "role", roleId: "reviewer" },
        now: BASELINE_T0
      });
    }
  });

  const { world, access, runId, result } = harness;
  const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);
  const design = result.trace.find((entry) => entry.nodeId === DESIGN_NODE.id);
  const executionIds = [design?.executionId ?? "", consume?.executionId ?? ""];
  const bundleIds = [consume?.bundleId ?? ""];

  // Hostile event row: appended DIRECTLY through the store's raw path, so it
  // lands UNREDACTED (the engine's appendRedactedEvent wrapper is bypassed).
  const seq = harness.eventsOf(consume?.executionId ?? "").length;
  const appended = appendEvent(world.db, {
    id: HOSTILE_EVENT_ID,
    executionId: consume?.executionId ?? "",
    seq,
    type: "diagnostic",
    payload: {
      note: `token=${EVENT_TOKEN_VALUE}`,
      authorization: `Bearer ${EVENT_BEARER_VALUE}`,
      html: "<script>alert(1)</script>"
    },
    occurredAt: BASELINE_T0
  });
  expect(appended).toBe("stored");

  // Pre-assertion: the sources really do contain the plaintext secrets —
  // the green assertions below therefore prove the EXPORT redacted them.
  const storedEvent = harness
    .eventsOf(consume?.executionId ?? "")
    .find((event) => event.raw.includes(EVENT_TOKEN_VALUE));
  expect(storedEvent).toBeDefined();
  const hostileMemory = access.get(HOSTILE_MEMORY_ID);
  expect(hostileMemory?.content).toContain(BEARER_TOKEN);

  const exportResult = exportDiagnosticPackage(world.db, {
    access,
    runId,
    executionIds,
    bundleIds,
    outPath: join(world.scratchDir, "diagnostic-export.json")
  });

  // The file exists and its digest is the returned one.
  exportPath = exportResult.outPath;
  exportBytes = readFileSync(exportPath, "utf8");
  expect(exportResult.byteCount).toBe(Buffer.byteLength(exportBytes, "utf8"));
  expect(exportResult.sha256).toBe(
    createHash("sha256").update(exportBytes, "utf8").digest("hex")
  );
  expect(exportResult.documentRedactedCount).toBeGreaterThan(0);
  // Idempotence: after the document pass, the serialized text is clean, so
  // the pre-sink pass finds nothing left to redact.
  expect(Object.keys(exportResult.textRedactions)).toEqual([]);
  expect(exportResult.verifiedBundleIds).toEqual(bundleIds);
}, 240_000);

afterAll(() => {
  if (!LAUNCHER_APPLIES) return;
  harness?.cleanup();
});

describe.skipIf(!LAUNCHER_APPLIES)("M3-04 诊断导出（A36：图状态 + 事件 + bundle 片段 + 记忆引用，落盘前脱敏）", () => {
  it("导出文件不含任何明文秘密值，占位符存在", () => {
    for (const secret of PLANTED_SECRETS) {
      expect(exportBytes).not.toContain(secret);
    }
    expect(exportBytes).toContain("[REDACTED]");
  });

  it("导出仍是可追溯的诊断包：图状态、事件、bundle 与记忆引用俱在", () => {
    const { result, runId, seeded } = harness;
    const design = result.trace.find((entry) => entry.nodeId === DESIGN_NODE.id);
    const consume = result.trace.find((entry) => entry.nodeId === CONSUME_NODE.id);
    // Graph state.
    expect(exportBytes).toContain(`"runId": "${runId}"`);
    expect(exportBytes).toContain(`"${DESIGN_NODE.id}"`);
    expect(exportBytes).toContain(`"${CONSUME_NODE.id}"`);
    // Events (both executions, including the hostile one — redacted).
    expect(exportBytes).toContain(`"executionId": "${design?.executionId}"`);
    expect(exportBytes).toContain(`"executionId": "${consume?.executionId}"`);
    expect(exportBytes).toContain('"type": "diagnostic"');
    expect(exportBytes).toContain(`"note": "token=${"[REDACTED]"}"`);
    expect(exportBytes).toContain(`"authorization": "Bearer ${"[REDACTED]"}"`);
    // Bundle fragments with provenance (manifest-traceable).
    expect(exportBytes).toContain(`"bundleId": "${consume?.bundleId}"`);
    expect(exportBytes).toContain("dependency_output");
    expect(exportBytes).toContain(`"artifactId": "artifact_fake_report"`);
    // Memory references cite id + version + contentHash; content is redacted.
    expect(exportBytes).toContain(`"memoryId": "${seeded.factId}"`);
    expect(exportBytes).toContain(`"memoryId": "${HOSTILE_MEMORY_ID}"`);
    expect(exportBytes).toContain('"contentHash":');
  });

  it("导出边界拒绝越权范围：他项目会话不能导出本 run", () => {
    const { world, runId } = harness;
    const foreignAccess = openMemoryAccess(world.db, { projectId: world.projectBId ?? "" });
    expect(() =>
      exportDiagnosticPackage(world.db, {
        access: foreignAccess,
        runId,
        executionIds: [],
        bundleIds: [],
        outPath: join(world.scratchDir, "must-not-exist.json")
      })
    ).toThrowError(/project-scoped exports only/);
  });
});
