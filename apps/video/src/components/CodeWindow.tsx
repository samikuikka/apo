import type { CSSProperties } from "react";
import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { useAppear } from "../lib/beat";

export type CodeToken = {
  text: string;
  tone?: "plain" | "muted" | "strong" | "string" | "punct" | "add" | "del";
};

/** Shorthand for building CodeWindow lines: t("await", "strong"). */
export const t = (text: string, tone: CodeToken["tone"] = "plain"): CodeToken => ({ text, tone });

const TONE_STYLE: Record<NonNullable<CodeToken["tone"]>, CSSProperties> = {
  plain: { color: color.foreground },
  muted: { color: color.mutedForeground },
  strong: { color: color.foreground, fontWeight: 600 },
  // Syntax highlighting is the one sanctioned multi-hue exception (design.md);
  // strings reuse the success hue dimmed to stay low-chroma.
  string: { color: "oklch(0.65 0.1 155 / 0.85)" },
  punct: { color: color.mutedForeground },
  // Diff lines for the Improve scene: state colors, same exception.
  add: { color: color.success },
  del: { color: color.destructive },
};

/**
 * A code card with a filename tab. Lines are pre-tokenized so the snippets
 * stay readable in source and no highlighter dependency is needed.
 */
export const CodeWindow = ({
  filename,
  lines,
  startFrame = 0,
  per = 4,
  width = 980,
  fontSize = 26,
}: {
  filename: string;
  lines: CodeToken[][];
  startFrame?: number;
  per?: number;
  width?: number;
  fontSize?: number;
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
        fontSize: 20,
        color: color.mutedForeground,
      }}
    >
      {filename}
    </div>
    <div
      style={{
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        fontFamily: fontFamilies.mono,
        fontSize,
        lineHeight: 1.5,
        textAlign: "left",
      }}
    >
      {lines.map((line, index) => (
        <CodeLine key={index} line={line} at={startFrame + index * per} />
      ))}
    </div>
  </div>
);

const CodeLine = ({ line, at }: { line: CodeToken[]; at: number }) => {
  const appear = useAppear(at);
  return (
    <div style={{ ...appear, whiteSpace: "pre" }}>
      {line.map((token, index) => (
        <span key={index} style={TONE_STYLE[token.tone ?? "plain"]}>
          {token.text}
        </span>
      ))}
    </div>
  );
};
