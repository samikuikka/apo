/**
 * Auto-generated Open Graph image for the docs landing page (/).
 *
 * Rendered at build time by satori (element tree -> SVG) + @resvg/resvg-js
 * (SVG -> PNG), using the same brand tokens as apps/docs/src/styles/custom.css
 * and the same signal sphere as the Starlight header. Referenced from
 * src/pages/index.astro via og:image / twitter:image meta tags so sharing "/"
 * shows a branded card instead of a text-only link.
 *
 * Output: /og-landing.png (1200x630, the standard OG aspect ratio).
 *
 * Astro page endpoints must be .ts (not .tsx), so the satori element tree is
 * built with a minimal hyperscript `h()` helper instead of JSX. satori accepts
 * plain objects shaped like { type, props: { style, children } }.
 */
import type { APIRoute } from "astro";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import satori, { type SatoriOptions } from "satori";
import type { ReactNode } from "react";
import { Resvg } from "@resvg/resvg-js";
import {
	buildSignalSphereScene,
	renderSignalSphereSvg,
} from "../components/brand/signal-sphere-scene";

const WIDTH = 1200;
const HEIGHT = 630;

// Mirror apps/docs/src/styles/custom.css. Keep in sync if the palette moves.
const COLORS = {
	black: "#000000",
	white: "#ffffff",
	gray1: "#f4f4f5", // headings
	gray2: "#d4d4d4", // body
	gray3: "#a3a3a3", // secondary
	gray5: "#404040", // borders
	gray6: "#252525", // card fills
	accent: "#4ade80",
} as const;

const SITE_URL = "docs.test-apo.online";
const WORDMARK = "apo";
const TAGLINE = "Define what your agent must be capable of.";
const SUB =
	"Executable specifications. Real harness runs. Pass or fail with evidence.";

// --- Minimal hyperscript: builds the element-shaped objects satori consumes. ---

type SatoriElement = {
	type: string;
	props: Record<string, unknown> & {
		style?: Record<string, unknown>;
		children?: SatoriChild | SatoriChild[];
	};
};
type SatoriChild = SatoriElement | string;

function h(
	type: string,
	props: (Record<string, unknown> & { style?: Record<string, unknown> }) | null,
	...children: SatoriChild[]
): SatoriElement {
	return { type, props: { ...props, children } };
}

// --- Signal sphere: the canonical static asset, rendered by resvg ---

/**
 * Renders the Signal Sphere through the project's own renderer, the same
 * `renderSignalSphereSvg(buildSignalSphereScene())` that produces the committed
 * `signal-sphere.svg` brand asset (see apps/dashboard/public/brand/README.md).
 * No hand-rolled SVG: the OG card shows the exact canonical logo.
 *
 * Rasterized with resvg (not sharp) because sharp's librsvg mangles the faint
 * endpoint/trail opacities; resvg composites them correctly, including the
 * `color-mix()` fills the renderer emits for the accent trail.
 *
 * Palette is passed as concrete hex so the output never depends on CSS
 * variables the standalone rasterizer can't resolve.
 */
async function loadSphereDataUrl(): Promise<string> {
	const svg = renderSignalSphereSvg(buildSignalSphereScene(), {
		fg: COLORS.gray1,
		accent: COLORS.accent,
	});
	// Render at 4x the 200px viewBox for a crisp downscale to 420px in satori.
	const png = new Resvg(svg, { fitTo: { mode: "width", value: 800 } }).render()
		.asPng();
	return `data:image/png;base64,${png.toString("base64")}`;
}

const FONTS_DIR = join(process.cwd(), "src/assets/fonts");
const WEIGHTS = [400, 500, 600, 700] as const;

async function loadFonts(): Promise<SatoriOptions["fonts"]> {
	// satori's opentype.js fork cannot parse variable fonts (parseFvarAxis
	// throws on the `fvar` table), so each weight is a static instance
	// instantiated from the variable Inter via fonttools. See scripts/README.
	const buffers = await Promise.all(
		WEIGHTS.map((w) => readFile(join(FONTS_DIR, `Inter-${w}.ttf`))),
	);
	return WEIGHTS.map((w, i) => ({
		name: "Inter",
		data: buffers[i]!,
		weight: w,
		style: "normal" as const,
	}));
}

export const GET: APIRoute = async () => {
	const [fonts, sphereSrc] = await Promise.all([loadFonts(), loadSphereDataUrl()]);

	const tree = h(
		"div",
		{
			style: {
				display: "flex",
				width: "100%",
				height: "100%",
				backgroundColor: COLORS.black,
				padding: "80px",
				position: "relative",
				fontFamily: "Inter",
				color: COLORS.white,
			},
		},
		// Soft accent glow behind the sphere, adds depth on pure black.
		h("div", {
			style: {
				display: "flex",
				position: "absolute",
				right: "-120px",
				top: "-120px",
				width: "760px",
				height: "760px",
				borderRadius: "50%",
				background:
					"radial-gradient(circle, rgba(74,222,128,0.20) 0%, rgba(74,222,128,0) 62%)",
			},
		}),
		// Left column, badge, wordmark, rule, tagline, sub, URL.
		h(
			"div",
			{
				style: {
					display: "flex",
					flexDirection: "column",
					justifyContent: "center",
					flexGrow: 1,
					maxWidth: "680px",
				},
			},
			h(
				"div",
				{
					style: {
						display: "flex",
						alignSelf: "flex-start",
						padding: "7px 16px",
						borderRadius: "999px",
						backgroundColor: COLORS.gray6,
						border: `1px solid ${COLORS.gray5}`,
						color: COLORS.gray3,
						fontSize: "18px",
						fontWeight: 600,
						letterSpacing: "2px",
						textTransform: "uppercase",
					},
				},
				"Public Alpha",
			),
			h(
				"div",
				{
					style: {
						display: "flex",
						marginTop: "26px",
						fontSize: "168px",
						fontWeight: 700,
						lineHeight: 1,
						letterSpacing: "-8px",
						color: COLORS.white,
					},
				},
				WORDMARK,
			),
			h("div", {
				style: {
					display: "flex",
					marginTop: "14px",
					width: "128px",
					height: "5px",
					borderRadius: "3px",
					backgroundColor: COLORS.accent,
				},
			}),
			h(
				"div",
				{
					style: {
						display: "flex",
						marginTop: "30px",
						fontSize: "40px",
						fontWeight: 600,
						lineHeight: 1.18,
						color: COLORS.gray2,
					},
				},
				TAGLINE,
			),
			h(
				"div",
				{
					style: {
						display: "flex",
						marginTop: "18px",
						maxWidth: "560px",
						fontSize: "24px",
						fontWeight: 400,
						lineHeight: 1.4,
						color: COLORS.gray3,
					},
				},
				SUB,
			),
			h(
				"div",
				{
					style: {
						display: "flex",
						marginTop: "38px",
						fontSize: "22px",
						fontWeight: 500,
						color: COLORS.accent,
					},
				},
				SITE_URL,
			),
		),
		// Right column, signal sphere.
		h(
			"div",
			{
				style: {
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
					width: "420px",
				},
			},
			h("img", {
				src: sphereSrc,
				style: {
					display: "flex",
					width: "420px",
					height: "420px",
				},
			}),
		),
	);

	const svg = await satori(tree as unknown as ReactNode, {
		width: WIDTH,
		height: HEIGHT,
		fonts,
	});
	const png = new Resvg(svg).render().asPng();

	return new Response(new Uint8Array(png), {
		headers: {
			"Content-Type": "image/png",
			"Cache-Control": "public, max-age=86400",
		},
	});
};
