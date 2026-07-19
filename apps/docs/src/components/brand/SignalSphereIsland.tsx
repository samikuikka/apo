import { useEffect, useMemo, useRef } from "react";
import {
  buildSignalSphereScene,
  DEFAULT_SIGNAL_SPHERE_PALETTE,
  type SignalSphereDot,
  type SignalSpherePalette,
} from "./signal-sphere-scene";
import { useReducedMotion } from "../../lib/use-reduced-motion";

/**
 * SignalSphereIsland — the apo brand mark, as a 2D-canvas React island for
 * the Astro docs (splash hero + Why apo cover). Ported from the dashboard's
 * SignalSphereCanvas; the reduced-motion fallback is an inline hook instead
 * of Framer Motion, so the docs bundle stays lean.
 *
 * Reads --signal-sphere-fg / --signal-sphere-accent (defaults #f4f4f5 / #4ade80,
 * which match the docs theme). Falls back to the static SVG under reduced motion.
 */

export type SignalSpherePreset = "orbit" | "parallax" | "ripple" | "resolve";

type MotionState = {
  spin: number;
  pulse: number;
  rotX: number;
  rotZ: number;
  trailProgress?: number;
  trailDirection?: number;
  bandParallax?: number;
  depthParallax?: number;
  verticalScale?: number;
  disableAccentTrail?: boolean;
  rippleTime?: number;
  resolveProgress?: number;
  rippleSources?: Array<{
    bandIndex: number;
    longitude: number;
    strength: number;
    time: number;
  }>;
};

type SignalSphereIslandProps = {
  size?: number | string;
  className?: string;
  preset?: SignalSpherePreset;
};

function normalizeSize(size: number | string): number {
  if (typeof size === "number") return size;
  const parsed = Number.parseFloat(size);
  return Number.isFinite(parsed) ? parsed : 96;
}

function resolvePalette(element: HTMLElement | null): SignalSpherePalette {
  if (typeof window === "undefined" || !element) {
    return DEFAULT_SIGNAL_SPHERE_PALETTE;
  }

  const styles = getComputedStyle(element);
  const fg = styles.getPropertyValue("--signal-sphere-fg").trim() || "#f4f4f5";
  const accent =
    styles.getPropertyValue("--signal-sphere-accent").trim() || "#4ade80";

  return { fg, accent };
}

function mixColor(foreground: string, accent: string, mix: number): string {
  const fg = parseRgb(foreground);
  const ac = parseRgb(accent);
  if (!fg || !ac) return accent;

  const t = Math.max(0, Math.min(1, mix));
  const r = Math.round(fg[0] * (1 - t) + ac[0] * t);
  const g = Math.round(fg[1] * (1 - t) + ac[1] * t);
  const b = Math.round(fg[2] * (1 - t) + ac[2] * t);
  return `rgb(${r}, ${g}, ${b})`;
}

function parseRgb(color: string): [number, number, number] | null {
  if (color.startsWith("#")) {
    const hex = color.slice(1);
    if (hex.length === 3) {
      return [
        Number.parseInt(hex[0]! + hex[0]!, 16),
        Number.parseInt(hex[1]! + hex[1]!, 16),
        Number.parseInt(hex[2]! + hex[2]!, 16),
      ];
    }
    if (hex.length === 6) {
      return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ];
    }
    return null;
  }

  const match = color.match(/rgba?\(([^)]+)\)/i);
  if (!match) return null;
  const parts = match[1]!.split(",").map((part) => Number.parseFloat(part.trim()));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function SignalSphereIsland({
  size = 96,
  className,
  preset = "orbit",
}: SignalSphereIslandProps) {
  const reducedMotion = useReducedMotion();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rippleSourcesRef = useRef<
    { bandIndex: number; longitude: number; strength: number; createdAt: number }[]
  >([]);
  const numericSize = useMemo(() => normalizeSize(size), [size]);

  useEffect(() => {
    if (reducedMotion) return;

    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    let frameId = 0;
    let disposed = false;
    const sizeValue = numericSize;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = sizeValue * dpr;
    canvas.height = sizeValue * dpr;
    canvas.style.width = `${sizeValue}px`;
    canvas.style.height = `${sizeValue}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);

    let lastSpawn = 0;

    const draw = (timestamp: number) => {
      if (disposed) return;

      if (preset === "ripple" && timestamp - lastSpawn > 5200) {
        lastSpawn = timestamp;
        const bandIndex = Math.floor(Math.random() * 14);
        const longitude = Math.random() * Math.PI * 2;
        const strength = 0.5 + Math.random() * 0.35;
        rippleSourcesRef.current.push({
          bandIndex,
          longitude,
          strength,
          createdAt: timestamp,
        });
      }

      const lifetime = 7;
      rippleSourcesRef.current = rippleSourcesRef.current.filter(
        (source) => (timestamp - source.createdAt) / 1000 < lifetime,
      );

      const palette = resolvePalette(canvas);
      const motion = getMotionState(timestamp, preset);
      const rippleSources =
        motion.rippleSources ??
        rippleSourcesRef.current.map((source) => ({
          bandIndex: source.bandIndex,
          longitude: source.longitude,
          strength: source.strength,
          time: (timestamp - source.createdAt) / 1000,
        }));

      const scene = buildSignalSphereScene({
        spin: motion.spin,
        pulse: motion.pulse,
        trailProgress: motion.trailProgress,
        trailDirection: motion.trailDirection,
        bandParallax: motion.bandParallax,
        depthParallax: motion.depthParallax,
        verticalScale: motion.verticalScale,
        disableAccentTrail: motion.disableAccentTrail,
        rippleSources,
        config: { rotX: motion.rotX, rotZ: motion.rotZ },
      });
      const resolveProgress = motion.resolveProgress;
      const renderedDots =
        resolveProgress != null
          ? scene.dots.map((dot) =>
              resolveDotFromPointCloud(dot, scene.viewBox, resolveProgress),
            )
          : scene.dots;
      const endpointAlpha =
        resolveProgress != null ? getResolveEndpointAlpha(resolveProgress) : 1;

      const scale = sizeValue / scene.viewBox.width;

      context.clearRect(0, 0, sizeValue, sizeValue);
      context.save();
      context.scale(scale, scale);

      context.fillStyle = palette.accent;
      context.globalAlpha = scene.endpoint.glowOpacity * endpointAlpha;
      context.beginPath();
      context.arc(
        scene.endpoint.x,
        scene.endpoint.y,
        scene.endpoint.glowRadius,
        0,
        Math.PI * 2,
      );
      context.fill();

      context.globalAlpha = scene.endpoint.coreOpacity * endpointAlpha;
      context.beginPath();
      context.arc(
        scene.endpoint.x,
        scene.endpoint.y,
        scene.endpoint.radius,
        0,
        Math.PI * 2,
      );
      context.fill();

      for (const dot of renderedDots) {
        context.fillStyle = palette.fg;
        context.globalAlpha = dot.opacity;
        context.beginPath();
        context.arc(dot.x, dot.y, dot.radius, 0, Math.PI * 2);
        context.fill();

        if (dot.overlayTint > 0.02 && dot.overlayOpacity > 0) {
          context.fillStyle = mixColor(palette.fg, palette.accent, dot.overlayTint);
          context.globalAlpha = dot.overlayOpacity;
          context.beginPath();
          context.arc(dot.x, dot.y, dot.overlayRadius, 0, Math.PI * 2);
          context.fill();
        }

        if (dot.rippleTint > 0.02 && dot.rippleOpacity > 0) {
          context.fillStyle = mixColor(palette.fg, "#ef4444", dot.rippleTint);
          context.globalAlpha = dot.rippleOpacity;
          context.beginPath();
          context.arc(dot.x, dot.y, dot.rippleRadius, 0, Math.PI * 2);
          context.fill();
        }
      }

      context.restore();

      frameId = window.requestAnimationFrame(draw);
    };

    draw(0);

    return () => {
      disposed = true;
      window.cancelAnimationFrame(frameId);
    };
  }, [numericSize, preset, reducedMotion]);

  if (reducedMotion) {
    const px = typeof size === "number" ? `${size}px` : size;
    return (
      <img
        src="/brand/signal-sphere-small.svg"
        alt=""
        aria-hidden="true"
        className={className}
        style={{ width: px, height: px, display: "block" }}
      />
    );
  }

  const px = typeof size === "number" ? `${size}px` : size;
  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={className}
      style={{ width: px, height: px, display: "block" }}
    />
  );
}

function getMotionState(
  timestamp: number,
  preset: SignalSpherePreset,
): MotionState {
  if (preset === "parallax") {
    const tiltPhase = timestamp * 0.00048;
    return {
      spin: timestamp * 0.00008,
      pulse: (Math.sin(timestamp * 0.0025) + 1) / 2,
      rotX: 0.24 + Math.cos(timestamp * 0.00042) * 0.006,
      rotZ: Math.sin(tiltPhase) * 0.16,
      trailProgress: (timestamp * 0.000045) % 1,
      trailDirection: 1,
      bandParallax: 0,
      depthParallax: 0,
    };
  }

  if (preset === "ripple") {
    const slowPhase = timestamp * 0.00012;
    const wobble = Math.sin(timestamp * 0.0009) * 0.025;
    return {
      spin: timestamp * 0.00006 + slowPhase,
      pulse: (Math.sin(timestamp * 0.002) + 1) / 2,
      rotX: 0.24 + wobble * 0.3,
      rotZ: 0.16 + Math.sin(timestamp * 0.00045) * 0.012,
      trailProgress: (timestamp * 0.00012) % 1,
      trailDirection: 1,
      rippleTime: timestamp * 0.001,
    };
  }

  if (preset === "resolve") {
    const cycle = (timestamp * 0.000034) % 1;
    return {
      spin: timestamp * 0.00005,
      pulse: (Math.sin(timestamp * 0.0022) + 1) / 2,
      rotX: 0.24 + Math.cos(timestamp * 0.00028) * 0.004,
      rotZ: 0.16 + Math.sin(timestamp * 0.00024) * 0.01,
      trailProgress: (timestamp * 0.000032) % 1,
      trailDirection: 1,
      resolveProgress: getResolveCycleProgress(cycle),
    };
  }

  // orbit (default)
  const wobble = Math.sin(timestamp * 0.0012) * 0.035;
  return {
    spin: timestamp * 0.00035,
    pulse: (Math.sin(timestamp * 0.0035) + 1) / 2,
    rotX: 0.24 + wobble * 0.45,
    rotZ: 0.16 + Math.cos(timestamp * 0.001) * 0.018,
    trailProgress: (timestamp * 0.00012) % 1,
    trailDirection: 1,
  };
}

function resolveDotFromPointCloud(
  dot: SignalSphereDot,
  viewBox: { width: number; height: number },
  progress: number,
): SignalSphereDot {
  const clamped = clamp(progress, 0, 1);
  const origin = getPointCloudOrigin(dot.id, dot, viewBox);
  const structureProgress = easeInOutCubic(clamped);
  const accentProgress = easeInOutCubic(clamp((clamped - 0.68) / 0.32, 0, 1));

  return {
    ...dot,
    x: lerp(origin.x, dot.x, structureProgress),
    y: lerp(origin.y, dot.y, structureProgress),
    radius: lerp(origin.radius, dot.radius, structureProgress),
    opacity: lerp(origin.opacity, dot.opacity, structureProgress),
    overlayOpacity: dot.overlayOpacity * accentProgress,
    overlayRadius: lerp(origin.radius * 1.08, dot.overlayRadius, accentProgress),
  };
}

function getResolveEndpointAlpha(progress: number): number {
  return easeInOutCubic(clamp((progress - 0.78) / 0.22, 0, 1));
}

function getPointCloudOrigin(
  id: string,
  dot: SignalSphereDot,
  viewBox: { width: number; height: number },
): { x: number; y: number; radius: number; opacity: number } {
  const centerX = viewBox.width / 2;
  const centerY = viewBox.height / 2;
  const targetAngle = Math.atan2(dot.y - centerY, dot.x - centerX);
  const targetDistance = Math.hypot(dot.x - centerX, dot.y - centerY);
  const driftAngle = targetAngle * 0.42 + (hashUnit(id, 0) - 0.5) * 2.8;
  const driftRadius = 14 + Math.pow(hashUnit(id, 1), 0.58) * 46;
  const swirlX = Math.cos(targetAngle * 2.3 + hashUnit(id, 2) * (Math.PI * 2)) * 16;
  const swirlY = Math.sin(targetAngle * 1.7 + hashUnit(id, 3) * (Math.PI * 2)) * 12;
  const lobePull =
    Math.sin(targetAngle * 3 + hashUnit(id, 4) * (Math.PI * 2)) * 18;
  const centerBias = 0.38 + Math.min(targetDistance / 86, 1) * 0.42;
  const driftX = Math.cos(driftAngle) * driftRadius * centerBias;
  const driftY = Math.sin(driftAngle) * driftRadius * (0.72 + hashUnit(id, 5) * 0.5);
  const xNoise = (hashUnit(id, 6) - 0.5) * 18;
  const yNoise = (hashUnit(id, 7) - 0.5) * 14;

  return {
    x: centerX + driftX + swirlX + xNoise + Math.cos(targetAngle) * lobePull * 0.35,
    y: centerY + driftY + swirlY + yNoise + Math.sin(targetAngle * 0.85) * lobePull,
    radius: 0.28 + hashUnit(id, 8) * 0.86,
    opacity: 0.08 + hashUnit(id, 9) * 0.2,
  };
}

function getResolveCycleProgress(cycle: number): number {
  if (cycle < 0.52) return easeOutCubic(cycle / 0.52);
  if (cycle < 0.84) return 1;
  return 1 - easeInCubic((cycle - 0.84) / 0.16);
}

function hashUnit(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  const salted = `${value}:${salt}`;

  for (let index = 0; index < salted.length; index++) {
    hash ^= salted.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  hash ^= hash >>> 16;
  hash = Math.imul(hash, 2246822507);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 3266489909);
  hash ^= hash >>> 16;

  return (hash >>> 0) / 4294967295;
}

function lerp(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function easeInOutCubic(value: number): number {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function easeInCubic(value: number): number {
  return value * value * value;
}

function easeOutCubic(value: number): number {
  return 1 - Math.pow(1 - value, 3);
}
