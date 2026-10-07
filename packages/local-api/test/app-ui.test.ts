/**
 * M11-01 — the /app renderer static-shell loader: candidate resolution,
 * content-hash CSP derivation, fail-closed absence. The real desktop-ui
 * build is exercised end to end by the server tests and the browser-e2e
 * /app smoke; HERE everything runs on synthetic fixtures so the decision
 * logic is pinned without depending on another package's build output.
 * M11-02 review handover B adds the single fileURLToPath locator pins
 * (space/non-ASCII install paths) and the live dev-layout resolution check.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  appUiCandidatePaths,
  buildAppUiAsset,
  loadAppUiAsset,
  loadAppUiAssetFromModuleLocation,
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

  it("M11-02 handover B: space/non-ASCII install dirs join LITERALLY (no percent-encoding)", () => {
    // The defect this pins: the removed `new URL(…).pathname.replace(…)`
    // hand-decode kept percent-escapes encoded, so an install path like
    // "C:\Program Files\…" or a non-ASCII product directory broke /app.
    // Candidate construction is plain path joining — whatever the (already
    // decoded by fileURLToPath) module dir contains comes through verbatim.
    const dir = join("C:", "Program Files", "角色编排", "packages", "local-api", "dist");
    const paths = appUiCandidatePaths(dir);
    expect(paths[0]).toBe(join(dir, "desktop-ui.html"));
    expect(paths[1]).toContain(join("apps", "desktop-ui", "dist", "index.html"));
    for (const candidate of paths) {
      expect(candidate).toContain("Program Files");
      expect(candidate).toContain("角色编排");
      expect(candidate).not.toContain("%20");
      expect(candidate).not.toContain("%");
    }
  });

  it("the production sha256Hex matches node's sha256", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("M11-02 review handover B: the single fileURLToPath locator (server.ts wiring)", () => {
  const serverSource = readFileSync(fileURLToPath(new URL("../src/server.ts", import.meta.url)), "utf8");

  it("no module-load pathname hand-decode of import.meta.url survives in server.ts", () => {
    expect(serverSource).not.toMatch(/new URL\(".", import\.meta\.url\)\.pathname/);
  });

  it("the default asset resolves lazily through the shared loader (no top-level IO at import)", () => {
    expect(serverSource).toContain("loadAppUiAssetFromModuleLocation(");
    expect(serverSource).toMatch(/function defaultAppUiAsset\(\)/);
    // Lazy: the loader call sits inside the function, not at module top level.
    const topLevel = serverSource.slice(0, serverSource.indexOf("function defaultAppUiAsset"));
    expect(topLevel).not.toContain("loadAppUiAssetFromModuleLocation(");
  });

  it("live: the locator resolves the real repo dev-layout artifact through fileURLToPath", () => {
    // Under vitest the module location is packages/local-api/src, whose
    // second candidate is the repo dev layout. The artifact exists whenever
    // the desktop-ui build ran (repo-root pnpm build covers it); when it
    // has not, absence resolving to null is itself the honest contract —
    // both arms are asserted, nothing is faked. The probes are exactly the
    // production wiring (existsSync + readFileSync with null-on-error).
    const asset = loadAppUiAssetFromModuleLocation(existsSync, (candidate) => {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        return null;
      }
    });
    const devArtifact = fileURLToPath(new URL("../../../apps/desktop-ui/dist/index.html", import.meta.url));
    let built = false;
    try {
      built = readFileSync(devArtifact, "utf8").includes("<script");
    } catch {
      built = false;
    }
    if (built) {
      expect(asset).not.toBeNull();
      expect(asset!.html).toContain("<script");
      expect(asset!.cspHeader).toContain("script-src 'sha256-");
    } else {
      console.warn(
        "[app-ui.test] apps/desktop-ui/dist/index.html not built — asserting the absence arm " +
          "(run `pnpm --filter @role-orchestrator/desktop-ui run build` for the live arm)"
      );
      expect(asset).toBeNull();
    }
  });
});
