/**
 * PanelHost — maps a PanelId to its component and carries the shared
 * per-panel copy every variant shell reuses (tab labels, blurbs).
 */
import type { PanelId, PanelProps } from "../panel-bits";
import { SpecPanel } from "./SpecPanel";
import { RunPanel } from "./RunPanel";
import { VerdictPanel } from "./VerdictPanel";
import { LoopPanel } from "./LoopPanel";

export const PANEL_ORDER: readonly PanelId[] = ["specify", "run", "verify", "engineer"];

export const PANEL_META: Readonly<Record<PanelId, { num: string; tab: string; blurb: string }>> = {
	specify: {
		num: "001",
		tab: "Specify",
		blurb: "The suite is the standard — toggle a test, expand its code, watch the verdict follow.",
	},
	run: {
		num: "002",
		tab: "Run",
		blurb: "The real harness streaming live, then the trace waterfall it leaves behind. Click any span.",
	},
	verify: {
		num: "003",
		tab: "Verify",
		blurb: "Code tests settle instantly; judges show their reasoning, then the binary verdict.",
	},
	engineer: {
		num: "004",
		tab: "Engineer",
		blurb: "Apply the fix the evidence points at — same suite, graded signal, converge.",
	},
};

export function PanelBody({ panel, sim, go }: { panel: PanelId } & PanelProps) {
	switch (panel) {
		case "specify":
			return <SpecPanel sim={sim} go={go} />;
		case "run":
			return <RunPanel sim={sim} go={go} />;
		case "verify":
			return <VerdictPanel sim={sim} go={go} />;
		case "engineer":
			return <LoopPanel sim={sim} go={go} />;
	}
}
