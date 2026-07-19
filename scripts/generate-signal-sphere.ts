/**
 * generate-signal-sphere.ts
 *
 * Deterministic SVG generator for the Signal Sphere logo assets.
 * Run: pnpm brand:generate
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import {
  buildSignalSphereScene,
  renderSignalSphereSvg,
  type SignalSphereConfig,
} from "../apps/dashboard/src/components/brand/signal-sphere-scene";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, "..", "apps", "dashboard", "public", "brand");

const count = (svg: string) => (svg.match(/<circle/g) || []).length;

// Wrapped in an async IIFE — the PNG rasterization (sharp) is async, and
// tsx transpiles this script to CJS which forbids top-level await.
void (async () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  // Canonical asset — the dense ~540-dot sphere used at large sizes (≥48px)
  // and as the source geometry for the animated canvas.
  const canonicalScene = buildSignalSphereScene();
  const canonicalSvg = renderSignalSphereSvg(canonicalScene);
  writeFileSync(join(OUTPUT_DIR, "signal-sphere.svg"), canonicalSvg, "utf-8");

  // Small variant — purpose-built for render sizes below 48px (the topbar,
  // favicons, dense UI). Same 200×200 viewBox, but far fewer bands/points and
  // much larger, more opaque dots so each dot survives the downscale instead
  // of collapsing to sub-pixel mush. Higher minOpacity keeps the back
  // hemisphere visible so the sphere silhouette still reads at 20px.
  const SMALL_CONFIG: Partial<SignalSphereConfig> = {
    bands: 7,
    equatorPoints: 16,
    dotRadius: 3.6,
    endpointRadius: 5,
    accentBand: 3,
    minOpacity: 0.22,
    maxOpacity: 1.0,
  };
  const smallScene = buildSignalSphereScene({ config: SMALL_CONFIG });
  const smallSvg = renderSignalSphereSvg(smallScene);
  writeFileSync(join(OUTPUT_DIR, "signal-sphere-small.svg"), smallSvg, "utf-8");

  // Pre-rasterize the small variant to a high-res PNG. Below 48px the logo is
  // shown at fixed UI sizes (16–48px); rendering SVG circles directly at those
  // sizes hits bad sub-pixel alignments (e.g. 24/32px alias to mud). A crisp
  // raster that the browser downscales is smooth and consistent at every size.
  // 256px covers the whole <48 tier with clean 2–8× downscaling on retina.
  const SMALL_PNG_SIZE = 256;
  const smallPng = await sharp(Buffer.from(smallSvg))
    .resize(SMALL_PNG_SIZE, SMALL_PNG_SIZE, { fit: "contain" })
    .png()
    .toBuffer();
  writeFileSync(join(OUTPUT_DIR, "signal-sphere-small.png"), smallPng);

  // Favicon — the "signal endpoint" glyph: the brand's bright green verdict
  // endpoint (the dot the whole sphere points at) with a layered glow halo,
  // on the same dark rounded tile used across the brand.
  //
  // Why not the full sphere? A field of ~110 faint dots collapses into a
  // gray-on-black smudge when the browser downscales it to the 16px of a
  // tab. A single high-contrast mark is the only thing that reads at that
  // size, and the endpoint is the most distinctive "apo" glyph — it's the
  // punchline of the whole sphere. Built in SVG with a radialGradient glow
  // so it stays crisp and soft-edged at every scale, then rasterized.
  const FAV_ACCENT = "#4ade80";
  const FAV_TILE = "#0a0a0a";
  const faviconSvg = (size: number): Buffer => {
    const radius = size / 2;
    // Three concentric layers, center of the tile:
    //   1. soft radial glow fading out to transparent (the "halo")
    //   2. a mid-strength solid disc
    //   3. a bright crisp core
    // Radii are fractions of the tile so the proportions survive at 16px.
    const glowR = Math.round(radius * 0.62);
    const midR = Math.round(radius * 0.26);
    const coreR = Math.round(radius * 0.16);
    return Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">` +
        `<defs><radialGradient id="g" cx="50%" cy="50%" r="50%">` +
        `<stop offset="0%" stop-color="${FAV_ACCENT}" stop-opacity="0.55"/>` +
        `<stop offset="45%" stop-color="${FAV_ACCENT}" stop-opacity="0.18"/>` +
        `<stop offset="100%" stop-color="${FAV_ACCENT}" stop-opacity="0"/>` +
        `</radialGradient></defs>` +
        `<rect width="${size}" height="${size}" rx="${Math.round(size * 0.2)}" fill="${FAV_TILE}"/>` +
        `<circle cx="${radius}" cy="${radius}" r="${glowR}" fill="url(#g)"/>` +
        `<circle cx="${radius}" cy="${radius}" r="${midR}" fill="${FAV_ACCENT}" opacity="0.85"/>` +
        `<circle cx="${radius}" cy="${radius}" r="${coreR}" fill="${FAV_ACCENT}"/>` +
        `</svg>`,
    );
  };

  const FAV_SIZE = 512;
  const favicon = await sharp(faviconSvg(FAV_SIZE)).png().toBuffer();
  writeFileSync(join(OUTPUT_DIR, "signal-sphere-favicon.png"), favicon);

  // A 32px master, rasterized at target size rather than downscaled from
  // 512px. Downscaling a soft glow through many power-of-two steps keeps
  // the halo but the crisp core dot sharpens better when authored at the
  // exact tab size. Served as the first entry in layout's icon list so
  // browsers preferring a sized match pick the pixel-exact one.
  const FAV_32 = 32;
  const favicon32 = await sharp(faviconSvg(FAV_32)).png().toBuffer();
  writeFileSync(join(OUTPUT_DIR, "signal-sphere-favicon-32.png"), favicon32);

  console.log(`signal-sphere.svg       (${count(canonicalSvg)} circles, ${canonicalSvg.length} bytes)`);
  console.log(`signal-sphere-small.svg (${count(smallSvg)} circles, ${smallSvg.length} bytes)`);
  console.log(`signal-sphere-small.png (${SMALL_PNG_SIZE}×${SMALL_PNG_SIZE}, ${smallPng.length} bytes)`);
  console.log(`signal-sphere-favicon.png (${FAV_SIZE}×${FAV_SIZE}, ${favicon.length} bytes)`);
  console.log(`signal-sphere-favicon-32.png (${FAV_32}×${FAV_32}, ${favicon32.length} bytes)`);
  console.log(`\nDone — assets written to ${OUTPUT_DIR}`);
})();
