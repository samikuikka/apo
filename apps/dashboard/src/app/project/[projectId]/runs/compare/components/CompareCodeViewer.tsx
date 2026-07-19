"use client";

import { useEffect, useRef } from "react";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import { EditorState, RangeSet, type Range } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import {
  EditorView,
  lineNumbers,
  gutter,
  GutterMarker,
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { tApiRegex } from "@/lib/t-api-highlight";

// Pure logic (marker types + placement) lives in a separate .ts module so it
// can be unit-tested without importing this .tsx file (the vitest JSX
// transform is currently broken in this repo — see CompareCodeViewer.test.ts).
export { buildMarkers } from "./compare-markers";
export type { LineAssertion, MarkerEntry } from "./compare-markers";
import { CompareMarker, type LineAssertion } from "./compare-markers";

interface CompareCodeViewerProps {
  code: string;
  language?: string;
  assertions: LineAssertion[];
  /** Called when a gutter marker is clicked. The viewer owns no reveal state;
   *  the parent decides what "reveal" means. */
  onMarkerClick?: (line: number, side: "A" | "B") => void;
  className?: string;
}

/** Build the CodeMirror RangeSet of gutter markers from the line assertions.
 *  Each assertion line contributes two markers (Run A + Run B) at the line's
 *  start position. Gutter markers are point ranges (zero-width) so they attach
 *  to a line without covering any document. RangeSet.of requires sorted input;
 *  our lines are already in order, and within a line A precedes B. */
function buildGutterDecorations(view: EditorView, assertions: LineAssertion[]): RangeSet<GutterMarker> {
  const ranges: Range<GutterMarker>[] = [];
  for (const a of assertions) {
    if (a.line < 1 || a.line > view.state.doc.lines) continue;
    const from = view.state.doc.line(a.line).from;
    if (a.notEvaluated) {
      ranges.push(new CompareMarker(undefined, "A").range(from));
      ranges.push(new CompareMarker(undefined, "B").range(from));
      continue;
    }
    ranges.push(new CompareMarker(a.left, "A").range(from));
    ranges.push(new CompareMarker(a.right, "B").range(from));
  }
  if (ranges.length === 0) return RangeSet.empty;
  return RangeSet.of(ranges, true);
}

// ── t.* API highlighter (orange) — matches the single-run CodeViewer. ─────
function buildTApiDecorations(view: EditorView): DecorationSet {
  const builder: Array<{ from: number; to: number; deco: ReturnType<typeof Decoration.mark> }> = [];
  for (const { from, to } of view.visibleRanges) {
    const slice = view.state.sliceDoc(from, to);
    tApiRegex.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tApiRegex.exec(slice)) !== null) {
      const start = from + m.index;
      builder.push({ from: start, to: start + m[0].length, deco: Decoration.mark({ class: "cm-apo-t-api" }) });
    }
  }
  if (builder.length === 0) return Decoration.none;
  return Decoration.set(builder.map((b) => b.deco.range(b.from, b.to)), true);
}

const apoHighlighter = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildTApiDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.reconfigured)) {
        this.decorations = buildTApiDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const githubDarkHighlight = HighlightStyle.define([
  { tag: [t.comment, t.lineComment, t.blockComment], color: "#6a737d", fontStyle: "italic" },
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword], color: "#f97583" },
  { tag: [t.string, t.special(t.string)], color: "#9ecbff" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#79b8ff" },
  { tag: [t.function(t.variableName), t.definition(t.function(t.variableName))], color: "#b392f0" },
  { tag: [t.typeName, t.definition(t.typeName)], color: "#79b8ff" },
  { tag: [t.propertyName, t.variableName], color: "#e1e4e8" },
  { tag: [t.tagName], color: "#85e89e" },
  { tag: [t.operator, t.punctuation, t.separator], color: "#e1e4e8" },
]);

const theme = EditorView.theme({
  "&": { fontSize: "12px", backgroundColor: "transparent", color: "#e1e4e8" },
  ".cm-content": { fontFamily: "var(--font-mono)", color: "#e1e4e8" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    borderRight: "1px solid oklch(0.28 0 0)",
    color: "oklch(0.45 0 0)",
  },
  ".cm-lineNumbers .cm-gutterElement": { color: "oklch(0.45 0 0)", minWidth: "2.5em" },
  ".cm-scroller": { maxHeight: "none", fontFamily: "var(--font-mono)" },
  ".cm-activeLine": { backgroundColor: "oklch(0.22 0 0 / 0.5)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "oklch(0.7 0 0)" },
  "&.cm-editor.cm-focused": { outline: "none" },
  ".cm-apo-t-api": { color: "#ffa657 !important", fontWeight: "600" },
  ".cm-apo-t-api *": { color: "#ffa657 !important", fontWeight: "600" },
  // The compare gutter sits to the right of line numbers. Each gutter element
  // holds the two markers (Run A + Run B) for that line, side by side.
  ".cm-compare-gutter": { width: "44px" },
  ".cm-compare-gutter .cm-gutterElement": {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "0 4px",
  },
  ".cm-compare-marker": { transition: "opacity 0.1s" },
  ".cm-compare-gutter .cm-gutterElement:hover .cm-compare-marker": { opacity: "0.7" },
});

/** CodeMirror viewer for the compare view: full syntax highlighting (matching
 *  the single-run page) plus a custom two-marker gutter — Run A ✓/✗ and Run B
 *  ✓/✗ per assertion line, sitting in a dedicated gutter column like the lint
 *  markers on the single-run page. Clicking a marker surfaces that run's
 *  result in a panel rendered by the parent (no native tooltips — they were
 *  flaky inside CodeMirror's virtualized DOM). */
export function CompareCodeViewer({
  code,
  language,
  assertions,
  onMarkerClick,
  className,
}: CompareCodeViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const langExt = language === "python" ? python() : javascript({ typescript: true });

    // The gutter: one column to the right of line numbers, holding two
    // markers per assertion line. Click routing goes through CodeMirror's
    // domEventHandlers (reliable, unlike HTML title tooltips inside CM).
    const compareGutter = gutter({
      class: "cm-compare-gutter",
      markers: (view) => buildGutterDecorations(view, assertions),
      domEventHandlers: {
        click(view, block, event) {
          if (!onMarkerClick) return false;
          const target = event.target as HTMLElement | null;
          // The marker span carries data-side; walk up in case the click hit
          // a child or the gutter cell itself.
          const sideEl = target?.closest("[data-side]") as HTMLElement | null;
          if (!sideEl?.dataset.side) return false;
          const side = sideEl.dataset.side === "A" ? "A" : "B";
          const line = view.state.doc.lineAt(block.from).number;
          onMarkerClick(line, side);
          return true;
        },
      },
    });

    const state = EditorState.create({
      doc: code,
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        langExt,
        syntaxHighlighting(githubDarkHighlight),
        apoHighlighter,
        compareGutter,
        theme,
      ],
    });
    const view = new EditorView({ state, parent: hostRef.current });
    return () => {
      view.destroy();
    };
    // Recreate the editor when inputs change identity. `onMarkerClick` is
    // captured at creation; callers should memoize or accept that a click
    // after a re-render uses the latest closure via the ref below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, language, assertions]);

  // Keep the latest click handler without rebuilding the editor on every
  // parent re-render. The gutter closure captures `onMarkerClick` from the
  // effect above; route through a ref so it always sees the current callback.
  // Written via useEffect (not in the render body) so render stays pure.
  const clickRef = useRef(onMarkerClick);
  useEffect(() => {
    clickRef.current = onMarkerClick;
  });

  return <div ref={hostRef} className={className} />;
}
