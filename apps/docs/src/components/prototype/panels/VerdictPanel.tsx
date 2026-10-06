/**
 * VerdictPanel — a port of the dashboard's task-run detail page, driven by
 * the prototype's simulation: run header (breadcrumb + status pill),
 * OutcomeSummary, the real tab strip (Checks / Conversation History /
 * Deliverables), and the checks list with expandable judge evidence.
 */
import { useEffect, useState } from "react";
import type { PanelId } from "../panel-bits";
import { INBOUND_EMAIL, TESTS } from "../capability-sim";
import type { CapabilitySim } from "../use-capability-sim";
import {
	CheckRow,
	Icon,
	JudgeMeta,
	NativePanel,
	NativeTabStrip,
	OutcomeSummary,
	RunHead,
	type NativeTab,
} from "../native";

const TABS: readonly NativeTab[] = [
	{ id: "checks", label: "Checks", icon: "square-code", count: TESTS.length },
	{ id: "transcript", label: "Conversation History", icon: "message-square" },
	{ id: "deliverables", label: "Deliverables", icon: "file-text" },
];

export function VerdictPanel({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const [openTest, setOpenTest] = useState<string | null>(null);
	const [tab, setTab] = useState("checks");

	const waiting = sim.phase === "idle" || sim.phase === "running" || sim.phase === "collecting";
	const judging = sim.phase === "judging";

	// When a run's verdict lands, open the first failing check — the one a
	// visitor (or a coding agent) reads first.
	useEffect(() => {
		if (sim.phase !== "done") return;
		const firstFail = TESTS.find(
			(t) => sim.enabled[t.id] && sim.outcome(sim.version, t.id).verdict === "fail",
		);
		setOpenTest(firstFail?.id ?? TESTS[0]!.id);
	}, [sim.phase, sim.version, sim.startedAt]);

	const settledRows = sim.judgeRows.filter((r) => r.status === "settled");
	const passedCount = settledRows.filter((r) => sim.outcome(sim.version, r.testId).verdict === "pass").length;
	const failedCount = settledRows.length - passedCount;
	const disabledCount = TESTS.filter((t) => !sim.enabled[t.id]).length;
	const liveTotal = TESTS.filter((t) => sim.enabled[t.id]).length;

	const status = waiting ? "running" : judging ? "judging" : passedCount === liveTotal ? "passed" : "failed";
	const statusLabel = waiting ? "Running" : judging ? "Judging" : status === "passed" ? "Passed" : "Failed";

	return (
		<div className="pl-native">
			<div className="mx-auto max-w-6xl flex flex-col">
				<RunHead
					statusLabel={statusLabel}
					status={status}
					batchId={sim.script.runId.replace("run_", "batch_")}
					taskId="process-refund-request"
					runId={sim.script.runId}
					onBack={() => go("run")}
				/>

				<div className="border-t border-border">
					<OutcomeSummary
						passed={passedCount}
						failed={failedCount}
						errored={0}
						total={liveTotal}
						unit="checks"
						running={waiting || judging}
						metadata={[
							{ icon: "clock", value: waiting ? "—" : sim.script.meta.duration, label: "duration" },
							{ icon: "dollar-sign", value: waiting ? "—" : sim.script.meta.cost, label: sim.script.meta.tokens },
							{ icon: "brain", value: waiting ? "—" : "412", label: "reasoning" },
							{ icon: "timer", value: waiting ? "—" : "2.2s", label: "slowest call" },
							{
								icon: "external-link",
								value: sim.script.traceId,
								label: "trace",
								onClick: () => go("run"),
							},
						]}
					/>
				</div>

				<NativeTabStrip tabs={TABS} activeTab={tab} onSelectTab={setTab} />

				<div className="space-y-4 px-6 py-5">
					{tab === "checks" && (
						<>
							<div className="flex items-center justify-between text-[12px]">
								<div className="flex items-center gap-3">
									<span className="text-muted-foreground">
										<span className="font-medium text-foreground">{passedCount}</span>/{liveTotal} passed
									</span>
									{failedCount > 0 && (
										<span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-destructive">
											{failedCount} failed
										</span>
									)}
									{disabledCount > 0 && (
										<span className="text-muted-foreground">
											<span className="text-foreground">{disabledCount}</span> disabled in spec
										</span>
									)}
								</div>
								<span className="text-muted-foreground/60">Click to expand</span>
							</div>

							<NativePanel>
								{TESTS.map((test) => {
									const enabled = sim.enabled[test.id];
									const row = sim.judgeRows.find((r) => r.testId === test.id);
									const outcome = sim.outcome(sim.version, test.id);
									const settled = enabled && row?.status === "settled";
									const open = openTest === test.id;
									return (
										<CheckRow
											key={test.id}
											state={{
												id: test.id,
												passed: !enabled ? false : settled ? outcome.verdict === "pass" : null,
												judging: row?.status === "judging",
												reasoning: outcome.judge?.quote ?? test.assertionSummary[0],
												secondJudge:
													settled && outcome.judge?.secondJudge
														? {
																mark: outcome.judge.secondJudge.mark,
																title: outcome.judge.secondJudge.note,
															}
														: null,
												disabled: !enabled,
											}}
											expanded={open}
											onToggle={() => setOpenTest(open ? null : test.id)}
											actions={
												!enabled ? (
													<button
														type="button"
														className="h-6 px-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
														onClick={() => {
															sim.toggleTest(test.id);
															go("specify");
														}}
													>
														Re-enable
													</button>
												) : undefined
											}
										>
											{!enabled ? (
												<p className="text-[12px] text-muted-foreground">
													Disabled in the spec — re-enable it to include it in the verdict.
												</p>
											) : row?.status === "pending" ? (
												<p className="text-[12px] text-muted-foreground">Waiting for its turn…</p>
											) : row?.status === "judging" ? (
												(outcome.judge?.reasoning ?? [])
													.slice(0, row.reasoningShown)
													.map((line, i) => (
														<p key={i} className="text-[13px] leading-relaxed text-foreground">
															{line}
														</p>
													))
											) : settled && test.kind === "code" ? (
												<ul className="space-y-1">
													{test.assertionSummary.map((a) => (
														<li key={a} className="text-[12px] text-muted-foreground">
															<span className="text-success">✓</span> {a}
														</li>
													))}
												</ul>
											) : settled && outcome.judge ? (
												<>
													{outcome.judge.secondJudge && (
														<p
															className={`text-[12px] ${
																outcome.judge.secondJudge.mark.startsWith("✓✗")
																	? "font-medium text-warning"
																	: "text-muted-foreground"
															}`}
														>
															{outcome.judge.secondJudge.note}
														</p>
													)}
													<p
														className={`whitespace-pre-wrap text-[13px] leading-relaxed ${
															outcome.verdict === "pass" ? "text-foreground" : "text-destructive"
														}`}
													>
														{outcome.judge.quote}
													</p>
													<JudgeMeta
														model={outcome.judge.model}
														latency="1.4s"
														tokens="512 tok"
														onViewInTrace={() => go("run")}
													/>
												</>
											) : null}
										</CheckRow>
									);
								})}
							</NativePanel>
						</>
					)}

					{tab === "transcript" && <ConversationTab sim={sim} />}

					{tab === "deliverables" && <DeliverablesTab sim={sim} />}
				</div>
			</div>
		</div>
	);
}

function ConversationTab({ sim }: { sim: CapabilitySim }) {
	const reply = sim.script.reply.join("\n");
	return (
		<NativePanel padded>
			<div className="space-y-3">
				<div className="border border-border px-4 py-3">
					<div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
						<Icon name="message-square" className="h-3 w-3" />
						User · turn()
					</div>
					<p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">
						{INBOUND_EMAIL.join("\n")}
					</p>
				</div>
				{sim.visibleSpans.map((span) => (
					<div key={span.id} className="border border-border px-4 py-3">
						<div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
							<Icon name="cpu" className="h-3 w-3" />
							<span className="font-mono">{span.kind === "generation" ? span.model : span.name}</span>
							<span className="text-muted-foreground/50">·</span>
							<span>{span.name}</span>
						</div>
						<p className="whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">
							{span.output}
						</p>
					</div>
				))}
				<div className="border border-border px-4 py-3">
					<div className="mb-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
						<Icon name="message-square" className="h-3 w-3" />
						Assistant · deliverable reply
					</div>
					<p className="whitespace-pre-wrap text-[13px] leading-relaxed text-foreground">{reply}</p>
				</div>
			</div>
		</NativePanel>
	);
}

function DeliverablesTab({ sim }: { sim: CapabilitySim }) {
	return (
		<div className="space-y-4">
			<NativePanel padded>
				<div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
					<Icon name="file-text" className="h-3.5 w-3.5" />
					<span className="font-mono text-foreground">reply</span>
					<span className="text-muted-foreground/50">·</span>
					<span>the customer-facing email the judges graded</span>
				</div>
				<p className="whitespace-pre-wrap border border-border px-4 py-3 text-[13px] leading-relaxed text-foreground">
					{sim.script.reply.join("\n")}
				</p>
			</NativePanel>
			<NativePanel padded>
				<div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
					<Icon name="file-text" className="h-3.5 w-3.5" />
					<span className="font-mono text-foreground">refund</span>
					<span className="text-muted-foreground/50">·</span>
					<span>the action the agent took</span>
				</div>
				<p className="whitespace-pre-wrap border border-border px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground">
					{sim.script.refundReceipt}
				</p>
			</NativePanel>
		</div>
	);
}
