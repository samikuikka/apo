/**
 * SpecPanel — the task-detail page, in the dashboard's shape: header with
 * back link, folder title, adapter badge and the badge row; tabs
 * (Files / Task Run History). The Files tab is the real TaskFileBrowser —
 * a two-pane file list + viewer over the task's files, where the suite
 * lives as the .eval.ts source. Check results are the run detail's job.
 */
import { useState } from "react";
import type { PanelId } from "../panel-bits";
import {
	FIXES,
	INBOUND_EMAIL,
	RUN_IDS,
	SPEC_HEAD_LINES,
	TESTS,
	VERSION_LABELS,
	specBlockLines,
	type VersionId,
} from "../capability-sim";
import type { CapabilitySim } from "../use-capability-sim";
import {
	NativePanel,
	NativeTabStrip,
	TaskHead,
	type NativeTab,
	Icon,
} from "../native";
import { NativeCode } from "../native";

const FILE_COUNT = 2;

const TABS: readonly NativeTab[] = [
	{ id: "files", label: "Files", icon: "file-text", count: FILE_COUNT },
	{ id: "history", label: "Task Run History", icon: "layers" },
];

/** The full .eval.ts as the file browser shows it: head + every test block. */
function evalFileLines(): string[] {
	const lines = [...SPEC_HEAD_LINES];
	for (const test of TESTS) {
		lines.push("");
		lines.push(...specBlockLines(test));
	}
	return lines;
}

const FILES: ReadonlyArray<{ path: string; name: string; dir: string; icon: string }> = [
	{ path: "files/inbound-8841.eml", name: "inbound-8841.eml", dir: "files", icon: "file-text" },
	{ path: "process-refund-request.eval.ts", name: "process-refund-request.eval.ts", dir: "", icon: "file-code" },
];

function fileSize(text: string): string {
	const bytes = new TextEncoder().encode(text).length;
	return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

function FilesTab() {
	const [selected, setSelected] = useState("process-refund-request.eval.ts");
	const [copied, setCopied] = useState(false);
	const content = selected.endsWith(".eval.ts") ? evalFileLines().join("\n") : INBOUND_EMAIL.join("\n");
	const lines = content.split("\n");
	const entry = FILES.find((f) => f.path === selected)!;
	return (
		<div className="flex max-h-[600px] min-h-[400px] flex-col overflow-hidden rounded-lg border border-border bg-card md:flex-row">
			{/* File list (TaskFileList) */}
			<div className="max-h-44 shrink-0 overflow-y-auto border-b border-border/60 md:max-h-none md:w-[280px] md:border-b-0 md:border-r">
				<div className="flex h-full flex-col">
					<div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-2">
						<span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Files</span>
						<span className="text-[10px] text-muted-foreground">{FILES.length + 1} items</span>
					</div>
					<div className="flex-1 overflow-y-auto">
						<div className="flex items-center gap-2 bg-muted/20 px-3 py-1.5 text-xs text-muted-foreground">
							<Icon name="folder" className="h-3.5 w-3.5" />
							<span className="font-medium">files/</span>
						</div>
						{FILES.filter((f) => f.dir === "files").map((f) => (
							<FileRow key={f.path} file={f} selected={selected} onSelect={setSelected} />
						))}
						{FILES.filter((f) => f.dir === "").map((f) => (
							<FileRow key={f.path} file={f} selected={selected} onSelect={setSelected} />
						))}
					</div>
				</div>
			</div>
			{/* Viewer (TaskFileViewer) */}
			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				<div className="flex items-center justify-between border-b border-border/60 bg-muted/30 px-3 py-2">
					<div className="flex min-w-0 items-center gap-3">
						<span className="truncate font-mono text-xs font-bold">{entry.name}</span>
						<span className="shrink-0 whitespace-nowrap text-[10px] text-muted-foreground">{fileSize(content)}</span>
					</div>
					<button
						type="button"
						className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
						onClick={() => {
							void navigator.clipboard?.writeText(content);
							setCopied(true);
							window.setTimeout(() => setCopied(false), 1500);
						}}
					>
						<Icon name={copied ? "check" : "copy"} className="h-3 w-3" />
						{copied ? "Copied" : "Copy"}
					</button>
				</div>
				<NativeCode lines={lines} />
			</div>
		</div>
	);
}

function FileRow({
	file,
	selected,
	onSelect,
}: {
	file: { path: string; name: string; dir: string; icon: string };
	selected: string;
	onSelect: (path: string) => void;
}) {
	const isSelected = selected === file.path;
	return (
		<button
			type="button"
			className={`w-full flex items-center gap-2 py-1.5 pr-3 text-xs transition-colors hover:bg-muted/40 ${
				isSelected ? "bg-muted/50 text-foreground" : "text-muted-foreground"
			} ${file.dir ? "pl-7" : "pl-3"}`}
			onClick={() => onSelect(file.path)}
		>
			<Icon name={file.icon} className="h-4 w-4 shrink-0 text-muted-foreground" />
			<span className="truncate font-mono">{file.name}</span>
		</button>
	);
}

export function SpecPanel({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const [tab, setTab] = useState("files");

	return (
		<div className="pl-native">
			<div className="mx-auto max-w-6xl flex flex-col">
				<TaskHead
					taskId="process-refund-request"
					adapter="supportInboxAdapter"
					badges={["process-refund-request/", `${FILE_COUNT} files`, `${Math.max(sim.history.length, 1)} task runs`]}
					onBack={() => go("verify")}
				/>

				<NativeTabStrip tabs={TABS} activeTab={tab} onSelectTab={setTab} />

				<div className="space-y-4 px-6 py-5">
					{tab === "files" && <FilesTab />}

					{tab === "history" && <RunHistoryTab sim={sim} go={go} />}
				</div>
			</div>
		</div>
	);
}

function RunHistoryTab({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const versions = ([1, 2, 3] as VersionId[]).filter((v) =>
		sim.history.some((h) => h.version === v),
	);
	// The loop, product-honestly: apo never changes the harness — you do,
	// then run again. Each "Run again" runs the next harness revision, and
	// the graded signal shows whether the change helped.
	const nextFix = FIXES.find((f) => !sim.appliedFixes.includes(f.id));
	const onRunAgain = () => {
		if (nextFix) sim.applyFix(nextFix.id);
		else sim.startRun();
	};
	const busy = sim.phase === "running" || sim.phase === "collecting" || sim.phase === "judging";
	return (
		<div className="space-y-4">
			<div className="flex items-center justify-between">
				<span className="text-[12px] text-muted-foreground">
					{nextFix ? (
						<>
							Fix your harness, then run again — the same suite grades every revision
							<span className="text-foreground"> ({sim.history.length} runs so far)</span>
						</>
					) : (
						<>
							<span className="font-medium text-success">The suite passes</span> — every future
							harness change runs against it
						</>
					)}
				</span>
				<button
					type="button"
					onClick={onRunAgain}
					disabled={busy}
					className="inline-flex h-8 items-center gap-1.5 border border-border bg-card px-3 text-[13px] font-normal text-foreground transition-colors hover:bg-card/80 disabled:opacity-50"
				>
					<Icon name="play" className="h-3.5 w-3.5" />
					{busy ? "Running…" : "Run again"}
				</button>
			</div>
			<NativePanel padded>
				<table className="w-full text-left text-[13px]">
					<thead>
						<tr className="border-b border-border text-[11px] uppercase tracking-wide text-muted-foreground">
							<th className="py-2 pr-4 font-medium">Run</th>
							<th className="py-2 pr-4 font-medium">Harness</th>
							<th className="py-2 pr-4 font-medium">Checks</th>
							<th className="py-2 pr-4 font-medium">Pass rate</th>
							<th className="py-2 font-medium">Created</th>
						</tr>
					</thead>
					<tbody>
						{versions.map((version) => {
							const row = sim.history.find((h) => h.version === version)!;
							const rate = Math.round((row.passed / row.total) * 100);
							return (
								<tr key={version} className="border-b border-border/40 last:border-b-0">
									<td className="py-2.5 pr-4">
										<button
											type="button"
											className={`inline-flex items-center gap-2 ${row.verdict === "pass" ? "text-success" : "text-destructive"}`}
											onClick={() => go("verify")}
										>
											{row.verdict === "pass" ? "✓" : "✗"} <span className="font-mono">{RUN_IDS[version].runId.slice(0, 18)}</span>
										</button>
									</td>
									<td className="py-2.5 pr-4 text-muted-foreground">v{version} · {VERSION_LABELS[version]}</td>
									<td className="py-2.5 pr-4">
										<span className="font-mono tabular-nums">{row.passed}/{row.total}</span>
									</td>
									<td className={`py-2.5 pr-4 font-mono tabular-nums ${rate < 70 ? "text-destructive" : "text-foreground"}`}>
										{rate}%
									</td>
									<td className="py-2.5 text-muted-foreground">Oct 11, 2026</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</NativePanel>
		</div>
	);
}
