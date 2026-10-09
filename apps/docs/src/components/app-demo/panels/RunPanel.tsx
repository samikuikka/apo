/**
 * RunPanel — the trace workspace, ported: a toolbar (search, call count,
 * green LIVE while streaming, line tabs Tree/Timeline), the span tree in
 * the real two-line row shape (type-colored icon chips, indent guides,
 * duration · model · tokens · cost metrics), a timeline waterfall, and
 * the call-detail pane on the right (Back, ancestor breadcrumb, type
 * badge + name, meta line, Preview/Context/Metadata tabs).
 */
import { useEffect, useState } from "react";
import { formatMs, type PanelId } from "../panel-bits";
import type { CapabilitySim, VisibleSpan } from "../use-capability-sim";
import { Icon } from "../native";

type View = "tree" | "timeline";
type DetailTab = "preview" | "context" | "metadata";

/** TraceTree TYPE_CONFIG (colors verbatim: blue-400 GEN, amber-400 TOOL). */
const TYPE_CONFIG = {
	GENERATION: { icon: "fan", label: "GEN", color: "text-blue-400", bg: "bg-blue-400/10" },
	TOOL: { icon: "wrench", label: "TOOL", color: "text-amber-400", bg: "bg-amber-400/10" },
} as const;

function modelShort(model: string): string {
	return model.split("/")[1] ?? model;
}

/** The sim's kinds are lowercase; TYPE_CONFIG keys are uppercase. */
function typeConf(kind: "generation" | "tool") {
	return TYPE_CONFIG[kind.toUpperCase() as keyof typeof TYPE_CONFIG];
}

/** Per-span cost slice of the run's total — a plausible split for the fixture. */
function spanCost(span: VisibleSpan, totalCost: string, totalTokens: number): string {
	if (!span.tokens || totalTokens === 0) return "$0.0000";
	const share = (span.tokens / totalTokens) * Number.parseFloat(totalCost.replace("$", ""));
	return `$${share.toFixed(4)}`;
}

export function RunPanel({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [speed, setSpeed] = useState(1);
	const [view, setView] = useState<View>("tree");
	const [detailTab, setDetailTab] = useState<DetailTab>("preview");
	const [search, setSearch] = useState("");
	const [expandedRun, setExpandedRun] = useState(true);
	const [deselected, setDeselected] = useState(false);

	const running = sim.phase === "running" || sim.phase === "collecting";
	// While streaming, the tree is the view that shows the run happening.
	const effectiveView: View = running && view === "timeline" ? "tree" : view;

	const query = search.trim().toLowerCase();
	const spans = query
		? sim.visibleSpans.filter((s) => s.name.toLowerCase().includes(query))
		: sim.visibleSpans;
	const selected: VisibleSpan | undefined = sim.visibleSpans.find((s) => s.id === selectedId) ?? undefined;

	// Auto-select the newest call once a finished run has spans — unless the
	// user pressed Back to read the trace overview.
	useEffect(() => {
		if (!deselected && selectedId === null && !running && sim.visibleSpans.length > 0) {
			setSelectedId(sim.visibleSpans[sim.visibleSpans.length - 1]!.id);
		}
	}, [deselected, selectedId, running, sim.visibleSpans]);
	const total = Math.max(sim.script.totalMs, 1);
	const totalTokens = sim.script.spans.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
	const totalCost = sim.script.meta.cost;
	const failingJudged =
		sim.phase === "done" &&
		sim.outcome(sim.version, "acknowledges-the-incident").verdict === "fail";

	return (
		<div className="pl-native flex h-full min-h-0 min-w-0">
			{/* ── Nav pane (TraceNav) ─────────────────────────────────────── */}
			<div className="pl-tracenav flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-background">
				<div className="border-b border-border/70 bg-background">
					{/* Toolbar row */}
					<div className="flex items-center gap-2 px-2.5 py-2">
						<div className="relative flex-1">
							<Icon
								name="search"
								className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
							/>
							<input
								type="text"
								aria-label="Search trace"
								value={search}
								onChange={(e) => setSearch(e.target.value)}
								placeholder="Search trace"
								className="h-8 w-full border border-border/70 bg-background pl-8 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring"
							/>
						</div>
						<span className="shrink-0 font-mono text-[11px] text-muted-foreground">
							{sim.visibleSpans.length}
						</span>
						{running && (
							<span
								className="inline-flex shrink-0 items-center gap-1 text-[11px] font-medium text-success"
								title="This trace is still running — spans stream in live"
							>
								<Icon name="radio" className="h-3 w-3 animate-pulse" />
								LIVE
							</span>
						)}
					</div>
					{/* View tabs (line variant) + demo controls */}
					<div className="flex items-center gap-2 px-2.5 pb-2 pt-0.5">
						<div className="pl-linetabs" role="tablist" aria-label="Trace view">
							{(["tree", "timeline"] as const).map((v) => (
								<button
									key={v}
									type="button"
									role="tab"
									aria-selected={effectiveView === v}
									className={`pl-linetab${effectiveView === v ? " pl-linetab--active" : ""}`}
									onClick={() => setView(v)}
								>
									{v === "tree" ? "Tree" : "Timeline"}
								</button>
							))}
						</div>
						<div className="ml-auto flex items-center gap-2">
							<span className="pl-speed" role="group" aria-label="Playback speed">
								{[1, 2].map((s) => (
									<button
										key={s}
										type="button"
										className={`pl-speed__btn${speed === s ? " pl-speed__btn--on" : ""}`}
										aria-pressed={speed === s}
										onClick={() => {
											setSpeed(s);
											sim.setSpeed(s);
										}}
									>
										{s}×
									</button>
								))}
							</span>
							<button type="button" className="pl-runbtn" onClick={sim.startRun}>
								{running ? "Restart" : "Re-run"}
							</button>
						</div>
					</div>
				</div>

				<div className="min-h-0 flex-1 overflow-auto">
					{effectiveView === "tree" && (
						<TreeView
							sim={sim}
							spans={spans}
							selectedId={selected?.id ?? null}
							expandedRun={expandedRun}
							onToggleRun={() => setExpandedRun(!expandedRun)}
							onSelect={setSelectedId}
							totalTokens={totalTokens}
							totalCost={totalCost}
						/>
					)}
					{effectiveView === "timeline" && (
						<TimelineView
							sim={sim}
							spans={spans}
							selectedId={selected?.id ?? null}
							onSelect={setSelectedId}
							total={total}
							running={running}
							failingJudged={failingJudged}
							go={go}
						/>
					)}
				</div>
			</div>

			{/* ── Detail pane (TraceDetailView) ───────────────────────────── */}
			<div className="h-full min-h-0 min-w-0 flex-1 overflow-auto bg-background">
				{selected ? (
					<CallDetail
						span={selected}
						runId={sim.script.runId}
						detailTab={detailTab}
						setDetailTab={setDetailTab}
						onBack={() => {
							setSelectedId(null);
							setDeselected(true);
						}}
						failingJudged={failingJudged}
						go={go}
					/>
				) : (
					<TraceOverview sim={sim} spans={sim.visibleSpans} onSelect={setSelectedId} />
				)}
			</div>
		</div>
	);
}

// ── Tree view (TraceTree row shape) ─────────────────────────────────────

function TreeView({
	sim,
	spans,
	selectedId,
	expandedRun,
	onToggleRun,
	onSelect,
	totalTokens,
	totalCost,
}: {
	sim: CapabilitySim;
	spans: readonly VisibleSpan[];
	selectedId: string | null;
	expandedRun: boolean;
	onToggleRun: () => void;
	onSelect: (id: string) => void;
	totalTokens: number;
	totalCost: string;
}) {
	return (
		<div className="py-1">
			{/* Run root row (TRACE node) */}
			<div className="relative flex w-full border-l border-transparent px-0 py-px text-left hover:bg-muted/15">
				<div className="flex w-full pl-2">
					<div className="flex w-5 shrink-0 items-center justify-center">
						<button
							type="button"
							aria-label={expandedRun ? "Collapse node" : "Expand node"}
							onClick={onToggleRun}
							className="flex h-4 w-4 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
						>
							<span
								className="inline-block h-4 w-4 transition-transform duration-200"
								style={{ transform: expandedRun ? "rotate(90deg)" : "none" }}
							>
								<Icon name="chevron-right" className="h-4 w-4" />
							</span>
						</button>
					</div>
					<button type="button" className="flex min-w-0 flex-1 cursor-pointer bg-transparent text-left">
						<div className="flex w-5 shrink-0 items-start justify-center pt-1">
							<div
								title="TRACE"
								className="flex h-3.5 w-3.5 items-center justify-center bg-muted/30 text-muted-foreground"
							>
								<Icon name="workflow" className="h-[9px] w-[9px]" />
							</div>
						</div>
						<div className="flex min-w-0 flex-1 py-0.5 pr-2">
							<div className="flex min-w-0 flex-1 flex-col gap-0.5">
								<div className="flex min-w-0 items-center gap-1.5">
									<span className="truncate text-xs text-foreground">{sim.script.runId}</span>
								</div>
								<div className="flex min-w-0 flex-wrap items-center gap-x-2 overflow-hidden">
									<span className="text-xs text-muted-foreground">
										{sim.visibleSpans.length} calls · {sim.script.meta.duration} · {sim.script.meta.tokens} tok · {totalCost}
									</span>
								</div>
							</div>
						</div>
					</button>
				</div>
			</div>

			{/* Span rows (depth 1 under the run) */}
			{expandedRun &&
				spans.map((span) => {
					const conf = typeConf(span.kind);
					return (
						<div
							key={span.id}
							className={`relative flex w-full border-l px-0 py-px text-left ${
								selectedId === span.id
									? "border-l-foreground/40 bg-muted/30"
									: "border-l-transparent hover:bg-muted/15"
							}`}
						>
							<div className="flex w-full pl-2">
								<div className="relative w-4 shrink-0">
									<div className="absolute bottom-0 left-2.5 top-0 w-px bg-border/40" />
									<div className="absolute left-2.5 top-3.5 h-px w-1.5 bg-border/40" />
								</div>
								<div className="w-5 shrink-0" />
								<button
									type="button"
									onClick={() => onSelect(span.id)}
									className="flex min-w-0 flex-1 cursor-pointer bg-transparent text-left"
								>
									<div className="flex w-5 shrink-0 items-start justify-center pt-1">
										<div
											title={conf.label}
											className={`flex h-3.5 w-3.5 items-center justify-center ${conf.bg} ${conf.color}`}
										>
											<Icon name={conf.icon} className="h-[9px] w-[9px]" />
										</div>
									</div>
									<div className="flex min-w-0 flex-1 py-0.5 pr-2">
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<div className="flex min-w-0 items-center gap-1.5">
												<span className="truncate text-xs text-foreground">{span.name}</span>
											</div>
											<div className="flex min-w-0 flex-wrap items-center gap-x-2 overflow-hidden">
												<span className="text-xs text-muted-foreground">
													{span.status === "active" ? "…" : formatMs(span.durMs)}
													{span.kind === "generation" ? ` · ${modelShort(span.model ?? "")}` : ""}
													{span.tokens !== undefined ? ` · ${span.tokens} tok` : ""}
													{span.status === "done" ? ` · ${spanCost(span, totalCost, totalTokens)}` : ""}
												</span>
											</div>
										</div>
									</div>
								</button>
							</div>
						</div>
					);
				})}

			{spans.length === 0 && sim.visibleSpans.length === 0 && (
				<p className="px-4 py-6 text-center text-sm text-muted-foreground">
					The trace appears here as the harness works — press Re-run.
				</p>
			)}
		</div>
	);
}

// ── Timeline view (TraceGanttChart shape) ───────────────────────────────

function TimelineView({
	sim,
	spans,
	selectedId,
	onSelect,
	total,
	running,
	failingJudged,
	go,
}: {
	sim: CapabilitySim;
	spans: readonly VisibleSpan[];
	selectedId: string | null;
	onSelect: (id: string) => void;
	total: number;
	running: boolean;
	failingJudged: boolean;
	go: (panel: PanelId) => void;
}) {
	return (
		<div>
			{/* Sticky time-scale header */}
			<div className="sticky top-0 z-10 flex border-b border-border/60 bg-background px-2.5 py-1 font-mono text-[10px] text-muted-foreground">
				{[0, 0.25, 0.5, 0.75, 1].map((f) => (
					<span key={f} style={{ width: `${100 / 5}%` }}>
						{(total * f) / 1000 >= 1 ? `${((total * f) / 1000).toFixed(1)}s` : `${Math.round(total * f)}ms`}
					</span>
				))}
			</div>
			{spans.map((span) => {
				const conf = typeConf(span.kind);
				const isEvidence = failingJudged && span.id === "span-6";
				return (
					<button
						key={span.id}
						type="button"
						onClick={() => onSelect(span.id)}
						className={`flex w-full items-center gap-2 border-l border-transparent px-2.5 py-1 text-left transition-colors ${
							selectedId === span.id ? "border-l-foreground/40 bg-muted/30" : "hover:bg-muted/15"
						}`}
					>
						<div
							title={conf.label}
							className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center ${conf.bg} ${conf.color}`}
						>
							<Icon name={conf.icon} className="h-[9px] w-[9px]" />
						</div>
						<span className="w-40 shrink-0 truncate text-xs text-foreground">
							{span.name}
							{isEvidence && <span className="ml-1 text-[10px] text-destructive">✗ graded FAIL</span>}
						</span>
						<span className="relative h-3 min-w-0 flex-1">
							<span
								className={`absolute top-0 h-full min-w-[2px] ${
									span.kind === "generation" ? "bg-blue-400/40" : "bg-amber-400/40"
								}${span.status === "active" ? " animate-pulse" : ""}`}
								style={{
									left: `${(span.startAt / total) * 100}%`,
									width: `${Math.max((span.durMs / total) * 100, 1.2)}%`,
								}}
							/>
						</span>
						<span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
							{span.status === "active" ? "…" : formatMs(span.durMs)}
						</span>
					</button>
				);
			})}
			{spans.length === 0 && sim.visibleSpans.length === 0 && (
				<p className="px-4 py-6 text-center text-sm text-muted-foreground">No calls recorded — re-run the task.</p>
			)}
			{!running && failingJudged && (
				<p className="border-t border-border/60 px-2.5 py-1.5 text-[11px] text-muted-foreground">
					The <span className="text-destructive">acknowledges-the-incident</span> failure traces to{" "}
					<button
						type="button"
						className="underline underline-offset-2 hover:text-foreground"
						onClick={() => go("verify")}
					>
						the verdict
					</button>
					.
				</p>
			)}
		</div>
	);
}

// ── Call detail (CallDetailHeader + tabs) ───────────────────────────────

function CallDetail({
	span,
	runId,
	detailTab,
	setDetailTab,
	onBack,
	failingJudged,
	go,
}: {
	span: VisibleSpan;
	runId: string;
	detailTab: DetailTab;
	setDetailTab: (t: DetailTab) => void;
	onBack: () => void;
	failingJudged: boolean;
	go: (panel: PanelId) => void;
}) {
	const observationType = span.kind === "generation" ? "GENERATION" : "TOOL";
	const metaParts = [
		span.kind === "generation" ? modelShort(span.model ?? "") : null,
		`${Math.round(span.durMs)}ms`,
		span.kind === "generation" ? "TTFT 240ms" : null,
		span.kind === "generation" ? "38.2 tok/s" : null,
		span.tokens !== undefined ? `${span.tokens} tok` : null,
	].filter(Boolean);

	return (
		<div>
			<div className="shrink-0 space-y-2 border-b border-border p-3">
				<button
					type="button"
					onClick={onBack}
					className="flex h-5 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					<Icon name="arrow-left" className="h-3 w-3" />
					<span>Back</span>
				</button>
				<div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
					<span className="max-w-[120px] truncate">{runId}</span>
					<Icon name="chevron-right" className="h-2.5 w-2.5 shrink-0" />
					<span className="max-w-[120px] truncate font-medium text-foreground">{span.name}</span>
				</div>
				<div className="flex items-center gap-1.5">
					<span className="inline-flex items-center border border-border/70 bg-muted/10 px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
						{observationType}
					</span>
					<span className="min-w-0 truncate text-sm font-medium">{span.name}</span>
				</div>
				<div className="text-sm text-muted-foreground">Oct 11, 2026, 2:03:22 PM</div>
				<div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
					{metaParts.map((part, i) => (
						<span key={i} className="flex items-center gap-1.5">
							{i > 0 && <span className="text-muted-foreground/40">·</span>}
							{part}
						</span>
					))}
				</div>
			</div>

			{/* Detail tabs (line variant) */}
			<div className="border-b border-border/70 px-3">
				<div className="pl-linetabs" role="tablist" aria-label="Call detail">
					{(["preview", "context", "metadata"] as const).map((t) => (
						<button
							key={t}
							type="button"
							role="tab"
							aria-selected={detailTab === t}
							className={`pl-linetab${detailTab === t ? " pl-linetab--active" : ""}`}
							onClick={() => setDetailTab(t)}
						>
							{t === "preview" ? "Preview" : t === "context" ? "Context" : "Metadata"}
						</button>
					))}
				</div>
			</div>

			<div className="p-3">
				{detailTab === "preview" && (
					<div className="space-y-3">
						{span.output && (
							<div>
								<div className="mb-1.5 text-[11px] uppercase tracking-wide text-muted-foreground">Output</div>
								<pre className="max-h-80 overflow-auto whitespace-pre-wrap border border-border/70 bg-muted/5 p-3 font-mono text-xs leading-relaxed text-foreground">
									{span.output}
								</pre>
							</div>
						)}
						{span.id === "span-6" && failingJudged && (
							<p className="text-xs text-muted-foreground">
								This generation produced the <span className="font-mono text-foreground">reply</span> the
								judges graded.{" "}
								<button
									type="button"
									className="text-foreground underline underline-offset-2"
									onClick={() => go("verify")}
								>
									Back to the verdict
								</button>
							</p>
						)}
					</div>
				)}
				{detailTab === "context" && (
					<div>
						{span.input ? (
							<pre className="overflow-auto whitespace-pre border border-border/70 bg-muted/5 p-3 font-mono text-xs leading-relaxed text-foreground">
								{span.input}
							</pre>
						) : (
							<p className="text-xs text-muted-foreground">No input recorded for this call.</p>
						)}
					</div>
				)}
				{detailTab === "metadata" && (
					<dl className="space-y-1.5 text-xs">
						{(
							[
								["span_id", span.id],
								["parent", runId],
								["type", observationType],
								...(span.model ? [["model", span.model]] : []),
								...(span.tokens !== undefined ? [["total_tokens", String(span.tokens)]] : []),
								["latency_ms", String(Math.round(span.durMs))],
								["status", span.status === "active" ? "RUNNING" : "OK"],
							] as ReadonlyArray<readonly [string, string]>
						).map(([key, value]) => (
							<div key={key} className="flex gap-3">
								<dt className="w-28 shrink-0 font-mono text-muted-foreground">{key}</dt>
								<dd className="min-w-0 font-mono text-foreground">{value}</dd>
							</div>
						))}
					</dl>
				)}
			</div>
		</div>
	);
}

// ── Trace overview (no call selected — the run root view) ──────────────

function TraceOverview({
	sim,
	spans,
	onSelect,
}: {
	sim: CapabilitySim;
	spans: readonly VisibleSpan[];
	onSelect: (id: string) => void;
}) {
	return (
		<div className="p-6">
			<h2 className="text-sm font-medium">{sim.script.runId}</h2>
			<p className="mt-1 font-mono text-xs text-muted-foreground">
				{sim.script.traceId} · {spans.length} calls · {sim.script.meta.duration} · {sim.script.meta.tokens} tok ·{" "}
				{sim.script.meta.cost}
			</p>
			<p className="mt-4 text-sm text-muted-foreground">
				Select a call in the tree to inspect its payload — input, output, tokens, and timing.
			</p>
			<div className="mt-4 space-y-1">
				{spans.slice(-3).map((span) => (
					<button
						key={span.id}
						type="button"
						onClick={() => onSelect(span.id)}
						className="block w-full truncate text-left text-xs text-muted-foreground transition-colors hover:text-foreground"
					>
						{span.kind === "TOOL" ? "▸" : "✳"} {span.name} · {formatMs(span.durMs)}
					</button>
				))}
			</div>
		</div>
	);
}
