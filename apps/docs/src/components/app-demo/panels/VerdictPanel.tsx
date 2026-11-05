/**
 * VerdictPanel — a port of the dashboard's task-run detail page, driven by
 * the prototype's simulation. One bordered box: run header (breadcrumb +
 * status pill + meta + action buttons), OutcomeSummary, tab strip
 * (Checks / Conversation History / Deliverables / Trace home), checks
 * list with expandable judge evidence.
 */
import { useEffect, useState } from "react";
import type { PanelId } from "../panel-bits";
import { TESTS, specBlockLines } from "../capability-sim";
import type { CapabilitySim } from "../use-capability-sim";
import { ConversationTab } from "./ConversationTab";
import {
	CheckRow,
	Icon,
	JudgeMeta,
	NativeCode,
	NativePanel,
	NativeTabStrip,
	OutcomeSummary,
	RunHead,
	RunHeadAction,
	type NativeTab,
} from "../native";

const TABS: readonly NativeTab[] = [
	{ id: "checks", label: "Checks", icon: "code-2", count: TESTS.length },
	{ id: "transcript", label: "Conversation History", icon: "message-square" },
	{ id: "deliverables", label: "Deliverables", icon: "file-text" },
];

export function VerdictPanel({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const [openTest, setOpenTest] = useState<string | null>(null);
	const [tab, setTab] = useState("checks");

	const waiting = sim.phase === "running" || sim.phase === "collecting";
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
	// Second-judge fact line over settled judged checks.
	const splitCount = settledRows.filter(
		(r) => sim.outcome(sim.version, r.testId).judge?.secondJudge?.mark.startsWith("✓✗"),
	).length;
	const corroborated =
		settledRows.filter((r) => sim.outcome(sim.version, r.testId).judge && !sim.outcome(sim.version, r.testId).judge?.secondJudge).length;

	const busy = waiting || judging;
	// Zero enabled tests is not a pass (verdictFor's rule).
	const status: "passed" | "failed" | "running" =
		busy ? "running" : liveTotal > 0 && passedCount === liveTotal ? "passed" : "failed";
	const statusLabel = busy ? "Running" : status === "passed" ? "Passed" : "Failed";

	return (
		<div className="pl-native">
			<div className="mx-auto max-w-6xl flex flex-col">
				<div className="border-b border-border bg-background">
					<RunHead
						statusLabel={statusLabel}
						status={status}
						batchId={sim.script.runId.replace("run_", "batch_")}
						taskId="process-refund-request"
						runId={sim.script.runId}
						startedAt="Oct 11, 2026, 2:03:22 PM"
						onBack={() => go("run")}
						actions={
							<>
								<RunHeadAction icon="list-checks" label="Task" onClick={() => go("specify")} />
								<RunHeadAction icon="external-link" label="Trace home" primary onClick={() => go("run")} />
							</>
						}
					/>

					<div className="border-t border-border">
						<OutcomeSummary
							passed={passedCount}
							failed={failedCount}
							errored={0}
							total={liveTotal}
							unit="checks"
							running={busy}
							metadata={[
								{ icon: "clock", value: busy ? "—" : sim.script.meta.duration, label: "duration" },
								{ icon: "dollar-sign", value: busy ? "—" : sim.script.meta.cost, label: "1.8k tok" },
								{ icon: "brain", value: busy ? "—" : "412 tok", label: "reasoning" },
								{ icon: "gauge", value: busy ? "—" : "42.5 tok/s med", label: "decode" },
							]}
						/>
					</div>

					<NativeTabStrip
						tabs={TABS}
						activeTab={tab}
						onSelectTab={setTab}
					/>
				</div>

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
									{corroborated + splitCount > 0 && (
										<span className="text-muted-foreground">
											Second judge: <span className="text-foreground">{corroborated}</span> corroborated
											{splitCount > 0 && <span className="text-warning"> · judges split on {splitCount}</span>}
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
									const sj = settled ? outcome.judge?.secondJudge : undefined;
									return (
										<CheckRow
											key={test.id}
											state={{
												id: test.id,
												passed: !enabled ? null : settled ? outcome.verdict === "pass" : null,
												judging: row?.status === "judging",
												reasoning: outcome.judge?.quote ?? test.preview,
												secondJudge:
													sj && sj.mark.startsWith("✓✗")
														? {
																primaryPass: outcome.verdict === "pass",
																secondPass: true,
																confidence: "0.99",
																split: true,
																title: sj.note,
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
											{!enabled ? null : row?.status === "pending" ? null : row?.status === "judging" ? (
												(outcome.judge?.reasoning ?? [])
													.slice(0, row.reasoningShown)
													.map((line, i) => (
														<p key={i} className="text-[13px] leading-relaxed text-foreground">
															{line}
														</p>
													))
											) : settled && test.kind === "code" ? (
												<NativeCode lines={specBlockLines(test)} failing={outcome.verdict === "fail"} />
											) : settled && outcome.judge ? (
												<>
													<NativeCode lines={specBlockLines(test)} failing={outcome.verdict === "fail"} />
													{test.assertionSummary.length > 0 && (
														<ul className="space-y-1">
															{test.assertionSummary.map((a) => (
																<li key={a} className="text-[12px] text-muted-foreground">
																	<span className={a === outcome.failedAssertion ? "text-destructive" : "text-success"}>
																		{a === outcome.failedAssertion ? "✗" : "✓"}
																	</span>{" "}
																	{a}
																</li>
															))}
														</ul>
													)}
													{outcome.judge.secondJudge && outcome.judge.secondJudge.mark.startsWith("✓✗") && (
														<p className="text-[12px] font-medium text-warning">
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
														tokens="412→100 tok"
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

function DeliverablesTab({ sim }: { sim: CapabilitySim }) {
	const reply = sim.script.reply.join("\n");
	return (
		<div className="space-y-4">
			<NativePanel padded>
				<div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
					<Icon name="file-text" className="h-3.5 w-3.5" />
					<span className="font-mono text-foreground">reply</span>
					<span className="ml-auto font-mono text-[11px]">{reply.split("\n").length} lines</span>
				</div>
				<p className="whitespace-pre-wrap border border-border px-4 py-3 text-[13px] leading-relaxed text-foreground">
					{reply}
				</p>
			</NativePanel>
			<NativePanel padded>
				<div className="mb-2 flex items-center gap-2 text-[12px] text-muted-foreground">
					<Icon name="file-text" className="h-3.5 w-3.5" />
					<span className="font-mono text-foreground">refund</span>
					<span className="ml-auto font-mono text-[11px]">6 keys</span>
				</div>
				<p className="whitespace-pre-wrap border border-border px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground">
					{sim.script.refundReceipt}
				</p>
			</NativePanel>
		</div>
	);
}
