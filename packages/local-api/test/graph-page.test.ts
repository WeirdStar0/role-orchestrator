/**
 * M5-01 page tests: the SERVED app.js (the exact string the server sends)
 * is evaluated in a DOM-less sandbox, and the pure rendering functions are
 * asserted snapshot-style — node/edge counts, state classes, escaping of
 * hostile values, the four-role form without any model/Profile field (A02
 * UI layer), and the payload builder's allowlist refusal.
 */
import { describe, expect, it } from "vitest";
import vm from "node:vm";
import { buildStaticPageAssets } from "../src/index.js";

const assets = buildStaticPageAssets();

interface GraphNode {
  readonly nodeId: string;
  readonly role: string;
  readonly objective: string;
  readonly dependencies: readonly string[];
  readonly state: string;
  readonly editable: boolean;
}

interface PageApi {
  escapeHtml(text: string): string;
  esc(text: unknown): string;
  isNodeEditable(node: { state: string }): boolean;
  buildNodeEditPayload(
    nodeId: string,
    expectedGraphRevision: number,
    fields: Record<string, unknown>
  ): Record<string, unknown>;
  computeGraphLayout(nodes: { nodeId: string; dependencies: readonly string[] }[]): Record<string, number>;
  renderRunGraph(container: { innerHTML: string; hidden: boolean }, graph: unknown): void;
  renderNodeEditor(
    container: { innerHTML: string; hidden: boolean },
    input: { node: GraphNode | null; graphRevision?: number; runId?: string }
  ): void;
  ROLE_OPTIONS: readonly string[];
  EDIT_FIELD_ALLOWLIST: readonly string[];
}

function loadPageApi(): PageApi {
  const sandbox: Record<string, unknown> = {};
  vm.createContext(sandbox);
  vm.runInContext(assets.appJs, sandbox, { filename: "app.js" });
  const api = sandbox["__roleOrchestratorPage"] as PageApi | undefined;
  if (api === undefined) {
    throw new Error("served app.js did not expose __roleOrchestratorPage");
  }
  return api;
}

/** The diamond a -> (b, c) -> d in mixed states. */
function diamondGraph(): { graph: Record<string, unknown>; nodes: GraphNode[] } {
  const nodes: GraphNode[] = [
    { nodeId: "a", role: "coordinator", objective: "objective-a", dependencies: [], state: "SUCCEEDED", editable: false },
    { nodeId: "b", role: "developer", objective: "objective-b", dependencies: ["a"], state: "RUNNING", editable: false },
    { nodeId: "c", role: "developer", objective: "objective-c", dependencies: ["a"], state: "READY", editable: true },
    { nodeId: "d", role: "reviewer", objective: "objective-d", dependencies: ["b", "c"], state: "PENDING", editable: true }
  ];
  return { graph: { graphRevision: 7, nodes }, nodes };
}

describe("the DAG section of the served page shell", () => {
  it("carries the canvas/editor sections and keeps the no-inline-handler contract", () => {
    expect(assets.indexHtml).toContain('id="graph-canvas"');
    expect(assets.indexHtml).toContain('id="node-editor"');
    expect(assets.indexHtml).toContain('id="run-graph-input"');
    expect(assets.indexHtml).toContain('id="load-graph-button"');
    expect(assets.indexHtml).not.toMatch(/\son(click|load|error|mouseover|submit)=/i);
  });
});

describe("renderRunGraph — SVG snapshot assertions", () => {
  const api = loadPageApi();

  it("renders one node group per node and one edge per dependency", () => {
    const container = { innerHTML: "", hidden: true };
    const { graph } = diamondGraph();
    api.renderRunGraph(container, graph);
    const html = container.innerHTML;

    expect(container.hidden).toBe(false);
    expect(html).toContain('<svg class="dag-canvas"');
    expect(html).toContain("</svg>");
    // 4 node groups, 4 dependency edges (a->b, a->c, b->d, c->d).
    expect(html.match(/<g class="dag-node /g)).toHaveLength(4);
    expect(html.match(/<line class="dag-edge"/g)).toHaveLength(4);
    // State classes drive the colors; editable/locked flags are visible.
    expect(html).toContain("node-state-SUCCEEDED");
    expect(html).toContain("node-state-RUNNING");
    expect(html).toContain("node-state-READY");
    expect(html).toContain("node-state-PENDING");
    expect(html.match(/dag-node-editable/g)).toHaveLength(2);
    expect(html.match(/dag-node-locked/g)).toHaveLength(2);
    expect(html).toContain('data-node-id="a"');
    expect(html).toContain('data-node-id="d"');
  });

  it("escapes hostile node text with NO live script surface (A36 语义延续)", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderRunGraph(container, {
      graphRevision: 1,
      nodes: [
        {
          nodeId: '"><img src=x onerror=alert(1)>',
          role: "<script>alert('role')</script>",
          objective: "<script>alert('objective')</script>",
          dependencies: [],
          state: "READY",
          editable: true
        }
      ]
    });
    const html = container.innerHTML;
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&quot;&gt;&lt;img src&#61;x onerror&#61;alert(1)&gt;");
    expect(html).toContain("&lt;script&gt;");
    // The hostile id is inert even inside the data attribute.
    expect(html).toContain('data-node-id="&quot;&gt;&lt;img');
  });

  it("renders an empty graph as a hint instead of a broken canvas", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderRunGraph(container, { graphRevision: 0, nodes: [] });
    expect(container.innerHTML).toContain("没有节点");
    expect(container.innerHTML).not.toContain("<svg");
  });
});

describe("computeGraphLayout — deterministic layered positions", () => {
  const api = loadPageApi();

  it("assigns the diamond its longest-path layers", () => {
    const { nodes } = diamondGraph();
    expect(api.computeGraphLayout(nodes)).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });

  it("keeps ids in the same layer deterministic regardless of input order", () => {
    const { nodes } = diamondGraph();
    const reversed = api.computeGraphLayout([...nodes].reverse());
    expect(reversed).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });
});

describe("renderNodeEditor — the form is role/objective/dependencies ONLY (A02 UI layer)", () => {
  const api = loadPageApi();

  it("renders exactly the four built-in roles and no model/Profile field", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderNodeEditor(container, {
      node: {
        nodeId: "c",
        role: "developer",
        objective: "实现 x",
        dependencies: ["a", "b"],
        state: "READY",
        editable: true
      },
      graphRevision: 3,
      runId: "run-1"
    });
    const html = container.innerHTML;
    expect(html).toContain("<form");
    expect(html.match(/<option /g)).toHaveLength(4);
    for (const role of api.ROLE_OPTIONS) {
      expect(api.ROLE_OPTIONS).toContain(role);
    }
    expect(html).toContain('value="coordinator"');
    expect(html).toContain('value="architect"');
    expect(html).toContain('value="developer"');
    expect(html).toContain('value="reviewer"');
    expect(html).toContain('name="objective"');
    expect(html).toContain('name="dependencies"');
    expect(html).toContain('value="a,b"');
    // The A02 pin: NO input/select/textarea named model or profile exists in
    // the rendered form, and the strings never even appear as field names.
    expect(html).not.toMatch(/name="(model|modelId|profile|profileId|profiles|fallbackProfileIds?)"/);
    expect(html).toContain('data-graph-revision="3"');
    expect(html).toContain('data-node-id="c"');
  });

  it("renders a typed locked notice (no form) for a running node (A38 前半)", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderNodeEditor(container, {
      node: {
        nodeId: "b",
        role: "developer",
        objective: "x",
        dependencies: ["a"],
        state: "RUNNING",
        editable: false
      },
      graphRevision: 3
    });
    const html = container.innerHTML;
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<select");
    expect(html).toContain("RUNNING");
    expect(html).toContain("A38");
    expect(html).toContain("不可原地修改");
  });

  it("escapes hostile objective text inside the value attribute", () => {
    const container = { innerHTML: "", hidden: true };
    api.renderNodeEditor(container, {
      node: {
        nodeId: "c",
        role: "developer",
        objective: '"><script>alert(9)</script>',
        dependencies: [],
        state: "READY",
        editable: true
      },
      graphRevision: 1
    });
    const html = container.innerHTML;
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("buildNodeEditPayload — the UI layer refuses override carriers (A02)", () => {
  const api = loadPageApi();

  it("builds the strict body from the allowlist fields", () => {
    const payload = api.buildNodeEditPayload("c", 3, {
      role: "developer",
      objective: "实现 x",
      dependencies: "a, b"
    });
    expect(payload).toEqual({
      expectedGraphRevision: 3,
      nodeId: "c",
      patch: { role: "developer", objective: "实现 x", dependencies: ["a", "b"] }
    });
  });

  it("refuses model/profile fields with a thrown error — they never become request fields", () => {
    for (const key of ["model", "modelId", "profile", "profileId", "profiles", "fallbackProfileId"]) {
      expect(() => api.buildNodeEditPayload("c", 3, { [key]: "override" })).toThrow(/A02/);
    }
  });

  it("refuses an empty field set", () => {
    expect(() => api.buildNodeEditPayload("c", 3, {})).toThrow(/at least one/);
  });
});
