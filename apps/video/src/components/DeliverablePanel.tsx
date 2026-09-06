import type { CSSProperties } from "react";
import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { useAppear } from "../lib/beat";

export type DeliverableLine = {
  text: string;
  tone: "ok" | "missing" | "muted";
};

/**
 * The artifact panel: the structured deliverable the tests actually assert
 * on. Missing entries render struck-through in destructive red — the thing
 * the fluent chat above it was hiding.
 */
export const DeliverablePanel = ({
  filename,
  lines,
  startFrame = 0,
  per = 10,
  width = 620,
}: {
  filename: string;
  lines: DeliverableLine[];
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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 20px",
        borderBottom: `1px solid ${color.borderFaint}`,
        fontFamily: fontFamilies.mono,
        fontSize: 19,
        letterSpacing: "0.18em",
        color: color.mutedForeground,
      }}
    >
      <span>DELIVERABLE</span>
      <span style={{ letterSpacing: 0, color: color.foreground }}>{filename}</span>
    </div>
    <div style={{ display: "flex", flexDirection: "column", padding: "20px 24px", gap: 8 }}>
      {lines.map((line, index) => (
        <DeliverableLineRow key={index} line={line} at={startFrame + index * per} />
      ))}
    </div>
  </div>
);

const TONE_COLOR = {
  ok: color.foreground,
  missing: color.destructive,
  muted: color.mutedForeground,
} as const;

const DeliverableLineRow = ({ line, at }: { line: DeliverableLine; at: number }) => {
  const appear = useAppear(at);
  const style: CSSProperties = {
    ...appear,
    display: "flex",
    alignItems: "baseline",
    gap: 14,
    fontFamily: fontFamilies.mono,
    fontSize: 25,
    color: TONE_COLOR[line.tone],
    textDecoration: line.tone === "missing" ? "line-through" : "none",
    textDecorationThickness: 1.5,
  };
  return (
    <div style={style}>
      {line.tone === "missing" && <span style={{ fontSize: 20 }}>✗</span>}
      <span>{line.text}</span>
      {line.tone === "missing" && (
        <span style={{ fontSize: 19, textDecoration: "none", letterSpacing: "0.12em" }}>
          MISSING
        </span>
      )}
    </div>
  );
};
