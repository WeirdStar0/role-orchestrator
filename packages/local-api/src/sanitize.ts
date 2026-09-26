/**
 * Rendering sanitization for the local events page (A36, "渲染消毒").
 *
 * Every dynamic text that reaches the page DOM passes `escapeHtml` first,
 * so log samples containing `<script>`, `<img onerror=...>` or fake secrets
 * become inert character references instead of live markup. The page's
 * client-side script (page.ts) embeds the SAME algorithm; the tests evaluate
 * that served script directly and assert no script-execution surface.
 *
 * `stripAnsiEscapes` removes terminal escape sequences (A36 mentions escape
 * sequences alongside HTML and secrets) so hostile `\x1b[...` payloads in
 * log text can neither restyle a terminal rendering of the log nor smuggle
 * markup; it runs BEFORE HTML escaping in the page pipeline.
 */

const HTML_ESCAPE_TABLE: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "`": "&#96;",
  "=": "&#61;"
};

const HTML_ESCAPE_REGEX = /[&<>"'`=]/g;

/**
 * Escape a string for safe interpolation into HTML text content AND double-
 * quoted attribute values. Escaping `=` and backtick additionally defuses
 * unquoted-attribute and template-literal contexts. NOT idempotent by design
 * (`&amp;` re-escapes to `&amp;amp;`); escape exactly once at the render
 * boundary — `isHtmlEscaped` can guard callers that cannot prove freshness.
 */
export function escapeHtml(text: string): string {
  return text.replace(HTML_ESCAPE_REGEX, (char) => HTML_ESCAPE_TABLE[char] ?? char);
}

/**
 * True when the text contains no characters that `escapeHtml` would change;
 * used to avoid double-escaping already-escaped content.
 */
export function isHtmlEscaped(text: string): boolean {
  HTML_ESCAPE_REGEX.lastIndex = 0;
  return !HTML_ESCAPE_REGEX.test(text);
}

// CSI: ESC [ parameters (0x30–0x3F) intermediates (0x20–0x2F) final (0x40–0x7E);
// Fe: ESC + single-byte sequences; plus C1 CSI (0x9B) and string terminators.
const ANSI_ESCAPE_REGEX = /\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])|\u009b[0-?]*[ -/]*[@-~]/g;

/** Remove ANSI/VT terminal escape sequences from log text. */
export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_ESCAPE_REGEX, "");
}

/**
 * Full page-pipeline text sanitization: strip terminal escapes, then HTML-
 * escape. This is the ONLY sanctioned way for dynamic text to reach the DOM.
 */
export function sanitizeDisplayText(text: string): string {
  return escapeHtml(stripAnsiEscapes(text));
}
