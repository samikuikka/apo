/**
 * panel-bits — the small shared pieces panels still use: the panel id
 * vocabulary, the verdict pill (native classes), code lines, formatting.
 * Presentation only.
 */
import type { CapabilitySim } from "./use-capability-sim";
import { tokenizeLine } from "./highlight";

/** The four capability surfaces, shared by the shell's tour + sidebar. */
export type PanelId = "specify" | "run" | "verify";

export interface PanelProps {
	sim: CapabilitySim;
	go: (panel: PanelId) => void;
}

/** Verdict pill in the dashboard's own classes (renders inside .pl-native). */
export function VerdictChip({ verdict }: { verdict: "pass" | "fail" }) {
	return (
		<span
			className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${
				verdict === "pass" ? "text-success" : "text-destructive"
			}`}
		>
			<span
				className={`h-1.5 w-1.5 rounded-full ${verdict === "pass" ? "bg-success" : "bg-destructive"}`}
				aria-hidden="true"
			/>
			{verdict === "pass" ? "PASS" : "FAIL"}
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
