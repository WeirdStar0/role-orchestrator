/**
 * M5-05 — A39 regression at the BROWSER layer (docs/ACCEPTANCE.md A39:
 * "WebSocket 掉线和重复事件 → cursor 重放并按 eventId 去重"):
 *
 * A real WebSocket client runs INSIDE the browser page (same-origin under
 * the page CSP's connect-src 'self'), authenticates with the first-message
 * auth frame and subscribes. Connection 1 consumes the events live, then
 * DROPS. More events are appended while it is down. Connection 2 reconnects
 * with a STALE cursor (as if the client had only processed the first event):
 * the server REPLAYS the already-delivered events at-least-once. The
 * browser-layer assertion: after deduplication by eventId the union has NO
 * loss (every stored event exactly once, no seq gaps) and NO duplicates —
 * and the terminal notice arrives on both connections.
 */
import { describe, expect, test } from "vitest";
import { appendEvent, createTaskRun, createActiveAttempt, setAttemptPhase } from "@role-orchestrator/store";
import {
  openLocalPage,
  collectLiveEvents,
  type WsEventRecord
} from "../src/index.js";
import { startHarness, WORLD_T0 } from "./helpers.js";

/**
 * The cells below execute through the engine launcher, which is implemented
 * for the windows-native world only and refuses other targets
 * (UnsupportedExecutionTargetError); they are therefore win32-gated.
 */
const LAUNCHER_APPLIES = process.platform === "win32";
if (!LAUNCHER_APPLIES) {
  console.warn(
    "[browser-e2e] non-Windows platform — launcher-driven cells are skipped " +
      "(production launcher is windows-native-only)"
  );
}


function tick(offsetMs: number): string {
  return new Date(Date.parse(WORLD_T0) + offsetMs).toISOString();
}

describe.skipIf(!LAUNCHER_APPLIES)("M5-05 A39: WS 断线重连 cursor 重放 + eventId 去重（浏览器层）", () => {
  test("disconnect, replay from a stale cursor, dedup by eventId: no loss, no duplicates", async () => {
    const harness = await startHarness("regression-a39-ws-replay");
    const { world, server, browser, evidence } = harness;
    try {
      // ---- a run + a TERMINAL execution with an event log ------------------
      // The world's project is reused (projects.repo_root is UNIQUE), so the
      // store rows here are exactly: one run, one ended execution, 8 events.
      createTaskRun(world.db, {
        id: "run-ws-1",
        projectId: world.projectId,
        taskId: "task-ws-1",
        graphRevision: 0,
        configSnapshotHash: "hash-ws-1",
        baseSha: world.baseSha,
        now: WORLD_T0
      });
      createActiveAttempt(world.db, {
        id: "exec-ws-1",
        runId: "run-ws-1",
        nodeId: "node-1",
        definitionRevision: "rev-1",
        attempt: 1,
        dispatchToken: "dt-exec-ws-1",
        phase: "PREPARING",
        now: WORLD_T0
      });
      for (const phase of ["STARTING", "RUNNING", "SUCCEEDED"] as const) {
        setAttemptPhase(world.db, {
          id: "exec-ws-1",
          phase,
          wherePhaseIn: phase === "STARTING" ? ["PREPARING"] : phase === "RUNNING" ? ["STARTING"] : ["RUNNING"],
          now: tick(1)
        });
      }
      const firstIds: string[] = [];
      for (let seq = 1; seq <= 5; seq += 1) {
        const id = `evt-a39-${String(seq).padStart(2, "0")}`;
        firstIds.push(id);
        expect(
          appendEvent(world.db, {
            id,
            executionId: "exec-ws-1",
            seq,
            type: "diagnostic",
            payload: { summary: `browser a39 event ${String(seq)}` },
            occurredAt: tick(seq * 10)
          })
        ).toBe("stored");
      }
      evidence.log(`seeded events 1..5 of exec-ws-1 (ids ${firstIds.join(", ")})`);

      const page = browser.page;
      await openLocalPage(page, { port: server.port, token: server.token }, "run-ws-1");

      // ---- connection 1: consume the live stream, then drop ----------------
      const first = await collectLiveEvents(page, {
        port: server.port,
        token: server.token,
        executionId: "exec-ws-1",
        idleMs: 1_200
      });
      evidence.log(
        `connection 1: ready=${String(first.readyCursor)} events=${String(first.events.length)} ` +
          `catchup=${String(first.catchupCursor)} terminal=${String(first.terminalPhase)}`
      );
      expect(first.readyCursor).toBe(0);
      expect(first.events.map((event) => event.eventId)).toEqual(firstIds);
      expect(first.terminalPhase).toBe("SUCCEEDED");

      // ---- events appended while the client is "down" ----------------------
      const secondIds: string[] = [];
      for (let seq = 6; seq <= 8; seq += 1) {
        const id = `evt-a39-${String(seq).padStart(2, "0")}`;
        secondIds.push(id);
        expect(
          appendEvent(world.db, {
            id,
            executionId: "exec-ws-1",
            seq,
            type: "diagnostic",
            payload: { summary: `browser a39 event ${String(seq)} (appended offline)` },
            occurredAt: tick(seq * 10)
          })
        ).toBe("stored");
      }
      evidence.log("appended events 6..8 while the client is disconnected");
      const allIds = [...firstIds, ...secondIds];

      // ---- connection 2: reconnect with a STALE cursor (only saw seq 1) ----
      const firstEventId = firstIds[0] ?? "";
      const second = await collectLiveEvents(page, {
        port: server.port,
        token: server.token,
        executionId: "exec-ws-1",
        afterEventId: firstEventId, // stale by 4: the server replays 2..5 again
        idleMs: 1_200
      });
      evidence.log(
        `connection 2 (afterEventId=${firstEventId.slice(0, 12)}…): ready=${String(second.readyCursor)} ` +
          `events=${String(second.events.length)} terminal=${String(second.terminalPhase)}`
      );
      expect(second.readyCursor).toBe(1); // cursor resolved from the eventId
      expect(second.terminalPhase).toBe("SUCCEEDED");

      // The replay RE-delivered the overlapping events (at-least-once by
      // design) — the raw union holds duplicates that only eventId dedup
      // can resolve.
      const rawUnion: WsEventRecord[] = [...first.events, ...second.events];
      const uniqueById = new Map(rawUnion.map((event) => [event.eventId, event]));
      evidence.log(
        `raw union=${String(rawUnion.length)} frames, unique eventIds=${String(uniqueById.size)} ` +
          `(duplicates=${String(rawUnion.length - uniqueById.size)} — delivered at-least-once and deduped)`
      );
      expect(rawUnion.length).toBeGreaterThan(uniqueById.size); // duplicates really happened

      // ---- 无丢失: the deduped union is exactly the stored event set -------
      expect([...uniqueById.keys()].sort()).toEqual([...allIds].sort());
      const dedupedSeqs = [...uniqueById.values()].map((event) => event.seq).sort((a, b) => a - b);
      expect(dedupedSeqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // no gaps, no extras
      // ---- 无重复: per connection, and in the deduped union ---------------
      const noDupWithin = (events: readonly WsEventRecord[]): void => {
        expect(new Set(events.map((event) => event.eventId)).size).toBe(events.length);
      };
      noDupWithin(first.events);
      noDupWithin(second.events);
      expect(uniqueById.size).toBe(allIds.length);

      // The transcript is persisted as evidence alongside the screenshots.
      evidence.artifact(
        "a39-ws-frame-transcript.json",
        JSON.stringify({ first, second, dedupedSeqs, uniqueCount: uniqueById.size }, null, 2)
      );

      await harness.close("A39 browser regression: OK");
    } catch (error) {
      await harness.close(`A39 browser regression FAILED: ${String(error)}`);
      throw error;
    }
  });
});
