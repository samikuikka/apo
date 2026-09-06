import { Img, staticFile } from "remotion";
import { color } from "../theme";
import { fontFamilies } from "../fonts";

type WordmarkProps = {
  /** Height of the sphere in px; the wordmark scales with it. */
  size?: number;
  tagline?: boolean;
  /** Sphere alone — allowed at title sizes where it is the hero, not a smudge. */
  logoOnly?: boolean;
};

/**
 * The apo lockup: signal sphere + lowercase wordmark, matching the dashboard
 * BrandMark. The sphere alone reads as a smudge at UI sizes, so it never
 * ships alone below title scale.
 */
export const Wordmark = ({ size = 72, tagline = false, logoOnly = false }: WordmarkProps) => (
  <div style={{ display: "flex", alignItems: "center", gap: logoOnly ? 0 : size * 0.18 }}>
    <Img src={staticFile("brand/signal-sphere.svg")} style={{ width: size, height: size }} />
    {!logoOnly && (
    <div style={{ display: "flex", flexDirection: "column", gap: size * 0.06 }}>
      <span
        style={{
          fontSize: size * 0.56,
          fontWeight: 600,
          letterSpacing: "-0.02em",
          lineHeight: 1,
          color: color.foreground,
        }}
      >
        apo
      </span>
      {tagline && (
        <span
          style={{
            fontFamily: fontFamilies.mono,
            fontSize: size * 0.2,
            color: color.mutedForeground,
            letterSpacing: "0.08em",
          }}
        >
          executable definitions of done
        </span>
      )}
      </div>
    )}
  </div>
);
