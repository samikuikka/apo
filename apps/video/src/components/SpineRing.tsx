import { Img, staticFile, interpolate, useCurrentFrame } from "remotion";
import { color } from "../theme";
import { fontFamilies } from "../fonts";
import { ramp, useSpringIn } from "../lib/beat";

export type SpineVerdict = "pending" | "fail" | "pass";

type SpineRingProps = {
  size?: number;
  /** Exactly four nodes, clockwise from the top. */
  nodes: [string, string, string, string];
  /** Token origin for the current phase (its previous node). */
  fromIndex: number;
  /** The node this phase is about — the token's destination. */
  activeIndex: number;
  /** 0–1 travel progress, computed by the parent from the global frame. */
  travelProgress: number;
  /** Global frame the token arrived — anchors the dwell pulse. */
  dwellStart: number;
  /** Verdict node state — the red/green thread of the story. */
  verdict?: SpineVerdict;
  runLabel?: string;
  /** Global frame the map starts assembling (nodes stagger in after it). */
  revealAt?: number;
  tokenVisible: boolean;
};

/**
 * The loop as the red thread of the video: an always-visible map whose token
 * walks node to node as the phases advance. Mounted ONCE at the composition
 * root (never inside a phase Sequence) so it never re-mounts or flickers —
 * the parent drives position, verdict color, and run label from the global
 * frame, and only the scenes beside it transition.
 */
export const SpineRing = ({
  size = 430,
  nodes,
  fromIndex,
  activeIndex,
  travelProgress,
  dwellStart,
  verdict = "pending",
  runLabel,
  revealAt,
  tokenVisible,
}: SpineRingProps) => {
  const frame = useCurrentFrame();
  const radius = size / 2 - 14;
  const revealing = revealAt !== undefined;
  const centerSpring = useSpringIn(revealing ? revealAt + 8 : 0);

  // Token angle: from `fromIndex` to `activeIndex`, wrapping past the top
  // (adds a lap) when the story crosses from node 4 back to node 1.
  const lapWrap = activeIndex < fromIndex ? 360 : 0;
  const fromDeg = -90 + fromIndex * 90;
  const toDeg = -90 + activeIndex * 90 + lapWrap;
  const tokenDeg = fromDeg + (toDeg - fromDeg) * travelProgress;
  const tokenRad = (tokenDeg * Math.PI) / 180;
  // Gentle dwell pulse once the token has arrived.
  const pulse =
    travelProgress >= 1 ? 1 + 0.12 * Math.sin(((frame - dwellStart) / 28) * Math.PI) : 1;

  return (
    <div style={{ position: "relative", width: size, height: size }}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        {/* The ring is four directed arcs — shaft and arrowhead — one per
            gap between the node boxes, so the clockwise flow reads as real
            arrows. During the build they draw themselves in sequence. */}
        {[0, 1, 2, 3].map((index) => (
          <ArcArrow
            key={index}
            size={size}
            radius={radius}
            index={index}
            drawAt={revealAt !== undefined ? revealAt + 22 + index * 13 : 0}
          />
        ))}
      </svg>

      {tokenVisible &&
        (() => {
          const x = size / 2 + radius * Math.cos(tokenRad);
          const y = size / 2 + radius * Math.sin(tokenRad);
          return (
            <div
              style={{
                position: "absolute",
                left: x,
                top: y,
                width: 28,
                height: 28,
                borderRadius: "50%",
                background: color.foreground,
                border: `6px solid ${color.background}`,
                transform: `translate(-50%, -50%) scale(${pulse.toFixed(3)})`,
                boxShadow: "0 0 14px rgba(255,255,255,0.35)",
              }}
            />
          );
        })()}

      {nodes.map((label, index) => (
        <SpineNode
          key={label}
          label={label}
          step={index + 1}
          size={size}
          radius={radius}
          index={index}
          active={index === activeIndex && tokenVisible}
          verdict={index === 1 ? verdict : undefined}
          appearAt={revealAt !== undefined ? revealAt + index * 6 : 0}
        />
      ))}

      <div
        style={{
          ...centerSpring,
          position: "absolute",
          inset: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          textAlign: "center",
        }}
      >
        <Img src={staticFile("brand/signal-sphere.svg")} style={{ width: 96, height: 96 }} />
        {runLabel && (
          <div style={{ fontFamily: fontFamilies.mono, fontSize: 24, color: color.mutedForeground }}>
            {runLabel}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * One directed arc of the ring: a curved shaft from node `index` to the
 * next node, ending in a solid arrowhead aimed at that node's box. Gaps
 * are sized to each node's angular footprint so shafts never hide under
 * the boxes — a wide box (top/bottom) takes a bigger bite than a tall one.
 * During the map build the arc draws itself (dashoffset animation) and the
 * arrowhead lands as the shaft completes.
 */
const ArcArrow = ({
  size,
  radius,
  index,
  drawAt,
}: {
  size: number;
  radius: number;
  index: number;
  /** Global frame this arc starts drawing at. */
  drawAt: number;
}) => {
  const frame = useCurrentFrame();
  const polar = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    return {
      x: size / 2 + radius * Math.cos(r),
      y: size / 2 + radius * Math.sin(r),
    };
  };
  // Half-angle each node's box subtends on the circle, plus margin.
  const halfAngleOf = (node: number) => {
    const passedHorizontally = node === 0 || node === 2;
    const halfExtent = passedHorizontally ? 110 : 60;
    return (Math.asin(Math.min(1, halfExtent / radius)) * 180) / Math.PI;
  };
  const next = (index + 1) % 4;
  const fromDeg = -90 + index * 90 + halfAngleOf(index);
  const toDeg = -90 + next * 90 - halfAngleOf(next);
  // The last arc crosses the 0°/360° seam — wrap its span to positive, or
  // the dash length goes negative and the browser paints the whole arc.
  let spanDeg = toDeg - fromDeg;
  if (spanDeg <= 0) spanDeg += 360;
  const p1 = polar(fromDeg);
  const p2 = polar(toDeg);
  // Self-drawing stroke: reveal the path length over drawFrames.
  const drawFrames = 22;
  const progress = ramp(frame, drawAt, drawFrames);
  const arcLength = (spanDeg * Math.PI) / 180 * radius;
  const dashArray = `${arcLength.toFixed(1)} ${(arcLength * 2).toFixed(1)}`;
  // Arrowhead at the arc's end, pointed along the clockwise tangent; it
  // lands just before the shaft finishes drawing.
  const tangent = ((toDeg + 90) * Math.PI) / 180;
  const radial = (toDeg * Math.PI) / 180;
  const u = { x: Math.cos(tangent), y: Math.sin(tangent) };
  const v = { x: Math.cos(radial), y: Math.sin(radial) };
  const tip = { x: p2.x + u.x * 10, y: p2.y + u.y * 10 };
  const back = { x: p2.x - u.x * 4, y: p2.y - u.y * 4 };
  const cornerA = { x: back.x + v.x * 10, y: back.y + v.y * 10 };
  const cornerB = { x: back.x - v.x * 10, y: back.y - v.y * 10 };
  const f = (n: number) => n.toFixed(1);
  return (
    <g>
      <path
        d={`M ${f(p1.x)} ${f(p1.y)} A ${radius} ${radius} 0 0 1 ${f(p2.x)} ${f(p2.y)}`}
        fill="none"
        stroke={color.mutedForeground}
        strokeWidth={3.5}
        strokeDasharray={dashArray}
        strokeDashoffset={(arcLength * (1 - progress)).toFixed(1)}
      />
      <polygon
        points={`${f(tip.x)},${f(tip.y)} ${f(cornerA.x)},${f(cornerA.y)} ${f(cornerB.x)},${f(cornerB.y)}`}
        fill={color.mutedForeground}
        opacity={interpolate(progress, [0.8, 0.95], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        })}
      />
    </g>
  );
};

const SpineNode = ({
  label,
  step,
  size,
  radius,
  index,
  active,
  verdict,
  appearAt,
}: {
  label: string;
  step: number;
  size: number;
  radius: number;
  index: number;
  active: boolean;
  /** The verdict node's landed state — it says FAIL/PASS in state color. */
  verdict?: SpineVerdict;
  appearAt: number;
}) => {
  const appear = useSpringIn(appearAt);
  const deg = -90 + index * 90;
  const rad = (deg * Math.PI) / 180;
  // Boxes hold one constant size — active state is color only, so the
  // arrows always meet the boxes exactly (like the docs ring).
  const verdictLanded = verdict === "fail" || verdict === "pass";
  // Resting borders stay clearly visible (borderStrong); the active or
  // landed-verdict box takes its accent color.
  const accent = verdictLanded
    ? verdict === "fail"
      ? color.destructive
      : color.success
    : active
      ? color.foreground
      : color.borderStrong;
  const text = verdictLanded
    ? accent
    : active
      ? color.foreground
      : color.mutedForeground;
  return (
    <div
      style={{
        opacity: appear.opacity,
        position: "absolute",
        left: size / 2 + radius * Math.cos(rad),
        top: size / 2 + radius * Math.sin(rad),
        transform: `translate(-50%, -50%) scale(${appear.scale.toFixed(3)})`,
        minWidth: 200,
        padding: "14px 22px",
        borderWidth: 2,
        borderStyle: "solid",
        // The current step reads at a glance: bright border, elevated fill,
        // full-white text — the loudest box on the ring. A landed verdict
        // keeps its state color and says so.
        borderColor: accent,
        backgroundColor: active ? color.card : color.background,
        color: text,
        boxShadow: active ? "0 0 18px rgba(255,255,255,0.12)" : undefined,
        fontFamily: fontFamilies.mono,
        fontSize: 27,
        fontWeight: 600,
        textAlign: "center",
        lineHeight: 1.25,
      }}
    >
      <div style={{ fontSize: 17, fontWeight: 400, color: color.mutedForeground, letterSpacing: "0.2em" }}>
        {String(step).padStart(2, "0")}
      </div>
      {verdictLanded ? (verdict === "fail" ? "FAIL" : "PASS") : label}
    </div>
  );
};
