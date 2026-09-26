/**
 * Bundle -> prompt rendering (M3-04 dogfood plumbing).
 *
 * `renderBundlePrompt` turns ONE assembled context bundle into the execution
 * prompt text the engine feeds to the CLI subprocess via stdin. It renders
 * EXACTLY what the manifest says the agent sees: the bundle identity, the
 * manifest digest and the KEPT fragments in manifest order, each preceded by
 * its full provenance line (layer / trust / source kind+id / revision /
 * commitSha / artifactId). Rendering is deterministic: same bundle, same
 * bytes — the codex node's prompt file can therefore be compared byte-for-
 * byte against the re-rendering from the persisted bundle.
 *
 * This is presentation of already-assembled data, not assembly: every fact
 * here traces to a persisted fragment row (A15/M3-01 provenance).
 */
import { manifestDigest, type ContextBundle } from "@role-orchestrator/context";

function provenanceLine(fragment: ContextBundle["fragments"][number]): string {
  const source = fragment.source;
  const parts = [
    `layer=${fragment.layer}`,
    `trust=${fragment.trust}`,
    `source=${source.kind}/${source.id}`,
    `revision=${source.revision ?? "-"}`,
    `commitSha=${source.commitSha ?? "-"}`,
    `artifactId=${source.artifactId ?? "-"}`
  ];
  return `[fragment seq=${String(fragment.sequence)} ${parts.join(" ")}]`;
}

/** Deterministic prompt text for one assembled bundle (kept fragments only). */
export function renderBundlePrompt(bundle: ContextBundle): string {
  const manifest = bundle.manifest;
  const kept = bundle.fragments
    .filter((fragment) => fragment.included)
    .sort((a, b) => a.sequence - b.sequence);
  const lines: string[] = [
    "[context-bundle v1]",
    `bundleId: ${manifest.bundleId}`,
    `manifestSha256: ${manifestDigest(manifest)}`,
    `scope: project=${manifest.projectId} run=${manifest.runId} node=${manifest.nodeId} role=${manifest.roleId}`,
    `fragments: ${String(kept.length)} kept, ${String(manifest.omitted.length)} omitted`,
    "---"
  ];
  for (const fragment of kept) {
    lines.push(provenanceLine(fragment));
    lines.push(fragment.content);
    lines.push("---");
  }
  return `${lines.join("\n")}\n`;
}
