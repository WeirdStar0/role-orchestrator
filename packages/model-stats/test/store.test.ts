import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PerformanceStore, renderPerformanceReport } from "../src/index.js";
import { makeEvent } from "./helpers.js";

const tempDirs: string[] = [];
async function tempFile(name: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "model-stats-"));
  tempDirs.push(dir);
  return path.join(dir, name);
}
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("PerformanceStore (append-only by construction)", () => {
  it("aggregates per model: sums, event counts, sorted model ids", () => {
    const store = new PerformanceStore();
    store.append(makeEvent({ modelId: "m2", inputTokens: 1, outputTokens: 2 }));
    store.append(makeEvent({ modelId: "m1", inputTokens: 10, cacheReadTokens: 4, cacheCreationTokens: 6, outputTokens: 20 }));
    store.append(makeEvent({ modelId: "m1", inputTokens: 5 }));
    const summaries = store.summaryByModel();
    expect(summaries.map((s) => s.modelId)).toEqual(["m1", "m2"]);
    expect(summaries[0]).toMatchObject({
      eventCount: 2,
      totalInputTokens: 15,
      totalOutputTokens: 25,
      totalCacheReadTokens: 4,
      totalCacheCreationTokens: 6,
      totalTokens: 50
    });
    expect(summaries[1]).toMatchObject({ eventCount: 1, totalInputTokens: 1, totalOutputTokens: 2, totalTokens: 3 });
  });

  it("duration mean covers ONLY duration-bearing events; all-null stays null (never a 0)", () => {
    const store = new PerformanceStore();
    store.append(makeEvent({ modelId: "m", durationMs: 100 }));
    store.append(makeEvent({ modelId: "m", durationMs: 200 }));
    store.append(makeEvent({ modelId: "m", durationMs: null }));
    const summary = store.summaryByModel()[0];
    expect(summary?.averageDurationMs).toBe(150);
    expect(summary?.durationSampleCount).toBe(2);
    expect(summary?.eventCount).toBe(3);

    const noDurations = new PerformanceStore();
    noDurations.append(makeEvent({ modelId: "m", durationMs: null }));
    expect(noDurations.summaryByModel()[0]?.averageDurationMs).toBeNull();
    expect(noDurations.summaryByModel()[0]?.durationSampleCount).toBe(0);
  });

  it("events() is a defensive copy: mutating it cannot rewrite history", () => {
    const store = new PerformanceStore();
    store.append(makeEvent());
    const copy = store.events() as unknown as UsageEventMutable[];
    copy[0]!.inputTokens = 999_999;
    copy.push(makeEvent({ modelId: "ghost" }));
    expect(store.size).toBe(1);
    expect(store.events()[0]?.inputTokens).toBe(10);
    expect(store.summaryByModel()).toHaveLength(1);
  });

  it("append re-validates against the strict schema: garbage in, throw — not garbage stored", () => {
    const store = new PerformanceStore();
    expect(() => store.append({ bogus: true } as unknown as Parameters<PerformanceStore["append"]>[0])).toThrow();
    const smuggled = { ...makeEvent(), extra: 1 };
    expect(() => store.append(smuggled as unknown as Parameters<PerformanceStore["append"]>[0])).toThrow();
    expect(store.size).toBe(0);
  });

  it("the class surface is pinned: append-only — no update/delete/reset/clear/reclassify API exists", () => {
    const prototypeMethods = Object.getOwnPropertyNames(PerformanceStore.prototype).sort();
    expect(prototypeMethods).toEqual([
      "append",
      "appendMany",
      "constructor",
      "events",
      "flushToFile",
      "report",
      "size",
      "summaryByModel"
    ]);
    const statics = Object.getOwnPropertyNames(PerformanceStore).sort();
    expect(statics).toEqual(["length", "loadFromFile", "name", "prototype"]);
  });

  it("flushToFile APPENDS: a second flush never rewrites the first flush's bytes", async () => {
    const store = new PerformanceStore();
    const filePath = await tempFile("events.jsonl");
    store.append(makeEvent({ modelId: "a" }));
    expect(await store.flushToFile(filePath)).toBe(1);
    const firstBytes = await readFile(filePath, "utf8");
    expect(firstBytes).toContain('"modelId":"a"');

    store.append(makeEvent({ modelId: "b" }));
    expect(await store.flushToFile(filePath)).toBe(1);
    const secondBytes = await readFile(filePath, "utf8");
    expect(secondBytes.startsWith(firstBytes)).toBe(true);
    expect(secondBytes).toContain('"modelId":"b"');

    // Nothing pending: a redundant flush writes nothing.
    expect(await store.flushToFile(filePath)).toBe(0);
    expect(await readFile(filePath, "utf8")).toBe(secondBytes);
  });

  it("loadFromFile round-trips validated events and does not duplicate them on the next flush", async () => {
    const store = new PerformanceStore();
    const filePath = await tempFile("roundtrip.jsonl");
    store.append(makeEvent({ modelId: "m", inputTokens: 3 }));
    store.append(makeEvent({ modelId: "n", durationMs: 42 }));
    await store.flushToFile(filePath);

    const loaded = await PerformanceStore.loadFromFile(filePath);
    expect(loaded.size).toBe(2);
    expect(loaded.events()).toEqual(store.events());
    expect(loaded.summaryByModel().map((s) => s.modelId)).toEqual(["m", "n"]);
    expect(await loaded.flushToFile(filePath)).toBe(0);
  });

  it("loadFromFile fails closed on tampered content (non-JSON, schema-invalid, unknown fields)", async () => {
    const notJson = await tempFile("not-json.jsonl");
    await writeFile(notJson, "garbage\n", "utf8");
    await expect(PerformanceStore.loadFromFile(notJson)).rejects.toThrow(/not valid JSON/);

    const schemaInvalid = await tempFile("invalid.jsonl");
    await writeFile(schemaInvalid, `${JSON.stringify({ ...makeEvent(), inputTokens: -1 })}\n`, "utf8");
    await expect(PerformanceStore.loadFromFile(schemaInvalid)).rejects.toThrow(/failed UsageEvent validation/);

    const unknownField = await tempFile("unknown.jsonl");
    await writeFile(unknownField, `${JSON.stringify({ ...makeEvent(), stealth: true })}\n`, "utf8");
    await expect(PerformanceStore.loadFromFile(unknownField)).rejects.toThrow(/failed UsageEvent validation/);
  });
});

type UsageEventMutable = {
  inputTokens: number;
  [key: string]: unknown;
};

describe("report() read-only interface", () => {
  it("store.report() delegates to the pure renderer and is deterministic across calls", () => {
    const store = new PerformanceStore();
    store.append(makeEvent({ modelId: "m", durationMs: 1500 }));
    expect(store.report()).toBe(store.report());
    expect(store.report()).toBe(renderPerformanceReport(store.summaryByModel()));
    expect(store.size).toBe(1); // reporting mutated nothing
  });

  it("renders per-model blocks with token breakdowns, duration means, and contract-unknown cost", () => {
    const store = new PerformanceStore();
    store.append(makeEvent({ modelId: "m1", inputTokens: 2, outputTokens: 12, cacheReadTokens: 100, cacheCreationTokens: 3, durationMs: 3533 }));
    const report = store.report();
    expect(report).toContain("model: m1");
    expect(report).toContain("events (turn summaries): 1");
    expect(report).toContain("input=2 output=12");
    expect(report).toContain("mean=3533 over 1 event(s)");
    expect(report).toContain("cost: unknown");
    expect(report).toContain("no approved rate source");
  });

  it("an empty store renders an explicit no-data state (not zeros)", () => {
    expect(new PerformanceStore().report()).toContain("(no usage events recorded)");
  });

  it("decision vocabulary appears ONLY in the prohibition footer — the report advises nothing", () => {
    const store = new PerformanceStore();
    store.append(makeEvent({ modelId: "expensive-model", inputTokens: 1_000_000 }));
    store.append(makeEvent({ modelId: "cheap-model" }));
    const lines = store.report().split("\n");
    const decisionVocabulary = /switch|reroute|recommend|prefer|should use|fallback/i;
    const matching = lines.filter((line) => decisionVocabulary.test(line));
    expect(matching).toEqual([
      "This report is descriptive only. It must not be used to select, switch or reroute models."
    ]);
  });
});
