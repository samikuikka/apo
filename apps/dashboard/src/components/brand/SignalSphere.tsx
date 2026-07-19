"use client";

import Image from "next/image";

type SignalSphereProps = {
  size?: number | string;
  className?: string;
  title?: string;
  decorative?: boolean;
};

function normalizeSize(size: number | string): number {
  if (typeof size === "number") return size;
  const parsed = Number.parseFloat(size);
  return Number.isFinite(parsed) ? parsed : 48;
}

/**
 * SignalSphere — static SVG logo component.
 *
 * Picks a purpose-built asset by render size:
 * - below 48px → ``signal-sphere-small.png`` — a pre-rasterized high-res
 *   bitmap of the sparse (fewer, larger dots) variant. SVG circles alias to
 *   mud at certain sub-pixel scales (notably 24/32px); a crisp raster that
 *   the browser downscales stays smooth and consistent at every UI size;
 * - 48px and up → the canonical dense sphere (SVG).
 *
 * The big animated canvas (``SignalSphereCanvas``) is unaffected and keeps
 * using the canonical geometry at large sizes.
 */
export function SignalSphere({
  size = 48,
  className,
  title,
  decorative = true,
}: SignalSphereProps) {
  const numericSize = normalizeSize(size);
  const isSmall = numericSize <= 48;
  const src = isSmall
    ? "/brand/signal-sphere-small.png"
    : "/brand/signal-sphere.svg";

  return (
    <Image
      src={src}
      alt={decorative ? "" : (title ?? "Signal Sphere")}
      aria-hidden={decorative ? "true" : undefined}
      width={numericSize}
      height={numericSize}
      className={className}
      style={{
        width: typeof size === "number" ? `${size}px` : size,
        height: typeof size === "number" ? `${size}px` : size,
        display: "block",
      }}
      data-signal-sphere={isSmall ? "small" : "canonical"}
      unoptimized={src.endsWith(".svg")}
    />
  );
}
