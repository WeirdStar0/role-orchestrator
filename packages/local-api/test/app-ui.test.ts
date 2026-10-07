/**
 * M11-01 — the /app renderer static-shell loader: candidate resolution,
 * content-hash CSP derivation, fail-closed absence. The real desktop-ui
 * build is exercised end to end by the server tests and the browser-e2e
 * /app smoke; HERE everything runs on synthetic fixtures so the decision
 * logic is pinned without depending on another package's build output.
 */
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  appUiCandidatePaths,
  buildAppUiAsset,
  loadAppUiAsset,
  sha256Hex
} from "../src/index.js";

const APP_HTML =
  "<!doctype html><html lang=\"zh-CN\"><head><title>role-orchestrator</title>" +
  "<style>body{margin:0}</style></head><body><div id=\"root\"></div>" +
  "<script type=\"module\">const x=1;<\/script></body></html>";

function fakeSha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

describe("buildAppUiAsset (content-hash CSP)", () => {
  it("hash-pins every inline script and style block, nothing else opens", () => {
    const asset = buildAppUiAsset(APP_HTML, fakeSha);
    expect(asset).not.toBeNull();
    const csp = asset!.cspHeader;
    expect(csp.startsWith("default-src 'none'")).toBe(true);
    expect(csp).toContain("script-src 'sha256-");
    expect(csp).toContain("style-src 'sha256-");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    // NO unsafe-inline / unsafe-eval / external origins anywhere.
    expect(csp).not.toContain("unsafe-");
    expect(csp).not.toMatch(/https?:\/\//);
    // The hashes are exactly the sha256 of the served block bodies (the
    // browser validates the served bytes, so the hash input must be the
    // same text).
    const scriptBody = "const x=1;";
    const expected = Buffer.from(fakeSha(scriptBody), "hex").toString("base64");
    expect(csp).toContain(`'sha256-${expected}'`);
  });

  it("returns null (fail-closed to the 302 fallback) for a shape without scripts", () => {
    expect(buildAppUiAsset("<html><body><div id=\"root\"></div></body></html>", fakeSha)).toBeNull();
  });

  it("supports multiple inline blocks (one hash each)", () => {
    const html =
      "<body><style>a{}</style><style>b{}</style>" +
      "<script>one();<\/script><script>two();<\/script></body>";
    const asset = buildAppUiAsset(html, fakeSha);
    expect(asset).not.toBeNull();
    const hashes = asset!.cspHeader.match(/sha256-[A-Za-z0-9+/=]+/g) ?? [];
    expect(hashes).toHaveLength(4); // 2 scripts + 2 styles
  });
});

describe("loadAppUiAsset (candidate resolution, absence is not an error)", () => {
  it("resolves the first existing candidate and skips missing/broken ones", () => {
    const candidates = ["C:/install/desktop-ui.html", "C:/repo/apps/desktop-ui/dist/index.html"];
    const asset = loadAppUiAsset(
      candidates,
      (path) => path === candidates[1],
      (path) => (path === candidates[1] ? APP_HTML : null)
    );
    expect(asset).not.toBeNull();
    expect(asset!.html).toBe(APP_HTML);
  });

  it("treats a present-but-unreadable/unparsable artifact as absence (null)", () => {
    const candidates = ["C:/install/desktop-ui.html"];
    expect(loadAppUiAsset(candidates, () => true, () => null)).toBeNull();
    expect(loadAppUiAsset(candidates, () => true, () => "<html>no scripts</html>")).toBeNull();
    expect(loadAppUiAsset(candidates, () => false, () => APP_HTML)).toBeNull();
  });
});

describe("appUiCandidatePaths (layout contract)", () => {
  it("names the install-adjacent resource first, then the repo dev layout", () => {
    // path.join normalizes separators per platform, so the expectations are
    // built with the same join the production code uses.
    const paths = appUiCandidatePaths(join("C:", "app", "packages", "local-api", "dist"));
    expect(paths[0]).toBe(join("C:", "app", "packages", "local-api", "dist", "desktop-ui.html"));
    expect(paths[1]).toContain(join("apps", "desktop-ui", "dist", "index.html"));
  });

  it("the production sha256Hex matches node's sha256", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});
