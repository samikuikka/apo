/**
 * native.tsx — pixel-faithful ports of the dashboard components the
 * prototype needs, with their original Tailwind class strings (implemented
 * in native.css) and their original lucide icon geometry. PROTOTYPE.
 *
 * Ports:
 *  - Icon            (lucide-react icons, verbatim node data)
 *  - NativePanel     (runs/task/[taskRunId]/panel.tsx)
 *  - NativeTabStrip  (task-run-tab-strip.tsx)
 *  - RunHead         (run-detail page header: breadcrumb, status pill, meta)
 *  - OutcomeSummary  (components/run-outcome/outcome-summary.tsx)
 *  - CheckRow        (expandable-check-item.tsx, minus corrections/URL state)
 *  - SecondJudgeMark (expandable-check-item.tsx)
 *  - JudgeStrip      (judge-strip.tsx, meta row)
 *  - TaskHead        (tasks/[...taskId]/page.tsx header)
 */
import type { ReactNode } from "react";
import { tokenizeLine } from "./highlight";

// ── Icons (lucide node data, verbatim) ──────────────────────────────────

type IconNode = Array<
	["path", { d: string }] | ["circle", Record<string, string>] | ["rect", Record<string, string>] | ["line", Record<string, string>]
>;

const ICONS: Readonly<Record<string, IconNode>> = {
	"arrow-left": [
		["path", { d: "m12 19-7-7 7-7" }],
		["path", { d: "M19 12H5" }],
	],
	"chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
	clock: [
		["path", { d: "M12 6v6l4 2" }],
		["circle", { cx: "12", cy: "12", r: "10" }],
	],
	"dollar-sign": [
		["line", { x1: "12", x2: "12", y1: "2", y2: "22" }],
		["path", { d: "M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" }],
	],
	brain: [
		["path", { d: "M12 18V5" }],
		["path", { d: "M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" }],
		["path", { d: "M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" }],
		["path", { d: "M17.997 5.125a4 4 0 0 1 2.526 5.77" }],
		["path", { d: "M18 18a4 4 0 0 0 2-7.464" }],
		["path", { d: "M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" }],
		["path", { d: "M6 18a4 4 0 0 1-2-7.464" }],
		["path", { d: "M6.003 5.125a4 4 0 0 0-2.526 5.77" }],
	],
	timer: [
		["line", { x1: "10", x2: "14", y1: "2", y2: "2" }],
		["line", { x1: "12", x2: "15", y1: "14", y2: "11" }],
		["circle", { cx: "12", cy: "14", r: "8" }],
	],
	"folder-open": [
		[
			"path",
			{
				d: "m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2",
			},
		],
	],
	"message-square": [
		["path", { d: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z" }],
	],
	"file-text": [
		["path", { d: "M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" }],
		["path", { d: "M14 2v5a1 1 0 0 0 1 1h5" }],
		["path", { d: "M10 9H8" }],
		["path", { d: "M16 13H8" }],
		["path", { d: "M16 17H8" }],
	],
	cpu: [
		["path", { d: "M12 20v2" }],
		["path", { d: "M12 2v2" }],
		["path", { d: "M17 20v2" }],
		["path", { d: "M17 2v2" }],
		["path", { d: "M2 12h2" }],
		["path", { d: "M2 17h2" }],
		["path", { d: "M2 7h2" }],
		["path", { d: "M20 12h2" }],
		["path", { d: "M20 17h2" }],
		["path", { d: "M20 7h2" }],
		["path", { d: "M7 20v2" }],
		["path", { d: "M7 2v2" }],
		["rect", { x: "4", y: "4", width: "16", height: "16", rx: "2" }],
		["rect", { x: "8", y: "8", width: "8", height: "8", rx: "1" }],
	],
	coins: [
		["circle", { cx: "8", cy: "8", r: "6" }],
		["path", { d: "M18.09 10.37A6 6 0 1 1 10.34 18" }],
		["path", { d: "M7 6h1v4" }],
		["path", { d: "m16.71 13.88.7.71-2.82 2.82" }],
	],
	workflow: [
		["rect", { width: "8", height: "8", x: "3", y: "3", rx: "2" }],
		["path", { d: "M7 11v4a2 2 0 0 0 2 2h4" }],
		["rect", { width: "8", height: "8", x: "13", y: "13", rx: "2" }],
	],
	"external-link": [
		["path", { d: "M15 3h6v6" }],
		["path", { d: "M10 14 21 3" }],
		["path", { d: "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" }],
	],
	"list-checks": [
		["path", { d: "M13 5h8" }],
		["path", { d: "M13 12h8" }],
		["path", { d: "M13 19h8" }],
		["path", { d: "m3 17 2 2 4-4" }],
		["path", { d: "m3 7 2 2 4-4" }],
	],
	"square-code": [
		["path", { d: "m10 9-3 3 3 3" }],
		["path", { d: "m14 15 3-3-3-3" }],
		["rect", { x: "3", y: "3", width: "18", height: "18", rx: "2" }],
	],
	"flask-conical": [
		["path", { d: "M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2" }],
		["path", { d: "M6.453 15h11.094" }],
		["path", { d: "M8.5 2h7" }],
	],
	layers: [
		["path", { d: "M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" }],
		["path", { d: "M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" }],
		["path", { d: "M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" }],
	],
	calendar: [
		["path", { d: "M8 2v4" }],
		["path", { d: "M16 2v4" }],
		["rect", { width: "18", height: "18", x: "3", y: "4", rx: "2" }],
		["path", { d: "M3 10h18" }],
	],
	waypoints: [
		["circle", { cx: "12", cy: "4.5", r: "2.5" }],
		["path", { d: "m10.2 6.3-3.9 3.9" }],
		["circle", { cx: "4.5", cy: "12", r: "2.5" }],
		["path", { d: "M7 12h10" }],
		["circle", { cx: "19.5", cy: "12", r: "2.5" }],
		["path", { d: "m13.8 17.7 3.9-3.9" }],
		["circle", { cx: "12", cy: "19.5", r: "2.5" }],
	],
	"panel-left": [
		["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }],
		["path", { d: "M9 3v18" }],
	],
	"book-open": [
		["path", { d: "M12 7v14" }],
		["path", { d: "M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" }],
	],
	github: [
		["path", { d: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" }],
		["path", { d: "M9 18c-4.51 2-5-2-7-2" }],
	],
};

export function Icon({ name, className }: { name: keyof typeof ICONS | string; className?: string }) {
	const node = ICONS[name] ?? [];
	return (
		<svg
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokejoin="round"
			className={className}
			aria-hidden="true"
		>
			{node.map((el, i) => {
				const [tag, attrs] = el;
				const props = { key: i, ...attrs };
				return tag === "path" ? <path {...props} /> : tag === "circle" ? <circle {...props} /> : tag === "rect" ? <rect {...props} /> : <line {...props} />;
			})}
		</svg>
	);
}

// ── Panel (panel.tsx) ───────────────────────────────────────────────────

export function NativePanel({ children, padded = false }: { children: ReactNode; padded?: boolean }) {
	return (
		<section className="overflow-hidden border border-border bg-card/60">
			{padded ? <div className="p-4">{children}</div> : children}
		</section>
	);
}

// ── Tab strip (task-run-tab-strip.tsx) ──────────────────────────────────

export interface NativeTab {
	readonly id: string;
	readonly label: string;
	readonly icon: string;
	readonly count?: number;
}

export function NativeTabStrip({
	tabs,
	activeTab,
	onSelectTab,
}: {
	tabs: readonly NativeTab[];
	activeTab: string;
	onSelectTab: (id: string) => void;
}) {
	return (
		<div className="flex items-center gap-1 overflow-x-auto overflow-y-hidden border-t border-border px-4">
			{tabs.map((tab) => {
				const isActive = tab.id === activeTab;
				return (
					<button
						type="button"
						key={tab.id}
						onClick={() => onSelectTab(tab.id)}
						className={`relative inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap px-3 text-[13px] font-medium transition-colors ${
							isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground"
						}`}
					>
						<Icon name={tab.icon} className="h-3.5 w-3.5" />
						{tab.label}
						{typeof tab.count === "number" && (
							<span
								className={`px-1 font-mono text-[10px] tabular-nums ${
									isActive ? "bg-foreground/10 text-foreground" : "bg-card text-muted-foreground"
								}`}
							>
								{tab.count}
							</span>
						)}
						{isActive && <span className="absolute inset-x-2 bottom-0 h-px bg-foreground" />}
					</button>
				);
			})}
		</div>
	);
}

// ── Run header (run-detail page.tsx) ────────────────────────────────────

const STATUS_DOT: Record<string, { dot: string; text: string }> = {
	passed: { dot: "bg-success", text: "text-success" },
	failed: { dot: "bg-destructive", text: "text-destructive" },
	running: { dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
	pending: { dot: "bg-muted-foreground/40", text: "text-muted-foreground" },
	judging: { dot: "bg-foreground animate-pulse", text: "text-muted-foreground" },
};

export function RunHead({
	statusLabel,
	status,
	batchId,
	taskId,
	runId,
	onBack,
}: {
	statusLabel: string;
	status: "passed" | "failed" | "running" | "pending" | "judging";
	batchId: string;
	taskId: string;
	runId: string;
	onBack?: () => void;
}) {
	const conf = STATUS_DOT[status] ?? STATUS_DOT.pending!;
	return (
		<div className="border-b border-border bg-background">
			<div className="flex flex-col gap-3 px-6 py-4 lg:flex-row lg:items-start lg:justify-between">
				<div className="min-w-0">
					<div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
						<button type="button" onClick={onBack} className="inline-flex items-center gap-1 hover:text-foreground">
							<Icon name="arrow-left" className="h-3 w-3" />
							Runs
						</button>
						<Icon name="chevron-right" className="h-3 w-3 text-muted-foreground/50" />
						<span className="font-mono">{batchId.slice(0, 8)}</span>
						<Icon name="chevron-right" className="h-3 w-3 text-muted-foreground/50" />
						<span>{taskId}</span>
						<Icon name="chevron-right" className="h-3 w-3 text-muted-foreground/50" />
						<span className="font-mono text-foreground">{runId.slice(0, 10)}</span>
					</div>
					<div className="mt-2 flex flex-wrap items-center gap-2.5">
						<span
							className={`inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${conf.text}`}
						>
							<span className={`h-1.5 w-1.5 rounded-full ${conf.dot}`} />
							{statusLabel}
						</span>
						<h1 className="text-[20px] font-semibold tracking-tight">{taskId}</h1>
					</div>
					<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
						<span className="font-mono">{taskId}</span>
						<span className="text-muted-foreground/50">·</span>
						<span>supportInboxAdapter</span>
						<span className="text-muted-foreground/50">·</span>
						<span className="text-muted-foreground">Model</span>
						<span className="font-mono text-foreground">deepseek/deepseek-v4.1-flash</span>
					</div>
				</div>
			</div>
		</div>
	);
}

// ── OutcomeSummary (outcome-summary.tsx) ────────────────────────────────

function passRateTone(rate: number): string {
	if (rate >= 100) return "text-success";
	if (rate < 50) return "text-destructive";
	return "text-foreground";
}

function LegendCount({
	value,
	label,
	className,
}: {
	value: number;
	label: string;
	className?: string;
}) {
	return (
		<span className="inline-flex items-baseline gap-1">
			<span className={`font-mono tabular-nums ${className ?? ""}`}>{value}</span>
			<span className="text-muted-foreground">{label}</span>
		</span>
	);
}

export function OutcomeSummary({
	passed,
	failed,
	errored,
	total,
	unit,
	running,
	metadata,
}: {
	passed: number;
	failed: number;
	errored: number;
	total: number;
	unit: string;
	running?: boolean;
	metadata?: ReadonlyArray<{ icon?: string; value: ReactNode; label?: string; onClick?: () => void }>;
}) {
	const rate = total > 0 ? Math.round((passed / total) * 100) : 0;
	const evaluated = passed + failed + errored;
	const showHero = evaluated > 0 || !running;

	return (
		<div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:gap-5">
			<div className="flex shrink-0 flex-row items-baseline gap-2 sm:flex-col sm:items-start sm:gap-0">
				<span
					className={`font-mono text-[32px] leading-none tabular-nums tracking-tight ${
						running ? "text-muted-foreground" : passRateTone(rate)
					}`}
				>
					{showHero ? `${rate}%` : "—"}
				</span>
				<span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
					{running ? "running…" : "pass rate"}
				</span>
			</div>

			<div className="min-w-0 flex-1">
				<div className="flex h-2 w-full max-w-md overflow-hidden rounded-full bg-border">
					{total > 0 && passed > 0 && (
						<div className="h-full bg-success" style={{ width: `${(passed / total) * 100}%` }} />
					)}
					{total > 0 && failed > 0 && (
						<div className="h-full bg-destructive" style={{ width: `${(failed / total) * 100}%` }} />
					)}
					{errored > 0 && (
						<div className="h-full bg-foreground/40" style={{ width: `${(errored / total) * 100}%` }} />
					)}
					{running && <div className="h-full animate-pulse bg-foreground/40" style={{ width: "12%" }} />}
				</div>

				<div className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
					<LegendCount value={passed} label="passed" className={passed > 0 ? "text-success" : undefined} />
					<span className="text-muted-foreground/40">·</span>
					<LegendCount value={failed} label="failed" className={failed > 0 ? "text-destructive" : undefined} />
					<span className="text-muted-foreground/40">·</span>
					<span className="inline-flex items-baseline gap-1">
						<span className="font-mono tabular-nums text-foreground">{total}</span>
						<span className="text-muted-foreground">{unit}</span>
					</span>
				</div>

				{metadata && metadata.length > 0 && (
					<div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-[12px] text-muted-foreground">
						{metadata.map((item, i) => (
							<span key={i} className="inline-flex items-center gap-1">
								{item.icon && <Icon name={item.icon} className="h-3 w-3 text-muted-foreground/50" />}
								{item.onClick ? (
									<button
										type="button"
										onClick={item.onClick}
										className="font-mono tabular-nums text-foreground/80 underline decoration-muted-foreground/40 underline-offset-2 hover:text-foreground"
									>
										{item.value}
									</button>
								) : (
									<span className="font-mono tabular-nums text-foreground/80">{item.value}</span>
								)}
								{item.label && <span className="text-muted-foreground">{item.label}</span>}
							</span>
						))}
					</div>
				)}
			</div>
		</div>
	);
}

// ── Check row (expandable-check-item.tsx) ───────────────────────────────

export interface CheckRowState {
	readonly id: string;
	readonly passed: boolean | null; // null = not settled yet
	readonly judging?: boolean;
	readonly reasoning?: string;
	readonly secondJudge?: { readonly mark: string; readonly title: string } | null;
	readonly disabled?: boolean;
}

export function CheckRow({
	state,
	expanded,
	onToggle,
	children,
	actions,
}: {
	state: CheckRowState;
	expanded: boolean;
	onToggle: () => void;
	children?: ReactNode;
	/** Extra hover controls pinned right of the row (e.g. the suite toggle). */
	actions?: ReactNode;
}) {
	const passed = state.passed === true;
	const pending = state.passed === null;

	return (
		<div
			className={`group border-b border-border last:border-b-0 transition-colors ${
				expanded ? "bg-card/30" : "hover:bg-card/20"
			}`}
		>
			<div className="relative">
				<button
					type="button"
					onClick={onToggle}
					className="flex w-full items-center gap-3 px-4 py-3 text-left"
				>
					<span
						className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] ${
							pending
								? state.judging
									? "bg-foreground/10 text-muted-foreground animate-pulse"
									: "bg-muted/40 text-muted-foreground/60"
								: passed
									? "bg-success/15 text-success"
									: "bg-destructive/15 text-destructive"
						}`}
					>
						{pending ? (state.judging ? "…" : "·") : passed ? "✓" : "✗"}
					</span>
					<div className="min-w-0 flex-1">
						<div className="flex flex-wrap items-center gap-2">
							<span
								className={`font-mono text-[13px] ${
									pending ? "text-muted-foreground" : passed ? "text-foreground" : "text-destructive"
								} ${expanded ? "font-medium" : ""}`}
							>
								{state.id}
							</span>
							{!passed && !expanded && !pending && state.reasoning && (
								<span className="truncate text-[11px] text-muted-foreground">
									{state.reasoning.split("\n")[0]}
								</span>
							)}
							{state.disabled && (
								<span className="shrink-0 border border-border bg-muted/40 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
									Disabled
								</span>
							)}
							{state.secondJudge && (
								<span className="shrink-0 font-mono text-[10px] text-muted-foreground" title={state.secondJudge.title}>
									{state.secondJudge.mark}
								</span>
							)}
						</div>
					</div>
					<span
						className="shrink-0 text-muted-foreground/60 transition-transform"
						style={{ transform: expanded ? "rotate(90deg)" : "none" }}
					>
						<Icon name="chevron-right" className="h-3.5 w-3.5" />
					</span>
				</button>
				{actions && (
					<div className="absolute right-9 top-1/2 z-10 flex -translate-y-1/2 items-center gap-1">{actions}</div>
				)}
			</div>

			{expanded && (
				<div className="border-t border-border px-4 pb-4 pt-3">
					<div className="max-w-[860px] space-y-3">{children}</div>
				</div>
			)}
		</div>
	);
}

/** Toggle styled like the row's hover affordances (PenLine position). */
export function CheckRowToggle({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
	return (
		<button
			type="button"
			aria-pressed={on}
			aria-label={label}
			title={label}
			onClick={onClick}
			className={`flex h-6 w-6 items-center justify-center transition-colors ${
				on ? "text-success" : "text-muted-foreground/50 hover:text-foreground"
			}`}
		>
			{on ? "●" : "○"}
		</button>
	);
}

// ── JudgeStrip meta row (judge-strip.tsx) ───────────────────────────────

export function JudgeMeta({
	model,
	latency,
	tokens,
	onViewInTrace,
}: {
	model: string;
	latency: string;
	tokens: string;
	onViewInTrace?: () => void;
}) {
	return (
		<div className="space-y-1.5">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
				<span className="inline-flex items-center gap-1.5">
					<Icon name="cpu" className="h-3 w-3" />
					<span className="font-mono">{model}</span>
				</span>
				<span className="inline-flex items-center gap-1.5">
					<Icon name="timer" className="h-3 w-3" />
					<span>{latency}</span>
				</span>
				<span className="inline-flex items-center gap-1.5">
					<Icon name="coins" className="h-3 w-3" />
					<span>{tokens}</span>
				</span>
				{onViewInTrace && (
					<button
						type="button"
						onClick={onViewInTrace}
						className="ml-auto inline-flex items-center gap-1 border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
					>
						<Icon name="workflow" className="h-3 w-3" />
						View in trace
					</button>
				)}
			</div>
		</div>
	);
}

// ── Task head (tasks/[...taskId]/page.tsx) ──────────────────────────────

export function TaskHead({ taskId, badges }: { taskId: string; badges: readonly string[] }) {
	return (
		<div className="border-b border-border px-6 py-5">
			<div className="mt-1 flex min-w-0 flex-wrap items-center gap-3">
				<Icon name="folder-open" className="h-4 w-4 shrink-0 text-primary" />
				<h1 className="min-w-0 truncate text-[20px] font-semibold tracking-tight">{taskId}</h1>
			</div>
			<div className="mt-2 flex min-w-0 flex-wrap items-center gap-1.5">
				{badges.map((badge) => (
					<span
						key={badge}
						className="inline-flex h-5 items-center border border-border px-1.5 text-[10px] text-muted-foreground"
					>
						{badge}
					</span>
				))}
			</div>
		</div>
	);
}

// ── Code viewer (dashboard CodeViewer look, static) ─────────────────────

export function NativeCode({ lines }: { lines: readonly string[] }) {
	return (
		<div className="pl-codeviewer">
			{lines.map((line, i) => (
				<div key={i} className="pl-cv-line">
					<span className="pl-cv-ln">{i + 1}</span>
					<span className="pl-cv-text">
						{tokenizeLine(line).map((tok, j) =>
							tok.cls ? (
								<span key={j} className={`pl-tok-${tok.cls}`}>
									{tok.text}
								</span>
							) : (
								<span key={j}>{tok.text}</span>
							),
						)}
					</span>
				</div>
			))}
		</div>
	);
}
