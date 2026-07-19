// react-doctor-disable-next-line react-doctor/prefer-dynamic-import
import { GutterMarker } from "@codemirror/view";

/** A single assertion's verdict to show as a gutter marker on its source line.
 *  Each side's `left`/`right` drives the ✓/✗; the labels are consumed by the
 *  parent's reveal panel (click → show per-side result), not by the viewer. */
export interface LineAssertion {
  /** 1-indexed source line. */
  line: number;
  left: boolean | undefined;
  right: boolean | undefined;
  /** Per-side result label (built from the run's result, not the source).
   *  Consumed by the parent's reveal panel. */
  leftLabel?: string;
  rightLabel?: string;
  /** True when the line has a `t.*` call but no recorded result — the
   *  assertion exists but never ran (e.g. the check short-circuited after
   *  an earlier failure). Shown as a muted empty slot, not a glyph. */
  notEvaluated?: boolean;
}

/** A gutter marker carrying one run's pass state for one assertion line.
 *  `pass === undefined` renders an empty span so the slot width is reserved
 *  (keeps the two markers aligned across rows even when one side didn't run). */
export class CompareMarker extends GutterMarker {
  constructor(
    readonly pass: boolean | undefined,
    readonly side: "A" | "B",
  ) {
    super();
  }
  eq(other: CompareMarker): boolean {
    return this.pass === other.pass && this.side === other.side;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.dataset.side = this.side;
    if (this.pass === undefined) {
      el.style.cssText = "display:inline-block; width:16px; height:16px;";
      return el;
    }
    el.textContent = this.pass ? "✓" : "✗";
    el.style.cssText =
      "display:inline-grid; place-items:center; width:16px; height:16px; border-radius:9999px; font-size:9px; line-height:1; cursor:pointer;";
    if (this.pass) {
      el.style.background = "color-mix(in oklch, var(--success) 15%, transparent)";
      el.style.color = "var(--success)";
    } else {
      el.style.background = "color-mix(in oklch, var(--destructive) 15%, transparent)";
      el.style.color = "var(--destructive)";
    }
    el.setAttribute("aria-label", `Run ${this.side} ${this.pass ? "passed" : "failed"}`);
    return el;
  }
  elementClass = "cm-compare-marker";
}

/** Pure data describing where markers go, without a CodeMirror view. Exported
 *  so the placement logic is unit-testable without rendering CodeMirror (which
 *  is finicky in jsdom — it measures DOM). Returns one entry per line, each
 *  carrying the two markers (Run A + Run B) that line produces. */
export interface MarkerEntry {
  line: number;
  markers: CompareMarker[];
}

export function buildMarkers(assertions: LineAssertion[]): MarkerEntry[] {
  return assertions.map((a) => {
    const markers: CompareMarker[] = [];
    if (a.notEvaluated) {
      markers.push(new CompareMarker(undefined, "A"), new CompareMarker(undefined, "B"));
    } else {
      markers.push(new CompareMarker(a.left, "A"), new CompareMarker(a.right, "B"));
    }
    return { line: a.line, markers };
  });
}
