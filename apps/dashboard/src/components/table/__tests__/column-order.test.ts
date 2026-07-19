import { describe, it, expect } from "vitest";

import { moveColumn, pinGroupOf, canMoveWithinPinGroup } from "../column-order";

describe("moveColumn", () => {
  it("swaps a column one position to the left", () => {
    expect(moveColumn(["a", "b", "c"], "b", "left")).toEqual(["b", "a", "c"]);
  });

  it("swaps a column one position to the right", () => {
    expect(moveColumn(["a", "b", "c"], "b", "right")).toEqual(["a", "c", "b"]);
  });

  it("moves the first column leftward to a no-op", () => {
    const order = ["a", "b", "c"];
    expect(moveColumn(order, "a", "left")).toBe(order);
  });

  it("moves the last column rightward to a no-op", () => {
    const order = ["a", "b", "c"];
    expect(moveColumn(order, "c", "right")).toBe(order);
  });

  it("returns the original array when the column is unknown", () => {
    const order = ["a", "b", "c"];
    expect(moveColumn(order, "z", "left")).toBe(order);
    expect(moveColumn(order, "z", "right")).toBe(order);
  });

  it("does not mutate the input array", () => {
    const order = ["a", "b", "c"];
    const result = moveColumn(order, "c", "left");
    expect(result).toEqual(["a", "c", "b"]);
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("returns the original array reference when no swap occurs", () => {
    const order = ["a", "b", "c"];
    expect(moveColumn(order, "a", "left")).toBe(order);
  });

  it("handles a single-column array", () => {
    const order = ["a"];
    expect(moveColumn(order, "a", "left")).toBe(order);
    expect(moveColumn(order, "a", "right")).toBe(order);
  });

  it("handles an empty array", () => {
    const order: string[] = [];
    expect(moveColumn(order, "a", "left")).toBe(order);
  });

  it("moves a column at the end leftward", () => {
    expect(moveColumn(["a", "b", "c"], "c", "left")).toEqual(["a", "c", "b"]);
  });

  it("moves a column at the start rightward", () => {
    expect(moveColumn(["a", "b", "c"], "a", "right")).toEqual(["b", "a", "c"]);
  });
});

describe("pinGroupOf", () => {
  it("maps 'left' pin to the left group", () => {
    expect(pinGroupOf("left")).toBe("left");
  });

  it("maps 'right' pin to the right group", () => {
    expect(pinGroupOf("right")).toBe("right");
  });

  it("maps false (unpinned) to the center group", () => {
    expect(pinGroupOf(false)).toBe("center");
  });
});

describe("canMoveWithinPinGroup", () => {
  const groups = ["left", "left", "center", "center", "right"] as const;

  it("allows moving within the same group", () => {
    expect(canMoveWithinPinGroup(groups, 0, "right")).toBe(true);
    expect(canMoveWithinPinGroup(groups, 1, "left")).toBe(true);
    expect(canMoveWithinPinGroup(groups, 2, "right")).toBe(true);
    expect(canMoveWithinPinGroup(groups, 3, "left")).toBe(true);
  });

  it("blocks moving left out of bounds", () => {
    expect(canMoveWithinPinGroup(groups, 0, "left")).toBe(false);
  });

  it("blocks moving right out of bounds", () => {
    expect(canMoveWithinPinGroup(groups, 4, "right")).toBe(false);
  });

  it("blocks crossing the left-to-center boundary", () => {
    expect(canMoveWithinPinGroup(groups, 1, "right")).toBe(false);
  });

  it("blocks crossing the center-to-left boundary", () => {
    expect(canMoveWithinPinGroup(groups, 2, "left")).toBe(false);
  });

  it("blocks crossing the center-to-right boundary", () => {
    expect(canMoveWithinPinGroup(groups, 3, "right")).toBe(false);
  });

  it("blocks crossing the right-to-center boundary", () => {
    expect(canMoveWithinPinGroup(groups, 4, "left")).toBe(false);
  });

  it("allows free movement in an all-center group", () => {
    const allCenter = ["center", "center", "center"] as const;
    expect(canMoveWithinPinGroup(allCenter, 0, "right")).toBe(true);
    expect(canMoveWithinPinGroup(allCenter, 1, "left")).toBe(true);
    expect(canMoveWithinPinGroup(allCenter, 1, "right")).toBe(true);
    expect(canMoveWithinPinGroup(allCenter, 2, "left")).toBe(true);
  });

  it("handles a single-column group", () => {
    expect(canMoveWithinPinGroup(["center"], 0, "left")).toBe(false);
    expect(canMoveWithinPinGroup(["center"], 0, "right")).toBe(false);
  });

  it("handles an empty group array", () => {
    expect(canMoveWithinPinGroup([], 0, "left")).toBe(false);
    expect(canMoveWithinPinGroup([], 0, "right")).toBe(false);
  });
});
