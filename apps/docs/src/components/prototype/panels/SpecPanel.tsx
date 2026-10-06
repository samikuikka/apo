/**
 * SpecPanel — the suite, in the dashboard's vocabulary: the task-detail
 * header (folder icon, title, outline badges) above the checks-list
 * pattern. Every test is a CheckRow that expands to its own code block;
 * the toggle includes/excludes it from the verdict.
 */
import { useState } from "react";
import type { PanelId } from "../panel-bits";
import { SPEC_HEAD_LINES, TESTS, gradedSignal, specBlockLines, verdictFor } from "../capability-sim";
import type { CapabilitySim } from "../use-capability-sim";
import {
	CheckRow,
	CheckRowToggle,
	NativeCode,
	NativePanel,
	TaskHead,
} from "../native";

export function SpecPanel({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const [openRow, setOpenRow] = useState<string | null>(null);

	const live = verdictFor(sim.version, sim.enabled);
	const honest = gradedSignal(sim.version);
	const loweredTheStandard =
		sim.phase === "done" &&
		live.verdict === "pass" &&
		honest.passed < honest.total &&
		live.total < honest.total;

	return (
		<div className="pl-native">
			<div className="mx-auto max-w-6xl flex flex-col">
				<TaskHead
					taskId="process-refund-request"
					badges={[
						"supportInboxAdapter",
						"process-refund-request/",
						"2 files",
						`${TESTS.length} tests`,
						"deliverables: reply · refund",
					]}
				/>

				<div className="space-y-4 px-6 py-5">
					<div className="flex items-center justify-between text-[12px]">
						<div className="flex items-center gap-3">
							<span className="text-muted-foreground">
								<span className="font-medium text-foreground">{live.passed}</span>/{live.total} would pass
							</span>
							<span className="text-muted-foreground">
								{TESTS.filter((t) => t.kind === "code" && sim.enabled[t.id]).length} code ·{" "}
								{TESTS.filter((t) => t.kind === "judged" && sim.enabled[t.id]).length} judged
							</span>
						</div>
						{sim.phase === "done" && (
							<button
								type="button"
								onClick={() => go("verify")}
								className="text-muted-foreground transition-colors hover:text-foreground"
							>
								Last run →
							</button>
						)}
					</div>

					<NativePanel>
						<CheckRow
							state={{ id: "definition", passed: null, reasoning: "task() + turn() — the job and its input" }}
							expanded={openRow === "__definition"}
							onToggle={() => setOpenRow(openRow === "__definition" ? null : "__definition")}
						>
							<NativeCode lines={SPEC_HEAD_LINES} />
						</CheckRow>

						{TESTS.map((test) => {
							const enabled = sim.enabled[test.id];
							const outcome = sim.phase === "done" ? sim.outcome(sim.version, test.id) : undefined;
							const open = openRow === test.id;
							return (
								<CheckRow
									key={test.id}
									state={{
										id: test.id,
										passed: outcome ? outcome.verdict === "pass" : null,
										reasoning: test.assertionSummary[0] ?? "judged — LLM grades the deliverable",
										secondJudge:
											outcome?.judge?.secondJudge && enabled
												? {
														mark: outcome.judge.secondJudge.mark,
														title: outcome.judge.secondJudge.note,
													}
												: null,
										disabled: !enabled,
									}}
									expanded={open}
									onToggle={() => setOpenRow(open ? null : test.id)}
									actions={
										<CheckRowToggle
											on={enabled}
											label={`${enabled ? "Disable" : "Enable"} test ${test.id}`}
											onClick={() => sim.toggleTest(test.id)}
										/>
									}
								>
									<NativeCode lines={specBlockLines(test)} />
								</CheckRow>
							);
						})}
					</NativePanel>

					{loweredTheStandard && (
						<div className="border border-warning/30 bg-warning/5 px-4 py-3 text-[12px] leading-relaxed">
							<span className="text-warning">Green by subtraction.</span>{" "}
							<span className="text-foreground/80">
								This suite passes only because {honest.total - live.total} failing{" "}
								{honest.total - live.total === 1 ? "test is" : "tests are"} disabled — the graded
								signal still says {honest.passed}/{honest.total}. Disabling tests to go green is how
								suites rot.
							</span>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}
