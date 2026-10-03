/**
 * The browser driver (M5-05): a real Chromium via playwright-core, one fresh
 * context per flow (an implicit, throwaway user-data dir — no shared
 * profile, no repo writes), plus the page helpers that drive the local-api
 * events page EXACTLY like a local operator would: fill the token field,
 * click the load buttons, click canvas nodes, submit the forms, and read
 * assertions out of the DOM (never out of HTTP status codes alone).
 *
 * Driver choice (probed on this machine, see README 选型): playwright-core
 * pinned to 1.61.0 — its registry revision (chromium-1228) matches the
 * browser cache at %LOCALAPPDATA%\ms-playwright, verified by launching and
 * reading a page. If the cache is absent the launch fails LOUDLY with the
 * remediation command (BrowserLaunchError) — flows are then reported
 * unverified, never faked.
 */
import { join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { BrowserLaunchError, PageWaitTimeoutError } from "./errors.js";
import type { Evidence } from "./evidence.js";

export interface BrowserSession {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  /** The browser-reported engine version (logged as evidence). */
  readonly version: string;
  close(): Promise<void>;
}

/** Launch a REAL headless Chromium with a throwaway profile. */
export async function launchBrowser(evidence: Evidence): Promise<BrowserSession> {
  let browser: Browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (error) {
    throw new BrowserLaunchError(error);
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    evidence.log(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      evidence.log(`console.error: ${message.text()}`);
    }
  });
  const version = browser.version();
  evidence.log(`browser launched: chromium ${version} (headless, fresh context)`);
  return {
    browser,
    context,
    page,
    version,
    close: async (): Promise<void> => {
      await context.close();
      await browser.close();
      evidence.log("browser closed (instance + throwaway profile discarded)");
    }
  };
}

// ---------------------------------------------------------------------------
// Page interaction helpers — every assertion a test makes about the UI goes
// through one of these reads of the ACTUAL DOM.
// ---------------------------------------------------------------------------

export interface LocalPageTarget {
  readonly port: number;
  readonly token: string;
}

/** Open the page and enter the session token + run id (operator steps).
 * M9-02: the page opens ON the workbench tab; the run id input lives in the
 * 高级 (observatory) tab, so the operator clicks that tab first. */
export async function openLocalPage(page: Page, target: LocalPageTarget, runId: string): Promise<void> {
  await page.goto(`http://127.0.0.1:${String(target.port)}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#token-input");
  await page.fill("#token-input", target.token);
  await page.click("#tab-advanced");
  await page.fill("#run-graph-input", runId);
}

/** Click 加载任务图 and wait for the SVG canvas. */
export async function loadGraph(page: Page): Promise<void> {
  await page.click("#load-graph-button");
  await page.waitForSelector("#graph-canvas svg", { timeout: 15_000 });
}

export interface CanvasNode {
  readonly nodeId: string;
  readonly state: string;
  readonly role: string;
  readonly editable: boolean;
  readonly lockedLabel: boolean;
}

/** Read every node box of the SVG canvas from the DOM. */
export async function readCanvas(page: Page): Promise<readonly CanvasNode[]> {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll("#graph-canvas svg g.dag-node")];
    return groups.map((group) => {
      const stateText = group.querySelector("text.dag-node-state")?.textContent ?? "";
      const lockMarked = stateText.includes("锁定");
      return {
        nodeId: group.getAttribute("data-node-id") ?? "",
        role: group.querySelector("text.dag-node-role")?.textContent ?? "",
        state: stateText.replace(" · 锁定", ""),
        editable: group.classList.contains("dag-node-editable"),
        lockedLabel: lockMarked
      };
    });
  });
}

/** The #status line (textContent — the page never renders it as HTML). */
export async function readStatus(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById("status")?.textContent ?? "");
}

/** Click one node box (event delegation opens the editor below the canvas). */
export async function clickNode(page: Page, nodeId: string): Promise<void> {
  await page.click(`#graph-canvas svg g.dag-node[data-node-id="${nodeId}"]`);
}

export interface EditorState {
  readonly kind: "form" | "locked" | "empty";
  readonly nodeId: string | null;
  readonly text: string;
  /** For a form: the exact field names it offers (A02: no model/profile). */
  readonly fields: readonly string[];
}

/** Read the node editor panel state from the DOM. */
export async function readEditor(page: Page): Promise<EditorState> {
  return page.evaluate(() => {
    const panel = document.getElementById("node-editor");
    if (panel === null || panel.hidden) return { kind: "empty", nodeId: null, text: "", fields: [] };
    const form = panel.querySelector("form#node-edit-form");
    if (form !== null) {
      const fields = [...form.querySelectorAll("input, select, button")].map(
        (element) => element.getAttribute("name") ?? element.tagName.toLowerCase()
      );
      return {
        kind: "form",
        nodeId: form.getAttribute("data-node-id"),
        text: panel.querySelector("h2")?.textContent ?? "",
        fields
      };
    }
    const locked = panel.querySelector(".editor-locked");
    if (locked !== null) {
      return { kind: "locked", nodeId: null, text: locked.textContent ?? "", fields: [] };
    }
    return { kind: "empty", nodeId: null, text: panel.textContent ?? "", fields: [] };
  });
}

export interface NodeEditInput {
  readonly role?: string | undefined;
  readonly objective?: string | undefined;
  readonly dependencies?: string | undefined;
}

/** Fill + submit the node edit form; resolves with the settled status text. */
export async function submitNodeEdit(page: Page, input: NodeEditInput): Promise<string | null> {
  if (input.role !== undefined) await page.selectOption("#node-edit-form select[name='role']", input.role);
  if (input.objective !== undefined) await page.fill("#node-edit-form input[name='objective']", input.objective);
  if (input.dependencies !== undefined) {
    await page.fill("#node-edit-form input[name='dependencies']", input.dependencies);
  }
  await page.click("#node-edit-form button[type='submit']");
  return waitForStatusText(page, "#node-edit-form .editor-status");
}

/**
 * Best-effort capture of a form's status text. FAILURE texts (409 conflict
 * prompts, refusals) keep the form rendered, so they are STABLE and always
 * captured. A SUCCESSFUL post re-renders the whole panel shortly after the
 * text appears (the page reloads its data), destroying the span — the
 * capture window is only a couple of loopback fetches wide, so callers on
 * success paths must assert the RE-RENDERED panel state and treat this text
 * as opportunistic evidence (null = the re-render won the race).
 */
async function waitForStatusText(page: Page, selector: string, timeoutMs = 2_500): Promise<string | null> {
  try {
    const handle = await page.waitForFunction(
      (sel) => {
        const text = document.querySelector(sel)?.textContent ?? "";
        return text.length > 0 && !text.includes("提交中…") ? text : null;
      },
      selector,
      { timeout: timeoutMs, polling: "raf" }
    );
    const text = await handle.jsonValue();
    await handle.dispose();
    return text;
  } catch {
    return null;
  }
}

/** Reload the canvas and wait until the predicate over the canvas holds. */
export async function waitForCanvas(
  page: Page,
  predicate: (nodes: readonly CanvasNode[]) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<readonly CanvasNode[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await loadGraph(page);
    const nodes = await readCanvas(page);
    if (predicate(nodes)) return nodes;
    if (Date.now() > deadline) {
      throw new PageWaitTimeoutError(
        `canvas condition: ${label} (last: ${nodes.map((n) => `${n.nodeId}=${n.state}`).join(",")})`,
        timeoutMs
      );
    }
    await page.waitForTimeout(200);
  }
}

// ---- M5-02 expansion panel -------------------------------------------------

export interface ExpansionPanelSnapshot {
  readonly budgetText: string;
  readonly holdText: string | null;
  readonly proposals: readonly {
    readonly reviewNodeId: string;
    readonly candidateSha: string;
    readonly heading: string;
    readonly findings: readonly string[];
    readonly hasForm: boolean;
  }[];
  readonly records: readonly { readonly expansionId: string; readonly text: string }[];
}

export async function loadExpansions(page: Page): Promise<ExpansionPanelSnapshot> {
  await page.click("#load-expansions-button");
  await page.waitForSelector("#expansion-panel:not([hidden])", { timeout: 15_000 });
  return page.evaluate(() => {
    const panel = document.getElementById("expansion-panel");
    if (panel === null) return { budgetText: "", holdText: null, proposals: [], records: [] };
    const proposals = [...panel.querySelectorAll(".expansion-proposal")].map((card) => ({
      reviewNodeId: card.getAttribute("data-review-node-id") ?? "",
      candidateSha: card.getAttribute("data-candidate-sha") ?? "",
      heading: card.querySelector("h3")?.textContent ?? "",
      findings: [...card.querySelectorAll("ul.findings li")].map((li) => li.textContent ?? ""),
      hasForm: card.querySelector("form.expansion-form") !== null
    }));
    const records = [...panel.querySelectorAll(".expansion-record")].map((record) => ({
      expansionId: (record.querySelector("h3")?.textContent ?? "").replace(/^已执行扩图\s*/, ""),
      text: record.textContent ?? ""
    }));
    return {
      budgetText: panel.querySelector(".expansion-budget")?.textContent ?? "",
      holdText: panel.querySelector(".hold-banner")?.textContent ?? null,
      proposals,
      records
    };
  });
}

/** Submit the proposal card's expansion form; returns the settled status. */
export async function submitExpansion(page: Page, requesterRoleId: string): Promise<string | null> {
  await page.selectOption(".expansion-form select[name='requesterRoleId']", requesterRoleId);
  await page.click(".expansion-form button[type='submit']");
  return waitForStatusText(page, ".expansion-form .expansion-status");
}

// ---- M5-03 approvals / diff -------------------------------------------------

export interface ApprovalCardSnapshot {
  readonly approvalId: string;
  readonly actionDigest: string;
  readonly badgeText: string;
  readonly detailText: string;
  readonly invalidated: boolean;
  readonly hasDecisionForm: boolean;
}

export async function loadApprovals(page: Page): Promise<readonly ApprovalCardSnapshot[]> {
  await page.click("#load-approvals-button");
  await page.waitForSelector("#approval-panel:not([hidden])", { timeout: 15_000 });
  return page.evaluate(() => {
    const panel = document.getElementById("approval-panel");
    if (panel === null) return [];
    return [...panel.querySelectorAll(".approval-card")].map((card) => {
      const form = card.querySelector("form.approval-decision-form");
      return {
        approvalId: card.getAttribute("data-approval-id") ?? "",
        actionDigest: card.getAttribute("data-approval-digest") ?? "",
        badgeText: (card.querySelector(".invalidated-badge")?.textContent ?? "") + (card.querySelector(".approval-status")?.textContent ?? ""),
        detailText: (card.querySelector("table.approval-detail")?.textContent ?? "") + (card.querySelector(".approval-why")?.textContent ?? ""),
        invalidated: card.querySelector(".invalidated-badge") !== null,
        hasDecisionForm: form !== null
      };
    });
  });
}

/** Fill 决策人 and press approve or reject; returns the settled status text. */
export async function decideApproval(
  page: Page,
  approvalId: string,
  decidedBy: string,
  decision: "approve" | "reject",
  reason?: string
): Promise<string | null> {
  const form = page.locator(`form.approval-decision-form[data-approval-id="${approvalId}"]`);
  await form.locator("input[name='decidedBy']").fill(decidedBy);
  if (reason !== undefined) await form.locator("input[name='reason']").fill(reason);
  await form.locator(`button[name='decision'][value='${decision}']`).click();
  return waitForStatusText(page, `form.approval-decision-form[data-approval-id="${approvalId}"] .decision-status`);
}

export interface DiffSnapshot {
  readonly nodeId: string;
  readonly candidateSha: string | null;
  readonly reviewText: string | null;
  readonly fileRows: readonly string[];
  readonly unifiedHead: string;
}

export async function loadDiff(page: Page, nodeId: string): Promise<DiffSnapshot> {
  await page.fill("#diff-node-input", nodeId);
  await page.click("#load-diff-button");
  await page.waitForSelector("#diff-panel:not([hidden])", { timeout: 20_000 });
  return page.evaluate(() => {
    const panel = document.getElementById("diff-panel");
    if (panel === null) {
      return { nodeId: "", candidateSha: null, reviewText: null, fileRows: [], unifiedHead: "" };
    }
    const card = panel.querySelector(".diff-card");
    const code = card?.querySelector(".diff-meta code")?.textContent ?? null;
    return {
      nodeId: card?.getAttribute("data-node-id") ?? "",
      candidateSha: code,
      reviewText: card?.querySelector(".review-binding")?.textContent ?? null,
      fileRows: [...(card?.querySelectorAll("table.diff-files tbody tr") ?? [])].map((row) => row.textContent ?? ""),
      unifiedHead: (card?.querySelector("pre.diff-view")?.textContent ?? "").slice(0, 400)
    };
  });
}

/** The page's full visible text (forbidden-vocabulary scans, A17). */
export async function pageBodyText(page: Page): Promise<string> {
  return page.evaluate(() => document.body.innerText);
}

// ---- execution detail + events (the top connect panel) ----------------------

export interface ExecutionPageView {
  readonly runDetailText: string;
  readonly events: readonly { readonly seq: string; readonly type: string; readonly payload: string }[];
}

/** Load one execution's status + event log through the page UI. */
export async function loadExecutionEvents(page: Page, executionId: string): Promise<ExecutionPageView> {
  await page.fill("#execution-input", executionId);
  await page.click("#load-button");
  await page.waitForSelector("#run-detail:not([hidden])", { timeout: 15_000 });
  await page.waitForFunction(
    () => document.getElementById("status")?.textContent?.includes("完成") === true,
    { timeout: 15_000 }
  );
  return page.evaluate(() => ({
    runDetailText: document.getElementById("run-detail")?.textContent ?? "",
    events: [...document.querySelectorAll("#events ul.events li.event")].map((item) => ({
      seq: item.querySelector(".seq")?.textContent ?? "",
      type: item.querySelector(".type")?.textContent ?? "",
      payload: item.querySelector(".payload")?.textContent ?? ""
    }))
  }));
}

// ---- M5-04 live events (A39, browser-layer WebSocket client) -----------------

export interface WsEventRecord {
  readonly eventId: string;
  readonly seq: number;
  readonly type: string;
}

export interface WsCollectResult {
  readonly readyCursor: number | null;
  readonly catchupCursor: number | null;
  readonly terminalPhase: string | null;
  readonly events: readonly WsEventRecord[];
  readonly frameTypes: readonly string[];
  readonly closedByServer: boolean;
  readonly closeCode: number | null;
}

export interface WsCollectOptions {
  readonly port: number;
  readonly token: string;
  readonly executionId: string;
  /** Cursor forms: afterSeq (numeric) or afterEventId (exact event). */
  readonly afterSeq?: number | undefined;
  readonly afterEventId?: string | undefined;
  /** Stop collecting this long after the last frame (settle window). */
  readonly idleMs?: number | undefined;
  readonly hardTimeoutMs?: number | undefined;
}

/**
 * Run a WebSocket client INSIDE the browser page (page.evaluate — the same
 * origin the CSP's connect-src 'self' governs) and collect the live-event
 * frames. The collected transcript is the A39 browser-layer evidence.
 */
export async function collectLiveEvents(page: Page, options: WsCollectOptions): Promise<WsCollectResult> {
  const idleMs = options.idleMs ?? 2_000;
  const hardTimeoutMs = options.hardTimeoutMs ?? 45_000;
  const url = `ws://127.0.0.1:${String(options.port)}/api/v1/events/live`;
  const result = await page.evaluate(
    async ({ url, token, executionId, afterSeq, afterEventId, idleMs, hardTimeoutMs }) => {
      const subscribeFrame: Record<string, unknown> = { type: "subscribe", executionId };
      if (afterSeq !== undefined) subscribeFrame["afterSeq"] = afterSeq;
      if (afterEventId !== undefined) subscribeFrame["afterEventId"] = afterEventId;
      return await new Promise<WsCollectResult>((resolve) => {
        const ws = new WebSocket(url);
        const events: WsEventRecord[] = [];
        const frameTypes: string[] = [];
        let readyCursor: number | null = null;
        let catchupCursor: number | null = null;
        let terminalPhase: string | null = null;
        let closedByServer = false;
        let closeCode: number | null = null;
        let done = false;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const finish = (): void => {
          if (done) return;
          done = true;
          if (idleTimer !== null) clearTimeout(idleTimer);
          try {
            ws.close();
          } catch {
            /* already closing */
          }
          resolve({ readyCursor, catchupCursor, terminalPhase, events, frameTypes, closedByServer, closeCode });
        };
        const armIdle = (ms: number): void => {
          if (idleTimer !== null) clearTimeout(idleTimer);
          idleTimer = setTimeout(finish, ms);
        };

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "auth", token }));
          ws.send(JSON.stringify(subscribeFrame));
        };
        ws.onmessage = (message) => {
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(String(message.data)) as Record<string, unknown>;
          } catch {
            return;
          }
          const kind = String(frame["type"] ?? "");
          frameTypes.push(kind);
          if (kind === "ready") {
            readyCursor = Number(frame["cursor"]);
          } else if (kind === "event") {
            const event = frame["event"] as Record<string, unknown>;
            events.push({
              eventId: String(event["eventId"]),
              seq: Number(event["seq"]),
              type: String(event["type"])
            });
            armIdle(idleMs);
          } else if (kind === "catchup") {
            // The server polls and re-emits catchup frames every poll
            // interval for the WHOLE life of the socket. They are keep-up
            // noise, not progress: never re-arm the settle timer once the
            // terminal notice has been seen, or the collector only ever ends
            // at the hard timeout.
            catchupCursor = Number(frame["cursor"]);
            if (terminalPhase === null) armIdle(idleMs);
          } else if (kind === "execution-terminal") {
            terminalPhase = String(frame["phase"]);
            armIdle(Math.min(idleMs, 800));
          } else if (kind === "error") {
            armIdle(300);
          }
        };
        ws.onclose = (event) => {
          closedByServer = true;
          closeCode = event.code;
          finish();
        };
        ws.onerror = () => {
          /* close follows; the transcript records what arrived */
        };
        setTimeout(finish, hardTimeoutMs);
      });
    },
    { url, token: options.token, executionId: options.executionId, afterSeq: options.afterSeq, afterEventId: options.afterEventId, idleMs, hardTimeoutMs }
  );
  return result;
}

// ---- M9-02 workbench (the DEFAULT tab) --------------------------------------

export interface CreateRunInput {
  readonly objective: string;
  readonly profileId: string;
  readonly projectDir: string;
}

export interface ProfileOptionSnapshot {
  readonly value: string;
  readonly label: string;
}

/** Open the page, enter the token, and stay on the DEFAULT workbench tab. */
export async function openWorkbenchPage(page: Page, target: LocalPageTarget): Promise<void> {
  await page.goto(`http://127.0.0.1:${String(target.port)}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#token-input");
  await page.fill("#token-input", target.token);
  await page.waitForSelector("#tab-workbench-page:not([hidden])");
}

/** Click 载入可用 profiles and read the populated select options. */
export async function loadWorkbenchProfiles(page: Page): Promise<readonly ProfileOptionSnapshot[]> {
  await page.click("#load-profiles-button");
  await page.waitForFunction(
    () => {
      const select = document.getElementById("profile-select") as HTMLSelectElement | null;
      return (select?.options.length ?? 0) > 1;
    },
    undefined,
    { timeout: 15_000 }
  );
  return page.evaluate(() => {
    const select = document.getElementById("profile-select") as HTMLSelectElement | null;
    return [...(select?.options ?? [])].map((option) => ({
      value: option.value,
      label: option.label
    }));
  });
}

/** Fill the create form (operator steps; does not submit). */
export async function fillCreateRunForm(page: Page, input: CreateRunInput): Promise<void> {
  await page.fill("#objective-input", input.objective);
  await page.selectOption("#profile-select", input.profileId);
  await page.fill("#projectdir-input", input.projectDir);
}

/** Submit 创建任务 and return the settled create-status text (the 202 accept
 * note on success, the typed-refusal text on failure — both stable). */
export async function submitCreateRun(page: Page): Promise<string> {
  await page.click("#create-run-form button[type='submit']");
  await page.waitForFunction(
    () => {
      const text = document.getElementById("create-status")?.textContent ?? "";
      return text.length > 0 && !text.includes("提交中…");
    },
    undefined,
    { timeout: 15_000 }
  );
  return page.evaluate(() => document.getElementById("create-status")?.textContent ?? "");
}

export interface RunRowSnapshot {
  readonly runId: string;
  readonly objective: string;
  readonly status: string;
  readonly createdAt: string;
  readonly expanded: boolean;
}

/** Read every run row from the list DOM (badge text minus the gloss). */
export async function readRunList(page: Page): Promise<readonly RunRowSnapshot[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("#run-list-panel .run-row")].map((row) => ({
      runId: row.getAttribute("data-run-id") ?? "",
      objective: row.querySelector(".run-objective")?.textContent ?? "",
      status: (row.querySelector(".run-status-badge")?.textContent ?? "").split(" · ")[0] ?? "",
      createdAt: row.querySelector(".run-created")?.textContent ?? "",
      expanded: row.classList.contains("run-row-expanded")
    }))
  );
}

/** Wait until the run list satisfies the predicate (re-reads between polls). */
export async function waitForRunList(
  page: Page,
  predicate: (rows: readonly RunRowSnapshot[]) => boolean,
  label: string,
  timeoutMs = 30_000
): Promise<readonly RunRowSnapshot[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = await readRunList(page);
    if (predicate(rows)) return rows;
    if (Date.now() > deadline) {
      throw new PageWaitTimeoutError(
        `run list condition: ${label} (last: ${rows.map((row) => `${row.runId}=${row.status}`).join(",")})`,
        timeoutMs
      );
    }
    await page.waitForTimeout(200);
  }
}

/** Click a run row (event-delegated) to expand its detail area. */
export async function openRunDetail(page: Page, runId: string): Promise<void> {
  await page.click(`#run-list-panel .run-row-toggle[data-run-id="${runId}"]`);
  await page.waitForSelector("#workbench-detail:not([hidden])", { timeout: 15_000 });
}

export interface WorkbenchDetailView {
  readonly badgeText: string;
  readonly detailText: string;
  readonly events: readonly { readonly seq: string; readonly type: string; readonly payload: string }[];
  readonly liveEventCount: number;
}

/** Read the expanded workbench detail: badge, execution inventory, live events. */
export async function readWorkbenchDetail(page: Page): Promise<WorkbenchDetailView> {
  return page.evaluate(() => ({
    badgeText: document.querySelector("#workbench-detail .workbench-detail-head .run-status-badge")?.textContent ?? "",
    detailText: document.querySelector("#workbench-detail .workbench-detail-card")?.textContent ?? "",
    events: [...document.querySelectorAll("#workbench-detail .workbench-events ul.events li.event")].map((item) => ({
      seq: item.querySelector(".seq")?.textContent ?? "",
      type: item.querySelector(".type")?.textContent ?? "",
      payload: item.querySelector(".payload")?.textContent ?? ""
    })),
    liveEventCount: document.querySelectorAll("#workbench-detail .workbench-events ul.events li.event").length
  }));
}

/** Wait until the expanded detail's live event list has at least n items. */
export async function waitForWorkbenchEvents(page: Page, minCount: number, timeoutMs = 30_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await readWorkbenchDetail(page);
    if (view.liveEventCount >= minCount) return view.liveEventCount;
    if (Date.now() > deadline) {
      throw new PageWaitTimeoutError(
        `workbench live events >= ${String(minCount)} (last: ${String(view.liveEventCount)})`,
        timeoutMs
      );
    }
    await page.waitForTimeout(200);
  }
}

/** Where a test's evidence directory lives (path joins for logs). */
export function evidencePath(evidence: Evidence, name: string): string {
  return join(evidence.dir, name);
}
