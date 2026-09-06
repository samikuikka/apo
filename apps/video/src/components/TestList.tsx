import type { CSSProperties } from "react";
import { useCurrentFrame } from "remotion";
import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { useAppear } from "../lib/beat";

export type TestState = "pass" | "fail" | "wait";

export type TestRow = {
  name: string;
  /** code = deterministic check, judge = LLM-backed judgment. Same shape. */
  kind: "code" | "judge";
  state: TestState;
  /** Frame this row resolves at (flips from wait to its verdict). */
  resolvesAt?: number;
};

const GLYPH: Record<TestState, { mark: string; color: string }> = {
  pass: { mark: "✓", color: color.success },
  fail: { mark: "✗", color: color.destructive },
  wait: { mark: "·", color: color.mutedForeground },
};

/**
 * The test breakdown of a run: one row per test, deterministic and judged
 * side by side — "a test is a test" made visible. Rows appear staggered and
 * resolve at their own frame so a run's verdict can land last.
 */
export const TestList = ({
  rows,
  startFrame = 0,
  per = 12,
  width = 660,
}: {
  rows: TestRow[];
  startFrame?: number;
  per?: number;
  width?: number;
}) => (
  <div
    style={{
      width,
      backgroundColor: color.card,
      borderWidth: 1,
      borderStyle: "solid",
      borderColor: color.border,
    }}
  >
    {rows.map((row, index) => {
      const at = startFrame + index * per;
      return <TestRowLine key={row.name} row={row} at={at} />;
    })}
  </div>
);

const TestRowLine = ({ row, at }: { row: TestRow; at: number }) => {
  const appear = useAppear(at);
  const frame = useCurrentFrame();
  // A row shows "wait" until its resolve frame, then its real state.
  const state: TestState =
    row.resolvesAt !== undefined && frame < row.resolvesAt ? "wait" : row.state;
  const glyph = GLYPH[state];
  const rowStyle: CSSProperties = {
    ...appear,
    display: "flex",
    alignItems: "center",
    gap: 18,
    padding: "18px 24px",
    borderTopWidth: at > 0 ? 1 : 0,
    borderTopStyle: "solid",
    borderTopColor: color.borderFaint,
    fontFamily: fontFamilies.mono,
  };
  return (
    <div style={rowStyle}>
      <span style={{ color: glyph.color, fontSize: 28, width: 28 }}>{glyph.mark}</span>
      <span style={{ fontSize: 26, color: color.foreground }}>{row.name}</span>
      <span
        style={{
          marginLeft: "auto",
          fontSize: 19,
          letterSpacing: "0.18em",
          color: color.mutedForeground,
        }}
      >
        {row.kind === "judge" ? "JUDGE" : "CODE"}
      </span>
    </div>
  );
};
