import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";

const FADE_FRAMES = 8;

/**
 * The standard beat entrance/exit: quick fade + rise on the way in, plain
 * fade on the way out. Sequences tile the composition, so every beat calls
 * this with its own duration.
 */
export const useBeatStyle = (durationInFrames: number): CSSProperties => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(
    frame,
    [0, FADE_FRAMES, durationInFrames - FADE_FRAMES, durationInFrames],
    [0, 1, 1, 0],
    { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
  );
  const settle = spring({ frame, fps, config: { damping: 200 } });
  const translateY = interpolate(settle, [0, 1], [28, 0]);
  return { opacity, transform: `translateY(${translateY.toFixed(1)}px)` };
};

type BeatProps = {
  durationInFrames: number;
  children: ReactNode;
  style?: CSSProperties;
};

/** A full-bleed beat. Use inside a <Sequence> with the same duration. */
export const Beat = ({ durationInFrames, children, style }: BeatProps) => {
  const beatStyle = useBeatStyle(durationInFrames);
  return <AbsoluteFill style={{ ...beatStyle, ...style }}>{children}</AbsoluteFill>;
};

/**
 * Entrance for staggered items (test rows, chat messages, code lines).
 * Returns a style that is invisible before `at`, then fades and rises.
 */
export const useAppear = (at: number): CSSProperties => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [at, at + FADE_FRAMES], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const translateY = interpolate(frame, [at, at + FADE_FRAMES + 4], [14, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return { opacity, transform: `translateY(${translateY.toFixed(1)}px)` };
};

/** Stamp-in for verdict badges: scale from slightly oversized with a spring. */
export const useStamp = (at: number): CSSProperties => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (frame < at) return { opacity: 0 };
  const pop = spring({ frame: frame - at, fps, config: { damping: 14, mass: 0.6 } });
  const scale = interpolate(pop, [0, 1], [1.35, 1]);
  return { transform: `scale(${scale.toFixed(3)})` };
};

/**
 * Typewriter for terminal lines: reveals `text` char by char from
 * `startFrame`, with a blinking cursor until the text is done.
 */
export const useTyped = (text: string, startFrame: number, framesPerChar = 1.2) => {
  const frame = useCurrentFrame();
  const chars = Math.floor(Math.max(0, frame - startFrame) / framesPerChar);
  const done = chars >= text.length;
  return {
    shown: text.slice(0, Math.min(chars, text.length)),
    done,
    cursorOn: Math.floor(frame / 15) % 2 === 0,
  };
};

/** Plain 0→1 ramp over `duration` frames from `at`, clamped both sides. */
export const ramp = (frame: number, at: number, duration: number) =>
  interpolate(frame, [at, at + duration], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

/**
 * Springy entrance for map elements (nodes, center mark): fades in fast and
 * settles from slightly undersized. Returns the scale as a number so callers
 * can combine it with their own transforms.
 */
export const useSpringIn = (at: number): { opacity: number; scale: number } => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = ramp(frame, at, 8);
  const settle = spring({ frame: Math.max(0, frame - at), fps, config: { damping: 200 } });
  return { opacity, scale: 0.85 + 0.15 * settle };
};

/**
 * Slide transition for scene slides. Called INSIDE a scene's Sequence, so
 * the frame is sequence-local: the scene enters from the right over ~10
 * frames, then slides left and fades over `overlap` frames starting at
 * `nextLocal` (the local frame at which the next scene begins). Scenes are
 * Sequences whose ranges overlap by `overlap` frames, so outgoing and
 * incoming slides crossfade.
 */
export const useSlide = (nextLocal: number | undefined, overlap: number): CSSProperties => {
  const frame = useCurrentFrame();
  const enter = ramp(frame, 0, 10);
  const exit = nextLocal !== undefined ? ramp(frame, nextLocal, overlap) : 0;
  const opacity = enter * (1 - exit);
  const x = 48 * (1 - enter) - 48 * exit;
  return { opacity, transform: `translateX(${x.toFixed(1)}px)` };
};
