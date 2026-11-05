/**
 * CapabilityShowcase — root island of the landing-page prototype.
 *
 * One presentation: the complete apo application window (ported shell +
 * ported pages), driven by a numbered tour strip. A deterministic,
 * scripted simulation of one task's whole loop runs inside it — spans
 * stream, judges settle, fixes converge — so the landing shows the real
 * product surfaces, alive, without a backend.
 *
 * `?panel=` deep-links a tour page (client-adopted; Astro 7 strips query
 * strings from static routes); `←`/`→` cycle pages when nothing
 * interactive is focused.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../../lib/use-reduced-motion";
import { useCapabilitySim } from "./use-capability-sim";
import type { PanelId } from "./panel-bits";
import { PANEL_ORDER } from "./panels/PanelHost";
import { AppShell } from "./variants/AppShell";

function isPanelId(value: string | null): value is PanelId {
	return value === "specify" || value === "run" || value === "verify";
}

export function CapabilityShowcase() {
	const reducedMotion = useReducedMotion();
	const sim = useCapabilitySim(reducedMotion);
	// Verify first: a verdict explains itself; a 60-line spec file does not.
	const [activePanel, setActivePanel] = useState<PanelId>("verify");

	const go = useCallback((panel: PanelId) => {
		setActivePanel(panel);
		const stage = document.querySelector("[data-pl-stage]");
		if (stage) {
			window.scrollTo({
				top: stage.getBoundingClientRect().top + window.scrollY - 24,
				behavior: "instant",
			});
		}
	}, []);

	// Adopt ?panel= on mount (shareable deep links; static SSR can't see it).
	useEffect(() => {
		const fromUrl = new URL(window.location.href).searchParams.get("panel");
		if (isPanelId(fromUrl)) setActivePanel(fromUrl);
	}, []);

	// Keep ?panel= shareable — but never stamp the default onto a URL that
	// never carried the param (and never overwrite before adoption ran).
	const firstWrite = useRef(true);
	useEffect(() => {
		if (firstWrite.current) {
			firstWrite.current = false;
			return;
		}
		const url = new URL(window.location.href);
		url.searchParams.set("panel", activePanel);
		window.history.replaceState(null, "", url);
	}, [activePanel]);

	// ←/→ cycle tour pages, except while typing or when focus sits on an
	// interactive control that owns the arrow keys.
	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
			const target = event.target as HTMLElement | null;
			if (
				target &&
				target.closest("input, textarea, select, [contenteditable], [role='tab'], button, a") !== null
			) {
				return;
			}
			event.preventDefault();
			setActivePanel((current) => {
				const index = PANEL_ORDER.indexOf(current);
				const delta = event.key === "ArrowRight" ? 1 : -1;
				return PANEL_ORDER[(index + delta + PANEL_ORDER.length) % PANEL_ORDER.length]!;
			});
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	return <AppShell sim={sim} go={go} active={activePanel} setActive={setActivePanel} />;
}
