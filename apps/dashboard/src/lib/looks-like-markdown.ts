/**
 * Heuristic: does a string deliverable read as Markdown?
 *
 * Deliverable bodies arrive as parsed JSON values, so the viewer only sees
 * a JS string — there is no media_type to consult (every JSON deliverable
 * is stamped `application/json` server-side). Markdown-looking strings get
 * the shared `Markdown` renderer like the rest of the dashboard (judge
 * values, transcripts, reasoning); everything else stays a code block.
 *
 * Line-anchored structural markers (one is enough) plus well-formed inline
 * markers. Deliberately conservative: prose with dashes, mid-line asterisk
 * math, snake_case, or parentheticals must stay plain text.
 */

// Structural markers match at line starts: headings, lists, fences,
// blockquotes, table rows.
const STRUCTURAL = [
  /^#{1,6}\s+\S/m, // ATX heading
  /^ {0,3}[-*+]\s+\S/m, // bullet list item
  /^ {0,3}\d+\.\s+\S/m, // ordered list item ("2.4. Feature" must NOT match — the dot needs trailing space)
  /^```/m, // fenced code block
  /^ {0,3}>/m, // blockquote
  /^\s*\|.+\|\s*$/m, // table row
  /^(?:---+|\*\*\*+|___+)\s*$/m, // horizontal rule
];

// Inline markers must be well-formed: a lone `*` (math), `_` (snake_case),
// or `>` (comparison) in prose never matches these.
const INLINE = [
  /\[[^\]]+\]\([^)\s]+\)/, // [text](url)
  /\*\*[^*\n]+\*\*/, // **bold**
  /`[^`\n]+`/, // `code`
];

export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.length < 3) return false;
  // Pretty-printed JSON is not prose — and its string values can carry
  // markdown fragments (a chat transcript's bold/link syntax) that light up
  // the markers below. Feeding 100s of KB of escaped JSON to the markdown
  // parser freezes the tab for tens of seconds.
  if (parseJsonText(text) !== null) return false;
  return (
    STRUCTURAL.some((re) => re.test(text)) || INLINE.some((re) => re.test(text))
  );
}

/**
 * Parse a string deliverable body as a JSON object or array, or return null.
 *
 * Deliverable bodies can arrive as pre-serialized JSON text (a `conversation`
 * transcript is pretty-printed JSON); only object/array roots qualify, so
 * scalar-looking strings ("42", plain prose) stay strings. Callers use the
 * parsed value to route the body into the JSON tree viewer instead of the
 * markdown/code renderers.
 */
export function parseJsonText(text: string): object | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}
