import { describe, expect, it } from "vitest";
import { looksLikeMarkdown, parseJsonText } from "../looks-like-markdown";

describe("looksLikeMarkdown", () => {
  it("detects structural markers", () => {
    expect(looksLikeMarkdown("# Due Diligence Memo\n\nBody")).toBe(true);
    expect(looksLikeMarkdown("## Section\nbody")).toBe(true);
    expect(looksLikeMarkdown("intro\n\n- first\n- second")).toBe(true);
    expect(looksLikeMarkdown("intro\n\n* first\n* second")).toBe(true);
    expect(looksLikeMarkdown("steps:\n\n1. do this\n2. then that")).toBe(true);
    expect(looksLikeMarkdown("text\n\n```python\nx = 1\n```")).toBe(true);
    expect(looksLikeMarkdown("quote:\n\n> counsel estimates")).toBe(true);
    expect(looksLikeMarkdown("| a | b |\n| --- | --- |\n| 1 | 2 |")).toBe(true);
    expect(looksLikeMarkdown("see [the spec](https://example.com) here")).toBe(true);
    expect(looksLikeMarkdown("this is **materially** wrong")).toBe(true);
  });

  it("does not flag plain prose", () => {
    expect(
      looksLikeMarkdown(
        "There are no issues identified in the provided documents. All questions were answered directly from the text.",
      ),
    ).toBe(false);
    expect(looksLikeMarkdown("N/A")).toBe(false);
    expect(looksLikeMarkdown("")).toBe(false);
    expect(looksLikeMarkdown("ok")).toBe(false);
    expect(
      looksLikeMarkdown(
        "Defense counsel assesses an $8.5 million to 14.0 million probable settlement range.",
      ),
    ).toBe(false);
  });

  it("does not flag prose with punctuation that resembles markers", () => {
    // Em-dash separated clause, mid-line asterisk math, snake_case, a
    // version number at line start, and a bare parenthetical are all prose.
    expect(looksLikeMarkdown("well - known caveat")).toBe(false);
    expect(looksLikeMarkdown("compute 5 * 3 and 2 * 8")).toBe(false);
    expect(looksLikeMarkdown("the foo_bar_baz identifier")).toBe(false);
    expect(looksLikeMarkdown("2.4. Feature list")).toBe(false);
    expect(looksLikeMarkdown("see chapter (appendix a) for details")).toBe(false);
    expect(looksLikeMarkdown("a > b under load")).toBe(false);
  });

  it("does not flag JSON or shell-ish blobs", () => {
    expect(looksLikeMarkdown('{"pass": true, "reasoning": "ok"}')).toBe(false);
    expect(looksLikeMarkdown("Error: ENOENT /tmp/foo/bar")).toBe(false);
  });

  it("does not flag serialized JSON whose values carry markdown fragments", () => {
    // A conversation-transcript deliverable: pretty-printed JSON whose string
    // values contain bold/link/code markdown. The body is JSON, not prose —
    // feeding it to the markdown renderer freezes the tab for tens of seconds.
    const transcript = JSON.stringify(
      [
        {
          role: "assistant",
          content: "**Note:** see [the draft](./draft.md) and `addParagraph` usage.",
        },
      ],
      null,
      2,
    );
    expect(looksLikeMarkdown(transcript)).toBe(false);
  });
});

describe("parseJsonText", () => {
  it("parses object and array roots", () => {
    expect(parseJsonText('{"a": 1}')).toEqual({ a: 1 });
    expect(parseJsonText('  [\n  {"role": "user"}\n]')).toEqual([{ role: "user" }]);
  });

  it("rejects scalar roots, broken JSON, and prose", () => {
    expect(parseJsonText("42")).toBeNull();
    expect(parseJsonText('"a json string"')).toBeNull();
    expect(parseJsonText('{"broken": ')).toBeNull();
    // Prose that merely mentions braces stays a string.
    expect(parseJsonText("here {is} some prose with brackets")).toBeNull();
  });
});
