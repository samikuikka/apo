import { useCurrentFrame, useVideoConfig } from "remotion";
import { buildSignalSphereScene } from "../lib/signal-sphere-scene";

// The canonical palette fallbacks from the dashboard scene — #f4f4f5 dots,
// #4ade80 accent — so the video sphere matches the site's mark exactly.
const FG = "#f4f4f5";
const ACCENT = "#4ade80";

/**
 * The signal sphere, ported — not approximated. This renders the dashboard's
 * own `signal-sphere-scene.ts` (copied verbatim into lib/) driven by its
 * default "orbit" motion preset, so the title sphere is frame-for-frame the
 * same mark customers see animating on the site: the same perspective
 * projection, band structure, depth shading, sweeping green accent trail,
 * and pulsing right-edge endpoint.
 */
export const SignalSphereAnimated = ({ size }: { size: number }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const timestamp = (frame / fps) * 1000;

  // Motion state, orbit preset — from SignalSphereCanvas. The trail sweep
  // uses the slowest in-family preset rate (parallax's 0.000045) with a
  // phase chosen so the accent rides the front arc for the whole title;
  // on the site the phase is whatever the page-load timestamp gives.
  const wobble = Math.sin(timestamp * 0.0012) * 0.035;
  const motion = {
    spin: timestamp * 0.00035,
    pulse: (Math.sin(timestamp * 0.0035) + 1) / 2,
    rotX: 0.24 + wobble * 0.45,
    rotZ: 0.16 + Math.cos(timestamp * 0.001) * 0.018,
    trailProgress: (timestamp * 0.000045 + 0.59) % 1,
    trailDirection: 1,
  };

  const scene = buildSignalSphereScene({
    spin: motion.spin,
    pulse: motion.pulse,
    trailProgress: motion.trailProgress,
    trailDirection: motion.trailDirection,
    config: { rotX: motion.rotX, rotZ: motion.rotZ },
  });

  const f = (n: number) => n.toFixed(2);

  return (
    <svg viewBox="0 0 200 200" width={size} height={size}>
      <circle
        cx={f(scene.endpoint.x)}
        cy={f(scene.endpoint.y)}
        r={f(scene.endpoint.glowRadius)}
        fill={ACCENT}
        opacity={f(scene.endpoint.glowOpacity)}
      />
      <circle
        cx={f(scene.endpoint.x)}
        cy={f(scene.endpoint.y)}
        r={f(scene.endpoint.radius)}
        fill={ACCENT}
        opacity={f(scene.endpoint.coreOpacity)}
      />
      {scene.dots.map((dot) => {
        const base = (
          <circle
            key={dot.id}
            cx={f(dot.x)}
            cy={f(dot.y)}
            r={f(dot.radius)}
            fill={FG}
            opacity={f(dot.opacity)}
          />
        );
        if (dot.overlayTint <= 0.02 || dot.overlayOpacity <= 0) return base;
        return (
          <g key={dot.id}>
            {base}
            <circle
              cx={f(dot.x)}
              cy={f(dot.y)}
              r={f(dot.overlayRadius)}
              fill={`color-mix(in srgb, ${ACCENT} ${f(dot.overlayTint * 100)}%, ${FG})`}
              opacity={f(dot.overlayOpacity)}
            />
          </g>
        );
      })}
    </svg>
  );
};
