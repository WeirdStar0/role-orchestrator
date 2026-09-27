import { describe, expect, it, vi } from "vitest";
import { scanSecrets, KNOWN_RESERVATIONS, KNOWN_FAKE_SENTINELS } from "../src/secrets-scan.js";
import { makeTmpRoot, writeTree } from "./helpers.js";

/**
 * POLISH-2 (T1) injection gate for the module-mocked `node:fs`. With
 * `failReaddirFor = null` (the default, and the state outside the one
 * injection test below) every fs call delegates to the real implementation,
 * so all other tests in this file exercise the unmodified behaviour.
 */
const readdirGate = vi.hoisted(() => ({
  failReaddirFor: null as string | null,
  code: "ENOENT"
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const realReaddirSync = actual.readdirSync;
  return {
    ...actual,
    readdirSync: (target: unknown, options?: unknown) => {
      if (readdirGate.failReaddirFor !== null && String(target).includes(readdirGate.failReaddirFor)) {
        const error: NodeJS.ErrnoException = new Error(
          `${readdirGate.code}: simulated readdir failure (POLISH-2 T1): ${String(target)}`
        );
        error.code = readdirGate.code;
        error.syscall = "scandir";
        throw error;
      }
      return (realReaddirSync as (t: unknown, o?: unknown) => unknown)(target, options);
    }
  };
});

describe("scanSecrets", () => {
  it("a clean tree scans clean with a full account of what was walked", () => {
    const root = makeTmpRoot("ro-audit-clean-");
    writeTree(root, {
      "src/index.ts": "export const answer = 42;\n",
      "docs/readme.md": "# hello\n"
    });
    const result = scanSecrets({ repoRoot: root });
    expect(result.verdict).toBe("clean");
    expect(result.findings).toHaveLength(0);
    expect(result.scannedFiles).toBe(2);
    expect(result.textFiles).toBe(2);
    expect(result.binaryFiles).toBe(0);
  });

  it("a credential-shaped value outside tests is a needs-judgment finding and flips the verdict", () => {
    const root = makeTmpRoot("ro-audit-hit-");
    const fakeKey = "sk-ant-api03-0000000000000000";
    writeTree(root, { "src/config.yaml": `deployment:\n  key: ${fakeKey}\n` });
    const result = scanSecrets({ repoRoot: root });
    expect(result.verdict).toBe("findings");
    const hit = result.findings.find((f) => f.rule === "anthropic-key");
    expect(hit).toBeDefined();
    expect(hit?.classification).toBe("needs-judgment");
    // The preview is masked: it never carries the full planted value.
    expect(hit?.preview).not.toContain(fakeKey);
    expect(hit?.preview).toContain("masked");
  });

  it("the same value inside a test file is classified as a test sentinel", () => {
    const root = makeTmpRoot("ro-audit-test-");
    writeTree(root, { "test/redaction.test.ts": 'const token = "ghp_000000000000000000000";\n' });
    const result = scanSecrets({ repoRoot: root });
    expect(result.verdict).toBe("known-reservations-only");
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.classification).toBe("test-sentinel");
  });

  it("known reservation prefixes are pre-judged and still recorded", () => {
    const root = makeTmpRoot("ro-audit-resv-");
    writeTree(root, {
      "packages/cli-events/fixtures-real/claude/stream.real.jsonl": '{"line":"Bearer aaaabbbbccccddddeee"}\n',
      "packages/browser-e2e/evidence/shot.png": Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      "packages/fake-cli/fixtures/success.synthetic.jsonl": '{"session_id":"session_synth_0001"}\n'
    });
    const result = scanSecrets({ repoRoot: root });
    expect(result.verdict).toBe("known-reservations-only");
    const classes = result.findings.map((f) => f.classification).sort();
    expect(classes).toContain("desensitized-fixture");
    expect(result.reservationFiles).toContain("packages/browser-e2e/evidence/shot.png");
    expect(result.binaryFiles).toBe(1);
  });

  it("a .env file with a secret-shaped value is a structural plus content finding; .env.example is exempt", () => {
    const root = makeTmpRoot("ro-audit-env-");
    writeTree(root, {
      ".env": "API_KEY=sup3rs3cretvalue\nDEBUG=1\n",
      ".env.example": "API_KEY=<your-api-key>\nDEBUG=\n"
    });
    const result = scanSecrets({ repoRoot: root });
    const rules = result.findings.map((f) => f.rule);
    expect(rules).toContain("env-file-present");
    expect(rules).toContain("env-secret-shaped-value");
    // The benign DEBUG=1 line is recorded as plain env content, not a secret.
    expect(rules).toContain("env-value-present");
    // .env.example produced no findings.
    expect(result.findings.every((f) => f.file !== ".env.example")).toBe(true);
    expect(result.verdict).toBe("findings");
  });

  it("credential-shaped filenames are findings; .npmrc is content-checked only", () => {
    const root = makeTmpRoot("ro-audit-file-");
    writeTree(root, {
      "keys/id_rsa": "not really a key\n",
      "keys/server.pub": "public material\n",
      ".npmrc": "auto-install-peers=true\n",
      "leak/.npmrc": "_authToken=npm_000000000000000000000000\n"
    });
    const result = scanSecrets({ repoRoot: root });
    const rules = result.findings.map((f) => f.rule);
    expect(rules).toContain("credential-filename:id_rsa");
    expect(rules).toContain("npmrc-auth-entry");
    expect(rules).not.toContain("credential-filename:server.pub");
    // A clean .npmrc is not flagged for existing.
    expect(result.findings.filter((f) => f.file === ".npmrc")).toHaveLength(0);
  });

  it("binary files are not content-scanned (a secret behind a NUL byte is a filename-only surface)", () => {
    const root = makeTmpRoot("ro-audit-bin-");
    writeTree(root, { "assets/logo.png": Buffer.concat([Buffer.from([0x00, 0x01, 0x02]), Buffer.from("Bearer aaaabbbbccccdddd", "utf8")]) });
    const result = scanSecrets({ repoRoot: root });
    expect(result.binaryFiles).toBe(1);
    expect(result.findings.filter((f) => f.rule === "bearer-credential")).toHaveLength(0);
  });

  it("excluded directories (node_modules/dist/.turbo) are not scanned", () => {
    const root = makeTmpRoot("ro-audit-excl-");
    writeTree(root, {
      "node_modules/pkg/index.js": "sk-ant-api03-0000000000000000\n",
      "dist/bundle.js": "ghp_000000000000000000000\n",
      ".turbo/cache.txt": "AKIAIOSFODNN7EXAMPLE\n",
      "src/keep.ts": "export {}\n"
    });
    const result = scanSecrets({ repoRoot: root });
    expect(result.findings).toHaveLength(0);
    expect(result.scannedFiles).toBe(1);
  });

  it("the documented fake sentinel literal is classified without whitelisting anything else on the line", () => {
    const root = makeTmpRoot("ro-audit-sent-");
    writeTree(root, {
      "notes/summary.md": 'upstream said Authorization: Bearer livecred1234567890\n',
      "notes/other.md": "Authorization: Bearer totallydifferenttoken123\n"
    });
    const result = scanSecrets({ repoRoot: root });
    const sentinel = result.findings.find((f) => f.file === "notes/summary.md");
    const other = result.findings.find((f) => f.file === "notes/other.md");
    expect(sentinel?.classification).toBe("known-fake-sentinel");
    expect(other?.classification).toBe("needs-judgment");
    expect(result.verdict).toBe("findings");
  });

  it("assignment-shaped values are checked in config files but not in TypeScript source", () => {
    const root = makeTmpRoot("ro-audit-assign-");
    writeTree(root, {
      "settings/settings.yaml": 'database:\n  password: "plain-but-fake-123"\n',
      "src/schema.ts": 'export const x = { password: "plain-but-fake-123" };\n'
    });
    const result = scanSecrets({ repoRoot: root });
    expect(result.findings.some((f) => f.file === "settings/settings.yaml" && f.rule === "assignment-secret-value")).toBe(true);
    expect(result.findings.some((f) => f.file === "src/schema.ts")).toBe(false);
  });

  it("missing repo root is a typed precondition error", () => {
    expect(() => scanSecrets({ repoRoot: "Z:/definitely/not/there" })).toThrowError(/audit target is missing/);
  });

  it("a directory vanishing between stack push and readdir (ENOENT) is skipped, not fatal (POLISH-2 rotation concurrency)", () => {
    // POLISH-2 T1: with turbo running package tests in parallel, the
    // browser-e2e/dogfood evidence rotation deletes older run dirs while this
    // scan walks the tree — a directory can disappear after being discovered
    // and before its readdir. The walk must tolerate exactly that race
    // without weakening any scan semantics.
    const root = makeTmpRoot("ro-audit-vanish-");
    writeTree(root, {
      // This directory's contents are "already rotated away": its readdir
      // will fail below, so the file inside must never be discovered.
      "rotated-away/victim.log": "Bearer aaaabbbbccccdddd\n",
      // Surviving files must be scanned with the full unmodified semantics.
      "kept/notes.md": "nothing secret here\n",
      "src/planted.yaml": "value: sk-ant-api03-0000000000000000\n"
    });
    readdirGate.failReaddirFor = "rotated-away";
    try {
      const result = scanSecrets({ repoRoot: root });
      // No crash; the vanished directory contributes nothing to the walk…
      expect(result.scannedFiles).toBe(2);
      expect(result.findings.some((f) => f.file.startsWith("rotated-away/"))).toBe(false);
      // …while every surviving file is still scanned and classified as usual.
      const hit = result.findings.find((f) => f.rule === "anthropic-key");
      expect(hit?.file).toBe("src/planted.yaml");
      expect(hit?.classification).toBe("needs-judgment");
      expect(result.verdict).toBe("findings");
    } finally {
      readdirGate.failReaddirFor = null;
    }
    // The tolerance is ENOENT-ONLY: every other readdir error stays fatal.
    readdirGate.failReaddirFor = "kept";
    readdirGate.code = "EACCES";
    try {
      expect(() => scanSecrets({ repoRoot: root })).toThrowError(/EACCES/);
    } finally {
      readdirGate.failReaddirFor = null;
      readdirGate.code = "ENOENT";
    }
  });

  it("documents the known reservations and sentinels this scanner pre-judges", () => {
    expect(KNOWN_RESERVATIONS.map((r) => r.prefix)).toEqual([
      "packages/cli-events/fixtures-real/",
      "packages/browser-e2e/evidence/",
      "packages/fake-cli/fixtures/"
    ]);
    expect(KNOWN_FAKE_SENTINELS).toContain("livecred1234567890");
  });
});
