/**
 * AppShell — the whole application, ported: the dashboard's top nav
 * (brand mark + demo badge + anonymous sign-in CTA), the inset sidebar
 * (Agent Testing: Tasks / Runs / Schedules, Observability: Traces), the
 * breadcrumb bar (project switcher + active section), the scrollable
 * main area hosting the ported pages, and the bottom status bar. The
 * numbered tour strip above the window is the landing's capability
 * switcher — it navigates the app like a visitor would.
 */
import { PANEL_META, PANEL_ORDER, PanelBody } from "../panels/PanelHost";
import type { PanelId, PanelProps } from "../panel-bits";
import { Icon } from "../native";

/** Which real sidebar item is active for each tour page. */
const SIDEBAR_FOR: Readonly<Record<PanelId, string>> = {
	specify: "tasks",
	run: "traces",
	verify: "runs",
	engineer: "runs",
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

const DEMO_URL = "http://localhost:3000/project/demo/tasks";

export function AppShell({
	sim,
	go,
	active,
	setActive,
}: PanelProps & { active: PanelId; setActive: (panel: PanelId) => void }) {
	const activeNavLabel =
		SIDEBAR_FOR[active] === "traces"
			? "Traces"
			: SIDEBAR_FOR[active] === "runs"
				? active === "engineer"
					? "Runs"
					: "Runs"
				: "Tasks";

	return (
		<div className="pl-page">
			<section className="pl-hero pl-hero--slim">
				<div className="pl-hero__inner">
					<span className="pl-hero__badge">Public Alpha</span>
					<h1 className="pl-hero__title">Define done. Engineer until it holds.</h1>
					<p className="pl-hero__sub">
						Executable capability specifications: apo runs the real harness and returns pass
						or fail with evidence. Below is the application — scripted, not screenshots. Click
						anything.
					</p>
					<div className="pl-hero__cta">
						<a className="pl-btn pl-btn--primary" href={DEMO_URL} target="_blank" rel="noopener noreferrer">
							Open the demo project →
						</a>
						<a className="pl-btn pl-btn--outline" href="/overview/">
							Read the docs
						</a>
						<a
							className="pl-btn pl-btn--outline"
							href="https://github.com/samikuikka/apo"
							target="_blank"
							rel="noopener noreferrer"
						>
							Star on GitHub
						</a>
					</div>
				</div>
			</section>

			<section className="pl-showcase">
				<div className="pl-tabs" role="tablist" aria-label="The loop, in four moves">
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
				<p className="pl-blurb" role="presentation">
					{PANEL_META[active].blurb}
				</p>

				{/* The application window */}
				<div className="pl-appwin pl-native" data-pl-stage>
					{/* Top nav (top-nav.tsx): brand + demo badge | anonymous sign-in */}
					<nav className="sticky top-0 z-50 flex h-12 w-full items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-md">
						<div className="flex items-center gap-4">
							<a className="pl-brandmark" href="/" aria-label="apo, home">
								<img src="/brand/signal-sphere-small.svg" alt="" aria-hidden="true" />
								<span className="text-sm font-semibold tracking-tight">apo</span>
							</a>
							<span className="inline-flex items-center border border-border bg-muted/40 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
								Demo
							</span>
						</div>
						<div className="flex items-center gap-4">
							<a
								href={DEMO_URL}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-flex h-8 items-center border border-border px-3 text-xs font-medium transition-colors hover:bg-muted/40"
							>
								Sign in
							</a>
						</div>
					</nav>

					<div className="flex" style={{ height: "min(46rem, 78vh)" }}>
						{/* Inset sidebar (dashboard-shell.tsx) */}
						<aside className="pl-sidebar">
							<div className="pl-sidebar__inner">
								{SIDEBAR_GROUPS.map((group) => (
									<div key={group.label} className="flex flex-col">
										<div className="pl-sb-group-label">{group.label}</div>
										{group.items.map((item) =>
											item.dead ? (
												<span
													key={item.id}
													className="pl-sb-button pl-sb-button--dead"
													title="Not in this prototype"
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
								<div className="flex-1" />
								<div className="pl-sb-group-label" style={{ opacity: 0.6 }}>
									 scripted fixture
								</div>
							</div>
						</aside>

						{/* Inset: breadcrumb bar + main */}
						<div className="flex min-w-0 flex-1 flex-col overflow-hidden border-l border-sidebar-border">
							<header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 bg-background px-4">
								<Icon name="panel-left" className="h-4 w-4 text-muted-foreground" />
								<span className="pl-vsep mr-1 h-5" aria-hidden="true" />
								<nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
									<button
										type="button"
										className="truncate font-medium text-muted-foreground transition-colors hover:text-foreground"
										onClick={() => setActive("specify")}
									>
										acme-support
									</button>
									<span className="pl-vsep mx-1 h-5" aria-hidden="true" />
									<span className="truncate font-medium text-muted-foreground">{activeNavLabel}</span>
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

					{/* Status bar (status-bar.tsx) */}
					<footer className="z-30 flex shrink-0 items-center justify-between border-t border-border/60 bg-background px-3" style={{ height: "var(--status-bar-h)" }}>
						<nav aria-label="Resources" className="flex items-center gap-3">
							<a
								href="/overview/"
								className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
							>
								<Icon name="book-open" className="size-3" />
								Docs
							</a>
							<a
								href="https://github.com/samikuikka/apo"
								target="_blank"
								rel="noopener noreferrer"
								className="flex items-center gap-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
							>
								<Icon name="github" className="size-3" />
								GitHub
							</a>
						</nav>
						<span className="font-mono text-[10px] tabular-nums text-muted-foreground/70">
							landing prototype · scripted fixture · no backend
						</span>
					</footer>
				</div>
			</section>

			<footer className="pl-foot">
				<span>apo — executable capability specifications for harness engineering.</span>
				<span className="pl-foot__links">
					<a href="/overview/">Docs</a>
					<a href="https://github.com/samikuikka/apo" target="_blank" rel="noopener noreferrer">
						GitHub
					</a>
				</span>
			</footer>
		</div>
	);
}
