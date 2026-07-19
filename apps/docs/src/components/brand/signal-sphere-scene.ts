const TAU = Math.PI * 2;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

export interface SignalSphereConfig {
  bands: number;
  equatorPoints: number;
  radius: number;
  cx: number;
  cy: number;
  rotX: number;
  rotZ: number;
  perspective: number;
  minOpacity: number;
  maxOpacity: number;
  dotRadius: number;
  accentBand: number;
  endpointRadius: number;
}

export interface SignalSpherePalette {
  fg: string;
  accent: string;
}

export interface SignalSphereDot {
  id: string;
  bandId: string;
  bandIndex: number;
  x: number;
  y: number;
  depth: number;
  radius: number;
  opacity: number;
  overlayTint: number;
  overlayOpacity: number;
  overlayRadius: number;
  rippleTint: number;
  rippleOpacity: number;
  rippleRadius: number;
}

export interface SignalSphereBand {
  id: string;
  index: number;
  dotIds: string[];
}

export interface SignalSphereEndpoint {
  x: number;
  y: number;
  radius: number;
  glowRadius: number;
  glowOpacity: number;
  coreOpacity: number;
  frontness: number;
}

export interface SignalSphereScene {
  viewBox: {
    width: number;
    height: number;
  };
  bands: SignalSphereBand[];
  dots: SignalSphereDot[];
  endpoint: SignalSphereEndpoint;
}

export interface BuildSignalSphereSceneOptions {
  spin?: number;
  pulse?: number;
  trailProgress?: number;
  trailDirection?: number;
  bandParallax?: number;
  depthParallax?: number;
  verticalScale?: number;
  disableAccentTrail?: boolean;
  rippleSources?: RippleSource[];
  config?: Partial<SignalSphereConfig>;
}

export interface RippleSource {
  bandIndex: number;
  longitude: number;
  strength: number;
  time: number;
}

interface Projection {
  px: number;
  py: number;
  z: number;
  frontness: number;
}

interface ScenePoint {
  id: string;
  bandId: string;
  bandIndex: number;
  pointIndex: number;
  longitude: number;
  x: number;
  y: number;
  depth: number;
  radius: number;
  opacity: number;
  frontness: number;
  overlayTint: number;
  overlayOpacity: number;
  overlayRadius: number;
  rippleTint: number;
  rippleOpacity: number;
  rippleRadius: number;
}

const CANONICAL_SIGNAL_SPHERE_CONFIG: SignalSphereConfig = {
  bands: 14,
  equatorPoints: 48,
  radius: 82,
  cx: 100,
  cy: 100,
  rotX: 0.24,
  rotZ: 0.16,
  perspective: 800,
  minOpacity: 0.02,
  maxOpacity: 0.9,
  dotRadius: 0.9,
  accentBand: 8,
  endpointRadius: 3,
};

export const DEFAULT_SIGNAL_SPHERE_PALETTE: SignalSpherePalette = {
  fg: "var(--signal-sphere-fg, #f4f4f5)",
  accent: "var(--signal-sphere-accent, #4ade80)",
};

export function buildSignalSphereScene(
  options: BuildSignalSphereSceneOptions = {},
): SignalSphereScene {
  const spin = options.spin ?? 0;
  const pulse = clamp(options.pulse ?? 0, 0, 1);
  const config: SignalSphereConfig = {
    ...CANONICAL_SIGNAL_SPHERE_CONFIG,
    ...options.config,
  };

  const points = generateScenePoints(config, spin, {
    bandParallax: options.bandParallax,
    depthParallax: options.depthParallax,
    verticalScale: options.verticalScale,
  });
  const accentHead = options.disableAccentTrail
    ? null
    : applyAccentTrail(points, config, pulse, {
        trailProgress: options.trailProgress,
        trailDirection: options.trailDirection,
      });
  if (options.rippleSources && options.rippleSources.length > 0) {
    applyRipples(points, config, options.rippleSources);
  }

  const endpointProjection = accentHead
    ? { px: accentHead.x, py: accentHead.y, z: accentHead.depth, frontness: accentHead.frontness }
    : findRightEdgeEndpoint(config, spin, options.verticalScale ?? 1);
  const bands = buildBands(points, config.bands);
  const dots = points
    .toSorted((a, b) => b.depth - a.depth)
    .map((point) => ({
      id: point.id,
      bandId: point.bandId,
      bandIndex: point.bandIndex,
      x: point.x,
      y: point.y,
      depth: point.depth,
      radius: point.radius,
      opacity: point.opacity,
      overlayTint: point.overlayTint,
      overlayOpacity: point.overlayOpacity,
      overlayRadius: point.overlayRadius,
      rippleTint: point.rippleTint,
      rippleOpacity: point.rippleOpacity,
      rippleRadius: point.rippleRadius,
    }));

  return {
    viewBox: {
      width: config.cx * 2,
      height: config.cy * 2,
    },
    bands,
    dots,
    endpoint: {
      x: endpointProjection.px,
      y: endpointProjection.py,
      radius: config.endpointRadius * (1 + pulse * 0.08),
      glowRadius: config.endpointRadius * (1.4 + pulse * 0.14),
      glowOpacity: (0.14 + pulse * 0.1) * (0.2 + endpointProjection.frontness * 0.8),
      coreOpacity: (0.35 + pulse * 0.18) * (0.15 + endpointProjection.frontness * 0.85),
      frontness: endpointProjection.frontness,
    },
  };
}

function generateScenePoints(
  config: SignalSphereConfig,
  spin: number,
  motion: {
    bandParallax?: number;
    depthParallax?: number;
    verticalScale?: number;
  },
): ScenePoint[] {
  const points: ScenePoint[] = [];
  const bandParallax = motion.bandParallax ?? 0;
  const depthParallax = motion.depthParallax ?? 0;
  const verticalScale = motion.verticalScale ?? 1;

  for (let bandIndex = 0; bandIndex < config.bands; bandIndex++) {
    const latitude = getBandLatitude(bandIndex, config);
    const pointCount = Math.max(
      14,
      Math.round(config.equatorPoints * Math.cos(latitude)),
    );
    const phase = (bandIndex * GOLDEN_ANGLE) % TAU;
    const bandId = `band-${bandIndex}`;

    for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
      const latitudeBias = -Math.sin(latitude);
      const equatorWeight = Math.pow(Math.cos(latitude), 0.65);
      const bandOffset = bandParallax * latitudeBias * equatorWeight;
      const depthOffset = depthParallax * latitudeBias * equatorWeight;
      const longitude =
        (pointIndex / pointCount) * TAU + phase + spin + bandOffset + depthOffset;
      const projected = projectPoint(latitude, longitude, config, verticalScale);
      const opacity =
        config.minOpacity
        + Math.pow(projected.frontness, 2.4)
          * (config.maxOpacity - config.minOpacity);
      const radius =
        config.dotRadius
        * (0.55 + Math.pow(projected.frontness, 1.6) * 0.75);

      points.push({
        id: `${bandId}-dot-${pointIndex}`,
        bandId,
        bandIndex,
        pointIndex,
        longitude,
        x: projected.px,
        y: projected.py,
        depth: projected.z,
        radius,
        opacity,
        frontness: projected.frontness,
        overlayTint: 0,
        overlayOpacity: 0,
        overlayRadius: radius,
        rippleTint: 0,
        rippleOpacity: 0,
        rippleRadius: radius,
      });
    }
  }

  return points;
}

function applyAccentTrail(
  points: ScenePoint[],
  config: SignalSphereConfig,
  pulse: number,
  motion: {
    trailProgress?: number;
    trailDirection?: number;
  },
): ScenePoint | null {
  const accentBandPoints = points
    .filter((point) => point.bandIndex === config.accentBand)
    .toSorted((a, b) => a.pointIndex - b.pointIndex);

  if (accentBandPoints.length === 0) return null;

  const trailProgress = motion.trailProgress;
  if (trailProgress == null) {
    const frontArc = accentBandPoints
      .filter((point) => point.frontness >= 0.5)
      .toSorted((a, b) => b.x - a.x);
    if (frontArc.length === 0) return accentBandPoints[0]!;
    const rightmostX = frontArc[0]!.x;
    const leftmostX = frontArc[frontArc.length - 1]!.x;
    const arcWidth = Math.max(1, rightmostX - leftmostX);
    const rightmostRadius = frontArc[0]!.radius;
    const minTrailTint = 0.18;
    const pulseBoost = 0.92 + pulse * 0.08;

    for (const point of frontArc) {
      const progress = clamp((point.x - leftmostX) / arcWidth, 0, 1);
      const eased = Math.pow(progress, 0.72);
      const accentMix = minTrailTint + (1 - minTrailTint) * eased;

      point.overlayTint = accentMix;
      point.overlayOpacity =
        Math.min((0.26 + 0.64 * Math.pow(progress, 0.7)) * pulseBoost, 0.95);
      point.overlayRadius =
        rightmostRadius * (0.72 + 0.38 * Math.pow(progress, 0.7));
    }

    return frontArc[0]!;
  }

  const count = accentBandPoints.length;
  const headIndex = clamp(trailProgress, 0, 1) * count;
  const direction = (motion.trailDirection ?? 1) >= 0 ? 1 : -1;
  const tailLength = Math.max(6, count * 0.34);
  const headPoint =
    accentBandPoints[((Math.round(headIndex) % count) + count) % count] ?? accentBandPoints[0]!;
  const pulseBoost = 0.94 + pulse * 0.1;
  const minTrailTint = 0.16;

  for (const [index, point] of accentBandPoints.entries()) {
    const forwardDistance = mod(index - headIndex, count);
    const backwardDistance = mod(headIndex - index, count);
    const alongTrail = direction > 0 ? backwardDistance : forwardDistance;
    const aroundHead = Math.min(forwardDistance, backwardDistance);
    const headStrength = clamp(1 - aroundHead / 1.25, 0, 1);
    const tailStrength =
      alongTrail >= 0 ? clamp(1 - alongTrail / tailLength, 0, 1) : 0;
    const combinedStrength = Math.max(headStrength, Math.pow(tailStrength, 0.78));

    if (combinedStrength <= 0.01) {
      point.overlayTint = 0;
      point.overlayOpacity = 0;
      point.overlayRadius = point.radius;
      continue;
    }

    const accentMix = minTrailTint + (1 - minTrailTint) * combinedStrength;
    point.overlayTint = accentMix;
    point.overlayOpacity =
      Math.min(
        (0.18 + 0.74 * combinedStrength)
        * pulseBoost
        * (0.3 + point.frontness * 0.7),
        0.95,
      );
    point.overlayRadius =
      point.radius * (0.82 + 0.48 * combinedStrength);
  }

  return headPoint;
}

function applyRipples(
  points: ScenePoint[],
  config: SignalSphereConfig,
  sources: RippleSource[],
): void {
  const rippleRadius = 2.4;
  const rippleSpeed = 1.1;
  const rippleFreq = 2.6;
  const maxDistance = Math.PI * 0.7;
  const frontThreshold = 0.28;
  const baseTint = 0.55;

  for (const point of points) {
    if (point.frontness < frontThreshold) continue;

    let strongest = 0;
    for (const source of sources) {
      const sourceLat = getBandLatitude(source.bandIndex, config);
      const pointLat = getBandLatitude(point.bandIndex, config);
      const lonDelta = point.longitude - source.longitude;
      const cosDist =
        Math.sin(sourceLat) * Math.sin(pointLat)
        + Math.cos(sourceLat) * Math.cos(pointLat) * Math.cos(lonDelta);
      const dist = Math.acos(clamp(cosDist, -1, 1));
      if (dist > maxDistance) continue;

      const outward = dist * rippleFreq - source.time * rippleSpeed;
      const envelope = Math.exp(-dist / rippleRadius);
      const wave = Math.max(0, Math.sin(outward)) * envelope * source.strength;
      strongest = Math.max(strongest, wave);
    }

    if (strongest <= 0.02) continue;

    const boost = Math.min(strongest, 0.75);
    point.rippleTint = Math.max(point.rippleTint, baseTint + boost * 0.45);
    point.rippleOpacity = Math.min(
      0.95,
      Math.max(point.rippleOpacity, point.opacity * boost * 1.8 + boost * 0.22),
    );
    point.rippleRadius = Math.max(
      point.rippleRadius,
      point.radius * (1 + boost * 0.45),
    );
  }
}

function buildBands(points: ScenePoint[], bandCount: number): SignalSphereBand[] {
  const dotsByBand = new Map<number, string[]>();
  for (const point of points) {
    const existing = dotsByBand.get(point.bandIndex);
    if (existing) {
      existing.push(point.id);
    } else {
      dotsByBand.set(point.bandIndex, [point.id]);
    }
  }

  return Array.from({ length: bandCount }, (_, index) => ({
    id: `band-${index}`,
    index,
    dotIds: dotsByBand.get(index) ?? [],
  }));
}

function getBandLatitude(
  bandIndex: number,
  config: SignalSphereConfig,
): number {
  const yRatio = -0.97 + (1.94 * bandIndex) / (config.bands - 1);
  return Math.asin(yRatio);
}

function findRightEdgeEndpoint(
  config: SignalSphereConfig,
  spin: number,
  verticalScale: number,
): Projection {
  const latitude = getBandLatitude(config.accentBand, config);

  let bestProjection = projectPoint(latitude, spin, config, verticalScale);

  for (let index = 0; index < 720; index++) {
    const longitude = (index / 720) * TAU + spin;
    const projection = projectPoint(latitude, longitude, config, verticalScale);
    if (projection.frontness > 0.4 && projection.px > bestProjection.px) {
      bestProjection = projection;
    }
  }

  return bestProjection;
}

function projectPoint(
  latitude: number,
  longitude: number,
  config: SignalSphereConfig,
  verticalScale: number,
): Projection {
  const { radius, cx, cy, rotX, rotZ, perspective } = config;
  const cosLat = Math.cos(latitude);

  const x3 = radius * cosLat * Math.cos(longitude);
  const y3 = radius * Math.sin(latitude) * verticalScale;
  const z3 = radius * cosLat * Math.sin(longitude);

  const y1 = y3 * Math.cos(rotX) - z3 * Math.sin(rotX);
  const z1 = y3 * Math.sin(rotX) + z3 * Math.cos(rotX);

  const x2 = x3 * Math.cos(rotZ) - y1 * Math.sin(rotZ);
  const y2 = x3 * Math.sin(rotZ) + y1 * Math.cos(rotZ);

  const scale = perspective / (perspective + z1);
  const frontness = clamp((radius - z1) / (2 * radius), 0, 1);

  return {
    px: cx + x2 * scale,
    py: cy + y2 * scale,
    z: z1,
    frontness,
  };
}

function mod(value: number, base: number): number {
  return ((value % base) + base) % base;
}
