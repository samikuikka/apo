import type { ReactNode } from "react";
import { color } from "../theme";
import { fontFamilies } from "../fonts";

type CaptionProps = {
  children: ReactNode;
  /** Secondary line under the main statement. */
  sub?: string;
  size?: "hero" | "body";
  align?: "center" | "left";
};

/**
 * The narration line of a beat. Since the videos ship without a voice track,
 * every beat's argument lives here: one sentence, white 400, key words <Em>.
 */
export const Caption = ({ children, sub, size = "body", align = "center" }: CaptionProps) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      alignItems: align === "center" ? "center" : "flex-start",
      gap: 18,
      textAlign: align,
    }}
  >
    <div
      style={{
        fontSize: size === "hero" ? 84 : 52,
        fontWeight: 400,
        lineHeight: 1.25,
        letterSpacing: "-0.01em",
        color: color.foreground,
        maxWidth: 1500,
      }}
    >
      {children}
    </div>
    {sub && (
      <div
        style={{
          fontFamily: fontFamilies.mono,
          fontSize: 26,
          color: color.mutedForeground,
          letterSpacing: "0.04em",
        }}
      >
        {sub}
      </div>
    )}
  </div>
);

/** Emphasis inside a Caption: same size, weight 600. Two weights max per view. */
export const Em = ({ children }: { children: ReactNode }) => (
  <span style={{ fontWeight: 600 }}>{children}</span>
);

/** Small mono eyebrow above a title card, e.g. "apo — 01". */
export const ChapterTag = ({ children }: { children: ReactNode }) => (
  <div
    style={{
      fontFamily: fontFamilies.mono,
      fontSize: 26,
      fontWeight: 400,
      color: color.mutedForeground,
      letterSpacing: "0.3em",
      textTransform: "uppercase",
    }}
  >
    {children}
  </div>
);
