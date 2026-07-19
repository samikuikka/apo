# Signal Sphere Brand System

## Concept

The Signal Sphere is a dotted spherical field of runtime signals with one visible green verdict trail terminating at a bright endpoint.

## Architecture

The brand system has one shared geometry model and two presentation paths:

- `signal-sphere-scene.ts`: shared math and scene generation
- committed SVG/PNG assets: static artwork for simple surfaces
- `SignalSphereCanvas.tsx`: live canvas renderer for in-app animation

This keeps the logo math in one place while letting the product use richer motion than an `<img>` can support.

## Asset

`signal-sphere.svg` is the single canonical static asset in this directory.

Use it when the logo is just branding and does not need to react or animate deeply.

## React Components

### `SignalSphere`

Static image-backed component for ordinary UI surfaces.

```tsx
import { SignalSphere } from "@/components/brand/SignalSphere";

<SignalSphere size={24} decorative />
<SignalSphere size={48} />
<SignalSphere size={96} />
<SignalSphere size={192} />
```

Props:

- `size` (number | string, default `48`)
- `className`
- `title`
- `decorative`

### `AnimatedSignalSphere`

Live canvas-based renderer for the application.

```tsx
import { AnimatedSignalSphere } from "@/components/brand/AnimatedSignalSphere";

<AnimatedSignalSphere size={96} />
```

This is the path for richer motion such as spinning rows, moving trails, endpoint pulsing, and more advanced future animation.

The directory contains five committed assets:

- `signal-sphere.svg` — canonical dense sphere (large sizes).
- `signal-sphere-small.svg` / `.png` — sparse variant for <48px UI.
- `signal-sphere-favicon.png` — the browser-tab icon (see below).
- `signal-sphere-favicon-32.png` — a 32px tab-optimized master.

## Favicon

The favicon is **not** the full Signal Sphere. A field of ~110 faint dots
collapses into a gray-on-black smudge when the browser downscales it to the
16px of a tab — inherently un-resolvable at that scale.

Instead the favicon is the **signal endpoint**: the bright green verdict
glyph (the dot the whole sphere points at) with a layered glow halo, on the
dark rounded tile shared with the rest of the brand. It is the most
distinctive "apo" glyph and, being a single high-contrast mark, the only
thing that stays legible at 16px. A dedicated 32px master is authored at
target size (rather than downscaled) for a crisper core dot in the most
common tab size.

## Preview

View the static and animated versions at:

```text
http://localhost:3000/brand-preview
```
