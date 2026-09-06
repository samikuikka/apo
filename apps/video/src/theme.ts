/**
 * Design tokens for the video series, ported from docs/design.md — the
 * dashboard identity: dark, monochrome, sharp corners (radius 0), color
 * reserved for state (pass/fail/error). Videos render at 1080p so every
 * size here is a video-scale size, not a UI size.
 */
export const color = {
  background: "oklch(0 0 0)",
  foreground: "oklch(1 0 0)",
  card: "oklch(0.18 0 0)",
  muted: "oklch(0.2 0 0)",
  mutedForeground: "oklch(0.6 0 0)",
  faintForeground: "oklch(0.6 0 0 / 0.55)",
  border: "oklch(0.28 0 0)",
  borderFaint: "oklch(0.28 0 0 / 0.5)",
  borderStrong: "oklch(0.65 0 0)",
  // State colors only. A colored element means pass, fail, or error — nothing
  // else. Brighter than the dashboard tokens: they use the docs concept-demo
  // values, which stay legible on pure black at video scale.
  success: "oklch(0.78 0.19 155)",
  destructive: "oklch(0.8 0.16 25)",
  warning: "oklch(0.7 0.14 70)",
} as const;

export const video = {
  width: 1920,
  height: 1080,
  fps: 30,
} as const;

/** Page padding for every beat. 4px base grid, 96 for the frame. */
export const stagePadding = 96;
