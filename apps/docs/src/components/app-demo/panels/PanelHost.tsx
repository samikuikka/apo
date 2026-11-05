/**
 * PanelHost — maps a PanelId to its component and carries the shared
 * per-panel copy the shell reuses (numbered tour tab labels).
 */
import type { PanelId, PanelProps } from "../panel-bits";
import { SpecPanel } from "./SpecPanel";
import { RunPanel } from "./RunPanel";
import { VerdictPanel } from "./VerdictPanel";

export const PANEL_ORDER: readonly PanelId[] = ["specify", "run", "verify"];

export const PANEL_META: Readonly<Record<PanelId, { num: string; tab: string }>> = {
	specify: {
		num: "001",
		tab: "Specify",
	},
	run: {
		num: "002",
		tab: "Run",
	},
	verify: {
		num: "003",
		tab: "Verify",
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
	}
}
