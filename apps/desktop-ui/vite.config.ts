/**
 * M11-01 build: the /app renderer is built as ONE inline single-file HTML
 * artifact (docs/BACKLOG.md M11-01 ④: "vite 单文件构建" — compatible with the
 * serve single-bundle / installer chain, see apps/desktop-ui/README.md).
 *
 * The inlining is done by THIS local plugin (no npm dependency beyond the
 * whitelisted vite itself): after the bundler (rolldown inside vite 8) emits
 * the chunks, the plugin finds the emitted JS/CSS assets, replaces their tags
 * inside index.html with inline <script type="module"> / <style> blocks,
 * refuses to emit anything but the single HTML file, and refuses the build
 * outright if any external asset reference survives (a silently-split
 * multi-file app shell would break both the installer layout and the
 * server's content-hash CSP).
 *
 * `</script` / `</style` inside the inlined text are escaped to `<\/script`
 * / `<\/style` — an identity escape that is a no-op inside JS string and
 * regex literals — so an inline block can never terminate its own tag.
 */
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function appSingleFile(): Plugin {
  return {
    name: "ro-app-single-file",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlEntry = Object.entries(bundle).find(
        ([fileName, item]) => fileName.endsWith(".html") && item.type === "asset"
      );
      if (htmlEntry === undefined) {
        throw new Error("app-single-file: no HTML entry in the build output");
      }
      let html = String((htmlEntry[1] as { source: string | Uint8Array }).source);
      for (const [fileName, item] of Object.entries(bundle)) {
        if (fileName.endsWith(".html")) continue;
        if (item.type !== "chunk" && item.type !== "asset") continue;
        const text = item.type === "chunk" ? item.code : String(item.source);
        if (fileName.endsWith(".js")) {
          const tag = new RegExp(
            `<script\\b[^>]*\\bsrc="[^"]*${escapeRegExp(fileName)}"[^>]*>\\s*</script>`
          );
          const inlined = text.replace(/<\/script/gi, "<\\/script");
          if (!tag.test(html)) {
            throw new Error(`app-single-file: no <script> tag references ${fileName}`);
          }
          // A replacement FUNCTION: a string replacement would interpret
          // `$&`/`$'`-style sequences that occur in any real JS bundle.
          html = html.replace(tag, () => `<script type="module">${inlined}</script>`);
        } else if (fileName.endsWith(".css")) {
          const tag = new RegExp(`<link\\b[^>]*\\bhref="[^"]*${escapeRegExp(fileName)}"[^>]*>`);
          const inlined = text.replace(/<\/style/gi, "<\\/style");
          if (!tag.test(html)) {
            throw new Error(`app-single-file: no <link> tag references ${fileName}`);
          }
          html = html.replace(tag, () => `<style>${inlined}</style>`);
        } else {
          throw new Error(`app-single-file: unexpected emitted asset ${fileName} — the app must be one inline HTML file`);
        }
      }
      if (/<script\b[^>]*\bsrc=|<link\b[^>]*\bhref=/.test(html)) {
        const leftovers = html.match(/<(script|link)\b[^>]*>/g) ?? [];
        throw new Error(
          "app-single-file: external asset references remain — refusing a split app shell. " +
            `Offending tags: ${leftovers.filter((tag) => /src=|href=/.test(tag)).join(" | ")}`
        );
      }
      for (const key of Object.keys(bundle)) {
        if (!key.endsWith(".html")) delete bundle[key];
      }
      (bundle[htmlEntry[0]] as { source: string }).source = html;
    }
  };
}

export default defineConfig({
  plugins: [react(), appSingleFile()],
  build: {
    // One chunk, one stylesheet: the single-file plugin inlines exactly these.
    cssCodeSplit: false,
    sourcemap: false,
    reportCompressedSize: false
  }
});
