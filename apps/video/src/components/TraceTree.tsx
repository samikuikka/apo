import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { useAppear } from "../lib/beat";

export type TraceLine = {
  /** Tree glyphs included by the caller ("├ ", "└ "), indent via depth. */
  text: string;
  depth: number;
  tone?: "ok" | "fail" | "muted";
};

/**
 * The trace tree a failed run opens into: every call with its inputs and
 * outputs, indented like the product's trace view. The red line is the lie —
 * the claim no source supports.
 */
export const TraceTree = ({
  lines,
  startFrame = 0,
  per = 10,
  width = 720,
}: {
  lines: TraceLine[];
  startFrame?: number;
  per?: number;
  width?: number;
}) => (
  <div
    style={{
      width,
      padding: "26px 30px",
      backgroundColor: color.background,
      border: `1.5px solid ${color.border}`,
      display: "flex",
      flexDirection: "column",
      gap: 12,
      fontFamily: fontFamilies.mono,
      fontSize: 24,
      textAlign: "left",
    }}
  >
    {lines.map((line, index) => (
      <TraceTreeRow key={index} line={line} at={startFrame + index * per} />
    ))}
  </div>
);

const TONE_COLOR = {
  ok: color.foreground,
  fail: color.destructive,
  muted: color.mutedForeground,
} as const;

const TraceTreeRow = ({ line, at }: { line: TraceLine; at: number }) => {
  const appear = useAppear(at);
  return (
    <div
      style={{
        ...appear,
        paddingLeft: line.depth * 32,
        color: TONE_COLOR[line.tone ?? "ok"],
        whiteSpace: "pre",
      }}
    >
      {line.text}
    </div>
  );
};
