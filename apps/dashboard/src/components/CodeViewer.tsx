"use client";

import { useEffect, useRef } from "react";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import { EditorState, StateEffect, StateField } from "@codemirror/state";
// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import { EditorView, lineNumbers, ViewPlugin, Decoration, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { lintGutter, setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { syntaxHighlighting, HighlightStyle } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { tApiRegex } from "@/lib/t-api-highlight";

export interface CodeDiagnostic {
  line: number;
  column?: number;
  message: string;
  severity?: "error" | "warning" | "info";
  label?: string;
  expected?: string;
  received?: string;
  reasoning?: string;
  evaluator_type?: "llm" | "code" | "agent";
}

// Stable empty array so a missing `diagnostics` prop doesn't break memoization.
const EMPTY_DIAGNOSTICS: CodeDiagnostic[] = [];

interface CodeViewerProps {
  code: string;
  language?: string;
  diagnostics?: CodeDiagnostic[];
  onDiagnosticClick?: (line: number, clientX: number, clientY: number) => void;
  className?: string;
}

function offsetRange(code: string, line: number, column?: number): { from: number; to: number } {
  const lines = code.split("\n");
  let start = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) {
    start += lines[i].length + 1;
  }
  if (column && column > 0) {
    const from = Math.min(start + column - 1, code.length);
    return { from, to: Math.min(from + 1, code.length) };
  }
  const lineLen = lines[line - 1]?.length ?? 0;
  return { from: start, to: Math.min(start + Math.max(lineLen, 1), code.length) };
}

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
    constructor(view: EditorView) { this.decorations = buildTApiDecorations(view); }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.reconfigured)) {
        this.decorations = buildTApiDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ── Diagnostic-line hover affordance ──────────────────────────────────
// Lights up the diagnostic line under the cursor (red for errors, neutral
// for passing assertions) and turns the whole line into a click target, so
// the drawer is discoverable without aiming for the tiny wavy underline.
// Mirrors the landing-page RunDetailMock's "Inspect" affordance.

const setDiagLines = StateEffect.define<ReadonlyMap<number, "error" | "info">>();
const diagLinesField = StateField.define<ReadonlyMap<number, "error" | "info">>({
  create: () => new Map(),
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setDiagLines)) return e.value;
    return value;
  },
});

const setHoveredLine = StateEffect.define<number | null>();
const hoverField = StateField.define<number | null>({
  create: () => null,
  update: (value, tr) => {
    for (const e of tr.effects) if (e.is(setHoveredLine)) return e.value;
    return value;
  },
});

// posAtCoords is documented to return null for unresolvable coordinates, but
// its block→line resolution can also throw on transient layouts — treat both
// as "no position here" (same defensive pattern as the click handler).
function posFromCoordsSafe(view: EditorView, x: number, y: number): number | null {
  try {
    return view.posAtCoords({ x, y });
  } catch {
    return null;
  }
}

function buildHoverDecorations(view: EditorView): DecorationSet {
  const hovered = view.state.field(hoverField);
  if (hovered === null) return Decoration.none;
  const severity = view.state.field(diagLinesField).get(hovered);
  if (!severity) return Decoration.none;
  const lineClass = severity === "error" ? "cm-diag-line--error" : "cm-diag-line--info";
  let line;
  try {
    line = view.state.doc.line(hovered);
  } catch {
    return Decoration.none;
  }
  return Decoration.set([Decoration.line({ class: lineClass }).range(line.from)], true);
}

const hoverHighlight = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildHoverDecorations(view); }
    update(u: ViewUpdate) { this.decorations = buildHoverDecorations(u.view); }
  },
  {
    decorations: (v) => v.decorations,
    eventHandlers: {
      mousemove: (e, view) => {
        const pos = posFromCoordsSafe(view, e.clientX, e.clientY);
        if (pos === null) return;
        let lineNum: number;
        try {
          lineNum = view.state.doc.lineAt(pos).number;
        } catch {
          return;
        }
        // Only dispatch on line crossings — bounded by line count, not pixels.
        if (lineNum === view.state.field(hoverField)) return;
        const has = view.state.field(diagLinesField).has(lineNum);
        view.dispatch({ effects: setHoveredLine.of(has ? lineNum : null) });
      },
      mouseleave: (_e, view) => {
        if (view.state.field(hoverField) !== null) {
          view.dispatch({ effects: setHoveredLine.of(null) });
        }
      },
    },
  },
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
  ".cm-scroller": { maxHeight: "480px", fontFamily: "var(--font-mono)" },
  ".cm-activeLine": { backgroundColor: "oklch(0.22 0 0 / 0.5)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "oklch(0.7 0 0)" },
  "&.cm-editor.cm-focused": { outline: "none" },
  ".cm-lintRange-error": { textDecorationColor: "var(--destructive)" },
  ".cm-lint-marker-error": { color: "var(--destructive)", cursor: "pointer" },
  ".cm-lint-marker-info": {
    color: "var(--success)",
    cursor: "pointer",
    // Override CodeMirror's default info marker (a purple #aaf square) with
    // a small green dot — passing assertions are the baseline, not the focus.
    // Faded by default so failures dominate visually; scales up on hover so
    // the value is still accessible when you want it.
    content: "url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 40 40%27%3E%3Ccircle cx=%2720%27 cy=%2720%27 r=%276%27 fill=%27%2334d399%27/%3E%3C/svg%3E')",
    opacity: "0.4",
    transition: "opacity 0.15s, transform 0.15s",
    transform: "scale(0.7)",
  },
  ".cm-lint-marker-info:hover": {
    opacity: "1",
    transform: "scale(1.1)",
  },
  ".cm-lintRange-info": { textDecorationColor: "transparent" },
  ".cm-apo-t-api": { color: "#ffa657 !important", fontWeight: "600" },
  ".cm-apo-t-api *": { color: "#ffa657 !important", fontWeight: "600" },
  ".cm-diagnostic": {
    borderLeft: "3px solid var(--destructive)",
    backgroundColor: "oklch(0.2 0 0)",
    color: "oklch(0.85 0 0)",
    fontFamily: "var(--font-mono)",
    fontSize: "11px",
  },
  ".cm-diagnostic-error": { borderLeftColor: "var(--destructive)" },
  ".cm-diagnostic-info": { borderLeftColor: "var(--success)" },
  // Diagnostic-line hover: red tint on failures, neutral on passes, pointer
  // cursor on both. The ::after "Inspect" badge appears on hover to signal
  // that the whole line opens the assertion drawer.
  ".cm-diag-line--error": {
    backgroundColor: "oklch(0.5 0.22 25 / 0.12)",
    cursor: "pointer",
  },
  ".cm-diag-line--info": {
    backgroundColor: "oklch(0.7 0 0 / 0.06)",
    cursor: "pointer",
  },
  ".cm-diag-line--error::after, .cm-diag-line--info::after": {
    content: '"Inspect"',
    marginLeft: "0.75rem",
    padding: "0 0.375rem",
    border: "1px solid oklch(0.4 0 0)",
    fontSize: "10px",
    fontWeight: "500",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    color: "oklch(0.6 0 0)",
  },
  ".cm-diag-line--error::after": {
    color: "var(--destructive)",
    borderColor: "oklch(0.5 0.22 25 / 0.55)",
  },
});

export function CodeViewer({
  code,
  language,
  diagnostics = EMPTY_DIAGNOSTICS,
  onDiagnosticClick,
  className,
}: CodeViewerProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest click callback in a ref so the editor effect doesn't need
  // to tear down and rebuild CodeMirror on every parent render. Written via
  // useEffect (not in the render body) so render stays pure.
  const onDiagnosticClickRef = useRef(onDiagnosticClick);
  useEffect(() => {
    onDiagnosticClickRef.current = onDiagnosticClick;
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const langExt = language === "python" ? python() : javascript({ typescript: true });
    const state = EditorState.create({
      doc: code,
      extensions: [
        lineNumbers(),
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        langExt,
        syntaxHighlighting(githubDarkHighlight),
        apoHighlighter,
        diagLinesField,
        hoverField,
        hoverHighlight,
        lintGutter(),
        theme,
      ],
    });
    const view = new EditorView({ state, parent: host });

    // Click handler — opens the assertion drawer when the click lands on a
    // diagnostic. Marker/underline clicks always open it; any other click on
    // a diagnostic line opens it too (the whole line is a target), except
    // when the click finishes a drag-selection (don't hijack text selection).
    const clickHandler = (e: MouseEvent) => {
      const handler = onDiagnosticClickRef.current;
      if (!handler) return;
      const target = e.target as HTMLElement;
      const isMarker = target.classList.contains("cm-lint-marker-error") ||
        target.classList.contains("cm-lint-marker-info") ||
        !!target.closest(".cm-lintRange");
      // Map the click to a document line. posAtCoords is documented to return
      // null for coordinates it can't resolve, but its internal block→line
      // resolution can also throw (e.g. on a widget/gap block, or during a
      // transient layout pass right after re-render). Treat both "null" and
      // "threw" as "no line here" rather than crashing the page.
      let pos: number | null;
      try {
        pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
      } catch {
        return;
      }
      if (pos === null) return;
      const line = view.state.doc.lineAt(pos).number;
      if (isMarker) {
        e.preventDefault();
        e.stopPropagation();
        handler(line, e.clientX, e.clientY);
        return;
      }
      // Line-body click: only respond on diagnostic lines, and never when the
      // user just finished selecting a range of text.
      if (!view.state.selection.main.empty) return;
      if (!view.state.field(diagLinesField).has(line)) return;
      e.preventDefault();
      e.stopPropagation();
      handler(line, e.clientX, e.clientY);
    };
    host.addEventListener("click", clickHandler);

    viewRef.current = view;
    return () => {
      // Use the captured `host` (not the ref) so cleanup always releases the
      // exact element that was registered, even if hostRef.current changed.
      host.removeEventListener("click", clickHandler);
      view.destroy();
      viewRef.current = null;
    };
  }, [code, language]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const diags: Diagnostic[] = diagnostics.map((d) => {
      const { from, to } = offsetRange(code, d.line, d.column);
      return {
        from,
        to,
        message: "",
        severity: d.severity ?? "error",
      };
    });
    // Mirror diagnostic line → severity so the hover plugin can light up the
    // right lines without re-reading @codemirror/lint's internal state.
    const lineMap = new Map<number, "error" | "info">();
    for (const d of diagnostics) {
      lineMap.set(d.line, d.severity === "info" ? "info" : "error");
    }
    view.dispatch(setDiagnostics(view.state, diags));
    view.dispatch({ effects: setDiagLines.of(lineMap) });
  }, [diagnostics, code]);

  return <div ref={hostRef} className={className} />;
}
