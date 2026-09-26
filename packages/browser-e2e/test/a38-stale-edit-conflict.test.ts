/**
 * M5-05 — A38 regression at the BROWSER layer (docs/ACCEPTANCE.md A38:
 * "运行节点被 UI 原地修改 → 409 或新 revision，不改写历史" and the M5-02
 * row "过时图 revision 更新报冲突"):
 *
 * The page loads the graph at revision R. A SECOND writer (another operator
 * session, driven here over the same guarded HTTP API) bumps the revision to
 * R+1. The first page still holds the STALE revision R in its edit form; the
 * submit is refused 409 GRAPH_REVISION_CONFLICT and the UI SHOWS the
 * conflict prompt (过时 revision 编辑 → UI 显示冲突提示) — the request is
 * discarded, nothing is silently overwritten, and history is not rewritten.
 *
 * Also pinned here: the edit form exposes ONLY role/objective/dependencies
 * (A02: no model/Profile entry anywhere in the UI layer).
 */
import { describe, expect, test } from "vitest";
import {
  openLocalPage,
  loadGraph,
  readCanvas,
  readStatus,
  readEditor,
  clickNode,
  submitNodeEdit
} from "../src/index.js";
import { createRunnableRun, workflowRaw, SEQ_SPECS } from "../src/index.js";
import { startHarness } from "./helpers.js";

/** The competitor write, straight through the guarded HTTP API. */
async function competingEdit(
  port: number,
  token: string,
  csrfToken: string,
  runId: string,
  expectedGraphRevision: number,
  nodeId: string,
  objective: string
): Promise<{ readonly status: number; readonly revision: number | null }> {
  const response = await fetch(`http://127.0.0.1:${String(port)}/api/v1/runs/${runId}/graph/edits`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${token}`,
      "origin": `http://127.0.0.1:${String(port)}`,
      "x-csrf-token": csrfToken
    },
    body: JSON.stringify({
      expectedGraphRevision,
      nodeId,
      patch: { objective }
    })
  });
  const body = (await response.json()) as { revision?: number; error?: { code?: string } };
  return { status: response.status, revision: body.revision ?? null };
}

describe("M5-05 A38: 过时 graphRevision 的编辑在 UI 显示冲突提示", () => {
  test("stale edit submit -> 409 -> the page shows the conflict, discards the request", async () => {
    const harness = await startHarness("regression-a38-stale-edit");
    const { world, server, browser, evidence } = harness;
    try {
      const runId = "run-a38-1";
      createRunnableRun(world, runId, workflowRaw("wf-a38-1", "A38 冲突回归", SEQ_SPECS));

      const page = browser.page;
      await openLocalPage(page, { port: server.port, token: server.token }, runId);
      await loadGraph(page);
      const statusText = await readStatus(page);
      evidence.log(`page status after first load: ${statusText}`);
      expect(statusText).toContain("revision 0");

      // ---- A02: the edit form's field set has NO model/Profile entry -------
      await clickNode(page, "s1");
      const editor = await readEditor(page);
      expect(editor.kind).toBe("form");
      expect(editor.nodeId).toBe("s1");
      evidence.log(`edit form fields (DOM): ${editor.fields.join(", ")}`);
      // The submit button has no name attribute, so it reads as its tag name.
      expect(editor.fields).toEqual(["role", "objective", "dependencies", "button"]);

      // ---- a SECOND writer bumps the revision behind our page's back -------
      const competitor = await competingEdit(
        server.port, server.token, server.csrfToken, runId, 0, "s3",
        "objective rewritten by the OTHER operator session"
      );
      expect(competitor.status).toBe(200);
      expect(competitor.revision).toBe(1);
      evidence.log(`competing edit landed: revision ${String(competitor.revision)} (our page still holds revision 0)`);

      // ---- the stale submit is refused and the UI SHOWS the conflict -------
      const staleStatus = await submitNodeEdit(page, {
        objective: "objective from the STALE page (must be discarded)"
      });
      evidence.log(`stale submit status (DOM): ${staleStatus ?? "(form re-rendered — must not happen on a conflict)"}`);
      expect(staleStatus).not.toBeNull(); // a conflict keeps the form; the text is stable
      expect(staleStatus).toContain("冲突");
      expect(staleStatus).toContain("(A38)");
      expect(staleStatus).toContain("请重新加载任务图");
      await evidence.screenshot(page, "a38-stale-edit-conflict-prompt");

      // ---- nothing was silently overwritten --------------------------------
      const canvas = await readCanvas(page);
      expect(canvas).toHaveLength(3); // no node was added/removed by the stale write
      await loadGraph(page);
      await page.waitForFunction(
        () => (document.getElementById("status")?.textContent ?? "").includes("已加载任务图"),
        undefined,
        { timeout: 15_000 }
      );
      const freshStatus = await readStatus(page);
      evidence.log(`reload status: ${freshStatus}`);
      expect(freshStatus).toContain("revision 1");
      const after = await world.db
        .prepare("SELECT revision, source FROM task_graph_revisions WHERE run_id = ? ORDER BY revision ASC")
        .all(runId);
      evidence.log(`definition history rows: ${String(after.length)} (append-only, history not rewritten)`);
      expect(after.length).toBe(2);

      await harness.close("A38 browser regression: OK");
    } catch (error) {
      await harness.close(`A38 browser regression FAILED: ${String(error)}`);
      throw error;
    }
  });
});
