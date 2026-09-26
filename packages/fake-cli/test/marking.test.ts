/**
 * Marks the package boundary: the name and bin names must carry "fake" so the
 * synthetic CLI can never be mistaken for a real claude/codex binary.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("synthetic marking", () => {
  test("package name contains 'fake'", () => {
    const pkg = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as {
      name: unknown;
      bin: Record<string, unknown>;
    };
    expect(typeof pkg.name).toBe("string");
    expect(pkg.name as string).toContain("fake");
    expect(Object.keys(pkg.bin).sort()).toEqual(["fake-claude", "fake-codex"]);
    for (const target of Object.values(pkg.bin)) {
      expect(String(target)).toMatch(/^\.\/dist\/bin\/fake-(claude|codex)\.js$/);
    }
  });

  test("README states the synthetic disclaimer", () => {
    const readme = readFileSync(path.join(packageDir, "README.md"), "utf8");
    expect(readme).toContain("SYNTHETIC");
    expect(readme).toContain("M0-03");
    expect(readme).toContain("M0-04");
  });
});
