import { describe, it, expect } from "vitest";

import { buildMarkers, type LineAssertion } from "./compare-markers";

/** Tests for the compare code viewer's gutter marker placement.
 *
 * The placement logic (which line gets which markers, and the per-side pass
 * state) is the load-bearing part — it determines whether a click reveals the
 * right run's result and whether the ✓/✗ glyphs are correct. We test it as a
 * pure function (`buildMarkers`) rather than rendering CodeMirror, which is
 * finicky in jsdom (it measures DOM via layout). The rendering itself is
 * CodeMirror's job.
 *
 * Imported from a separate .ts module rather than CompareCodeViewer.tsx
 * because the vitest JSX transform is currently broken in this repo — any
 * .tsx import fails to parse. The pure .ts module sidesteps that. */
describe("buildMarkers", () => {
  it("produces two markers (Run A + Run B) per assertion line", () => {
    const assertions: LineAssertion[] = [
      { line: 1, left: false, right: true },
      { line: 3, left: true, right: false },
    ];
    const result = buildMarkers(assertions);
    expect(result).toHaveLength(2);
    expect(result[0].markers).toHaveLength(2);
    expect(result[1].markers).toHaveLength(2);
  });

  it("carries the correct pass state and side label per marker", () => {
    const assertions: LineAssertion[] = [{ line: 1, left: false, right: true }];
    const [{ markers }] = buildMarkers(assertions);
    const [a, b] = markers;
    expect(a.side).toBe("A");
    expect(a.pass).toBe(false);
    expect(b.side).toBe("B");
    expect(b.pass).toBe(true);
  });

  it("preserves undefined pass as undefined (slot reserved, no glyph)", () => {
    // One side didn't record a result — its marker stays undefined so the
    // slot width is reserved but no ✓/✗ renders.
    const assertions: LineAssertion[] = [{ line: 2, left: false, right: undefined }];
    const [{ markers }] = buildMarkers(assertions);
    expect(markers[0].pass).toBe(false);
    expect(markers[1].pass).toBeUndefined();
  });

  it("renders both sides as undefined when the assertion never ran", () => {
    const assertions: LineAssertion[] = [
      { line: 4, left: undefined, right: undefined, notEvaluated: true },
    ];
    const [{ markers }] = buildMarkers(assertions);
    expect(markers[0].pass).toBeUndefined();
    expect(markers[0].side).toBe("A");
    expect(markers[1].pass).toBeUndefined();
    expect(markers[1].side).toBe("B");
  });

  it("returns one entry per assertion, in input order", () => {
    const assertions: LineAssertion[] = [
      { line: 5, left: true, right: true },
      { line: 2, left: false, right: false },
      { line: 9, left: undefined, right: true },
    ];
    const result = buildMarkers(assertions);
    expect(result.map((r) => r.line)).toEqual([5, 2, 9]);
  });

  it("handles an empty assertion list", () => {
    expect(buildMarkers([])).toEqual([]);
  });
});
