import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_PATTERNS,
  SECRET_PLACEHOLDER,
  entropyBitsPerChar,
  redactJsonValue,
  redactText
} from "../src/index.js";

/** Deterministic 43-char base62 sample built by a fixed xorshift32 seed. */
function deterministicBase62(length: number, seed: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let state = seed >>> 0;
  let out = "";
  for (let i = 0; i < length; i++) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out += alphabet[state % alphabet.length] as string;
  }
  return out;
}

describe("entropyBitsPerChar", () => {
  it("computes exact values for degenerate and two-symbol inputs", () => {
    expect(entropyBitsPerChar("")).toBe(0);
    expect(entropyBitsPerChar("aaaaaaaaaa")).toBe(0);
    expect(entropyBitsPerChar("ab")).toBe(1);
    expect(entropyBitsPerChar("ababab")).toBe(1);
    expect(entropyBitsPerChar("aabb")).toBeCloseTo(1, 10);
  });
});

describe("redactText — default patterns (A36 落盘前)", () => {
  it("redacts Bearer credentials", () => {
    const result = redactText("GET failed: Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig");
    expect(result.text).toBe("GET failed: Authorization: Bearer [REDACTED]");
    expect(result.redactions["bearer-scheme"]).toBe(1);
  });

  it("redacts token=/api-key= shaped assignments including header style", () => {
    expect(redactText("token=abcdef1234567890").text).toBe("token=[REDACTED]");
    expect(redactText("api-key: sk-proj-abcdef1234567890").text).toBe("api-key: [REDACTED]");
    expect(redactText('password: "hunter2hunter2"').text).toBe('password: "[REDACTED]"');
    expect(redactText("x-api-key=1234567890abcdef").text).toBe("x-api-key=[REDACTED]");
  });

  it("leaves ordinary text and short values alone (negative cases)", () => {
    const untouched = [
      "mode=production",
      "the bearer of bad news arrived",
      "token=short", // 5 chars < 8
      "token=", // empty value
      "retry count 3 exceeded",
      "manifestHash 0123abcd for run-1"
    ];
    for (const text of untouched) {
      expect(redactText(text).text).toBe(text);
    }
  });

  it("is idempotent: the placeholder never re-matches", () => {
    const once = redactText("Authorization: Bearer abcdef123456 and token=qqqwwwEEE111");
    const twice = redactText(once.text);
    expect(twice.text).toBe(once.text);
    expect(once.text).not.toContain("abcdef123456");
    expect(once.text).not.toContain("qqqwwwEEE111");
    expect(once.text).toContain(SECRET_PLACEHOLDER);
  });

  it("accepts a custom pattern list", () => {
    const result = redactText("cargo manifest MNF-99887766 shipped", {
      patterns: [{ name: "manifest", regex: /MNF-\d{8}/g, replacement: "MNF-[REDACTED]" }]
    });
    expect(result.text).toBe("cargo manifest MNF-[REDACTED] shipped");
    expect(result.redactions["manifest"]).toBe(1);
  });
});

describe("redactText — optional high-entropy pass", () => {
  const tokenish = deterministicBase62(43, 0x1234567);

  it("does not flag long tokens by default", () => {
    expect(redactText(`credential ${tokenish} end`).text).toBe(`credential ${tokenish} end`);
  });

  it("flags long high-entropy token candidates when enabled", () => {
    // Guard the fixture itself: it really is high entropy and mixed-class.
    expect(entropyBitsPerChar(tokenish)).toBeGreaterThan(4.2);
    expect(tokenish).toMatch(/[a-z]/);
    expect(tokenish).toMatch(/[A-Z]/);
    expect(tokenish).toMatch(/[0-9]/);
    const result = redactText(`credential ${tokenish} end`, { highEntropy: true });
    expect(result.text).toBe(`credential [REDACTED] end`);
    expect(result.redactions["high-entropy-token"]).toBe(1);
  });

  it("leaves low-entropy long runs alone even when enabled", () => {
    const lowEntropy = "a".repeat(48);
    expect(redactText(`run ${lowEntropy} done`, { highEntropy: true }).text).toBe(
      `run ${lowEntropy} done`
    );
  });
});

describe("redactJsonValue", () => {
  it("walks nested payloads and reports the substitution count", () => {
    const payload = {
      summary: "call failed: Bearer abcdef123456",
      meta: { note: "api-key=9876543210abcdef", count: 2, ok: true, none: null },
      items: ["token=aaaabbbbcccc", "clean"]
    };
    const result = redactJsonValue(payload);
    const value = result.value as {
      summary: string;
      meta: { note: string; count: number };
      items: string[];
    };
    expect(value.summary).toBe("call failed: Bearer [REDACTED]");
    expect(value.meta.note).toBe("api-key=[REDACTED]");
    expect(value.meta.count).toBe(2);
    expect(value.items[0]).toBe("token=[REDACTED]");
    expect(value.items[1]).toBe("clean");
    expect(result.redactedCount).toBe(3);
  });

  it("passes scalars through untouched", () => {
    expect(redactJsonValue(5).value).toBe(5);
    expect(redactJsonValue(null).value).toBe(null);
    expect(redactJsonValue(false).value).toBe(false);
    expect(redactJsonValue("no secrets here").redactedCount).toBe(0);
  });

  it("ships a baseline pattern list covering the three required shapes", () => {
    const names = DEFAULT_REDACTION_PATTERNS.map((pattern) => pattern.name);
    expect(names).toEqual(["bearer-scheme", "key-value-secret"]);
  });
});
