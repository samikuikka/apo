import { describe, it, expect } from "vitest";
import { heatFraction, heatColor, sortedMetric } from "../heatmap";

describe("heatFraction", () => {
  it("returns 0 for an empty dataset", () => {
    expect(heatFraction(5, [])).toBe(0);
  });

  it("returns 0 (neutral) for a uniform dataset", () => {
    expect(heatFraction(12, [12, 12, 12])).toBe(0);
  });

  it("ranks a value within the dataset relative to p2..p98", () => {
    const sorted = [10, 11, 12, 13, 15];
    // min -> ~0 (green), max -> ~1 (red)
    expect(heatFraction(10, sorted)).toBeCloseTo(0, 1);
    expect(heatFraction(15, sorted)).toBeCloseTo(1, 0);
    // middle values land between
    const mid = heatFraction(12, sorted);
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.8);
  });

  it("clamps outliers beyond p98 to 1", () => {
    expect(heatFraction(1000, [10, 11, 12, 13, 15])).toBe(1);
  });
});

describe("heatColor", () => {
  it("is green at 0 and red at 1", () => {
    expect(heatColor(0)).toMatch(/hsl\(140/);
    expect(heatColor(1)).toMatch(/hsl\(0 /);
  });

  it("clamps outside [0,1]", () => {
    expect(heatColor(-1)).toBe(heatColor(0));
    expect(heatColor(2)).toBe(heatColor(1));
  });
});

describe("sortedMetric", () => {
  it("memoizes by rows reference + key", () => {
    const rows = [{ original: { v: 3 } }, { original: { v: 1 } }, { original: { v: 2 } }];
    const a = sortedMetric(rows, "v", (r) => r.original.v);
    const b = sortedMetric(rows, "v", (r) => r.original.v);
    expect(a).toEqual([1, 2, 3]);
    expect(b).toBe(a); // same cached array
  });

  it("drops zero / non-finite values", () => {
    const rows = [{ original: { v: 0 } }, { original: { v: 2 } }, { original: { v: NaN } }];
    expect(sortedMetric(rows, "v", (r) => r.original.v)).toEqual([2]);
  });
});
