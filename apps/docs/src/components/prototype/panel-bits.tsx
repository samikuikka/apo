/**
 * panel-bits — the small shared pieces every panel uses: verdict pills,
 * check badges, run status, code lines. Presentation only.
 */
import type { CapabilitySim, RunPhase } from "./use-capability-sim";
import { tokenizeLine } from "./highlight";

/** The four capability surfaces, shared by every variant shell. */
export type PanelId = "specify" | "run" | "verify" | "engineer";

export interface PanelProps {
	sim: CapabilitySim;
	go: (panel: PanelId) => void;
}

/** Product-style verdict pill (rounded-full, dot, uppercase). */
export function VerdictChip({ verdict, big = false }: { verdict: "pass" | "fail"; big?: boolean }) {
	return (
		<span className={`pl-pill pl-pill--${verdict}${big ? " pl-pill--big" : ""}`}>
			<span className="pl-pill__dot" aria-hidden="true" />
			{verdict === "pass" ? "PASS" : "FAIL"}
		</span>
	);
}

/** The ✓ / ✗ / ◌ badge on a check row. */
export function TestBadge({ state }: { state: "pass" | "fail" | "judging" | "unknown" }) {
	if (state === "pass") return <span className="pl-tbadge pl-tbadge--pass" aria-hidden="true">✓</span>;
	if (state === "fail") return <span className="pl-tbadge pl-tbadge--fail" aria-hidden="true">✗</span>;
	if (state === "judging")
		return <span className="pl-tbadge pl-tbadge--judging" aria-hidden="true">◌</span>;
	return <span className="pl-tbadge" aria-hidden="true">·</span>;
}

export function StatusPill({ phase }: { phase: RunPhase }) {
	const label =
		phase === "running"
			? "Running"
			: phase === "collecting"
				? "Collecting"
				: phase === "judging"
					? "Judging"
					: phase === "done"
						? "Complete"
						: "Idle";
	const busy = phase === "running" || phase === "collecting" || phase === "judging";
	return (
		<span className={`pl-status${busy ? " pl-status--busy" : ""}`}>
			<span className="pl-status__dot" aria-hidden="true" />
			{label}
			{busy && "…"}
		</span>
	);
}

/** One tinted code line. `line` may be empty (renders a blank row). */
export function CodeLine({
	line,
	ln,
	fail = false,
}: {
	line: string;
	ln?: number;
	fail?: boolean;
}) {
	return (
		<div className={`pl-code-line${fail ? " pl-code-line--fail" : ""}`}>
			{ln !== undefined && <span className="pl-code-ln">{ln}</span>}
			<span className="pl-code-text">
				{tokenizeLine(line).map((tok, i) =>
					tok.cls ? (
						<span key={i} className={`pl-tok-${tok.cls}`}>
							{tok.text}
						</span>
					) : (
						<span key={i}>{tok.text}</span>
					),
				)}
			</span>
		</div>
	);
}

export function formatMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function spanGlyph(kind: "generation" | "tool"): string {
	return kind === "generation" ? "✳" : "▸";
}
