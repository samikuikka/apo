/**
 * AppShell — the whole application, ported: the dashboard's top nav
 * (brand mark), the inset sidebar (Agent
 * Testing: Tasks / Runs / Schedules, Observability: Traces), the
 * breadcrumb bar (anonymous "Demo workspace" + active section), the
 * scrollable main area hosting the ported pages, and the bottom status
 * bar with the real version pattern. The numbered tour strip above the
 * window is the landing's capability switcher — it navigates the app
 * like a visitor would.
 */
import { useEffect, useRef, useState } from "react";
import { PANEL_META, PANEL_ORDER, PanelBody } from "../panels/PanelHost";
import type { PanelId, PanelProps } from "../panel-bits";
import { Icon } from "../native";

/** Which real sidebar item is active for each tour page. */
const SIDEBAR_FOR: Readonly<Record<PanelId, string>> = {
	specify: "tasks",
	run: "traces",
	verify: "runs",
};

const SIDEBAR_LABEL: Readonly<Record<string, string>> = {
	tasks: "Tasks",
	runs: "Runs",
	traces: "Traces",
};

const SIDEBAR_GROUPS: ReadonlyArray<{
	label: string;
	items: ReadonlyArray<{ id: string; label: string; icon: string; dead?: boolean }>;
}> = [
	{
		label: "Agent Testing",
		items: [
			{ id: "tasks", label: "Tasks", icon: "flask-conical" },
			{ id: "runs", label: "Runs", icon: "layers" },
			{ id: "schedules", label: "Schedules", icon: "calendar", dead: true },
		],
	},
	{
		label: "Observability",
		items: [{ id: "traces", label: "Traces", icon: "waypoints" }],
	},
];

export function AppShell({
	sim,
	go,
	active,
	setActive,
}: PanelProps & { active: PanelId; setActive: (panel: PanelId) => void }) {
	// Sidebar starts collapsed (icon rail) — the tour tabs carry navigation,
	// so the pages get the full window. The trigger toggles it, like the app.
	const [sidebarOpen, setSidebarOpen] = useState(true);

	// Product-scale presentation: the window renders at a full 1600×880
	// viewport and zooms down to the landing's column, so every size reads
	// like the product on a large screen, just smaller.
	const DESIGN_W = 1600;
	const DESIGN_H = 880;
	const frameRef = useRef<HTMLDivElement>(null);
	const [zoom, setZoom] = useState(1);
	const [native, setNative] = useState(false);
	useEffect(() => {
		const el = frameRef.current;
		if (!el) return;
		const update = () => {
			// Below ~900px the scaled window would be illegible (a 20px title
			// renders at 5px) — render at native size instead and let the app's
			// own responsive rules carry the layout.
			const isNarrow = el.clientWidth < 900;
			setNative(isNarrow);
			setZoom(isNarrow ? 1 : el.clientWidth / DESIGN_W);
			if (isNarrow) setSidebarOpen(false);
		};
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		// Belt and braces: on pages whose containers cap the frame width, a
		// viewport resize can settle without a final RO callback.
		window.addEventListener("resize", update);
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", update);
		};
	}, []);
	return (
		<div className="pl-page">
<section className="pl-showcase">
				<div className="pl-tabs" role="tablist" aria-label="The loop: Specify, Run, Verify">
					{PANEL_ORDER.map((id) => (
						<button
							key={id}
							type="button"
							role="tab"
							id={`pl-tab-${id}`}
							aria-selected={id === active}
							aria-controls={`pl-panel-${id}`}
							className={`pl-tab${id === active ? " pl-tab--active" : ""}`}
							onClick={() => setActive(id)}
						>
							<span className="pl-tab__num">{PANEL_META[id].num}</span>
							<span className="pl-tab__label">{PANEL_META[id].tab}</span>
						</button>
					))}
				</div>
				{/* The application in a real-browser frame, scaled to fit */}
				<div ref={frameRef} className="pl-appwin-frame" data-pl-stage>
					<div
						className="pl-appwin pl-native"
						style={{ width: native ? "100%" : DESIGN_W, height: DESIGN_H, zoom }}
					>

					{/* Top nav (top-nav.tsx): brand mark */}
					<nav className="flex h-12 w-full shrink-0 items-center justify-between border-b border-border bg-background px-4 md:px-6">
						<div className="flex items-center gap-4">
							<a className="pl-brandmark" href="/" aria-label="Home">
								<img src="/brand/signal-sphere-small.svg" alt="" aria-hidden="true" />
								<span className="text-sm font-semibold tracking-tight">apo</span>
							</a>
						</div>
					</nav>

					<div className="flex min-h-0 flex-1">
						{/* Inset sidebar (dashboard-shell.tsx) */}
						<aside className={`pl-sidebar${sidebarOpen ? "" : " pl-sidebar--collapsed"}`}>
							<div className="pl-sidebar__inner">
								{SIDEBAR_GROUPS.map((group) => (
									<div key={group.label} className="pl-sb-group flex flex-col">
										<div className="pl-sb-group-label">{group.label}</div>
										{group.items.map((item) =>
											item.dead ? (
												<span
													key={item.id}
													className="pl-sb-button pl-sb-button--dead"
													title="Not in this demo"
												>
													<Icon name={item.icon} className="size-4.5" />
													<span>{item.label}</span>
												</span>
											) : (
												<button
													key={item.id}
													type="button"
													className={`pl-sb-button${SIDEBAR_FOR[active] === item.id ? " pl-sb-button--active" : ""}`}
													onClick={() => {
														const target = PANEL_ORDER.find((p) => SIDEBAR_FOR[p] === item.id);
														if (target) setActive(target);
													}}
												>
													<Icon name={item.icon} className="size-4.5" />
													<span>{item.label}</span>
												</button>
											),
										)}
									</div>
								))}
							</div>
						</aside>

						{/* Inset: breadcrumb bar + main */}
						<div className="flex min-w-0 flex-1 flex-col overflow-hidden">
							<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-4 md:px-6">
							<button
								type="button"
								className="flex size-7 items-center justify-center transition-colors hover:bg-muted/50"
								aria-label="Toggle Sidebar"
								aria-expanded={sidebarOpen}
								title="Toggle Sidebar"
								onClick={() => setSidebarOpen(!sidebarOpen)}
							>
								<Icon name="panel-left" className="size-4 text-foreground" />
							</button>
								<span className="pl-vsep mr-1 h-5" aria-hidden="true" />
								<nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
									<span className="truncate text-sm font-medium">Demo workspace</span>
									<span className="pl-vsep mx-1 h-5" aria-hidden="true" />
									<span className="truncate font-medium text-muted-foreground">
										{SIDEBAR_LABEL[SIDEBAR_FOR[active]]}
									</span>
								</nav>
							</header>

							<main
								className="flex-1 overflow-y-auto"
								role="tabpanel"
								id={`pl-panel-${active}`}
								aria-labelledby={`pl-tab-${active}`}
							>
							<PanelBody panel={active} sim={sim} go={go} />
						</main>
						</div>
					</div>
				</div>
			</div>
		</section>
		</div>
	);
}
