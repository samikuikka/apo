/**
 * LoopPanel — harness engineering. The fix catalog turns judge evidence
 * into concrete harness changes; applying one starts the next run of the
 * same suite, and the convergence strip carries the graded signal
 * forward until the loop closes at 5/5.
 *
 * apo never makes the change itself — the verdict and evidence are the
 * control signal; the change belongs to the human or coding agent.
 */
import { FIXES, TESTS, VERSION_LABELS, type FixDef, type VersionId } from "../capability-sim";
import { VerdictChip, type PanelId } from "../panel-bits";
import type { CapabilitySim } from "../use-capability-sim";

export function LoopPanel({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const allApplied = sim.version === 3;
	const converged = allApplied && sim.phase === "done" && sim.history.some((h) => h.version === 3 && h.verdict === "pass");
	const running = sim.phase === "running" || sim.phase === "collecting" || sim.phase === "judging";

	return (
		<div className="pl-native pl-panel">
			<header className="pl-panel__head">
				<div className="pl-panel__headtitle">
					<h3 className="pl-panel__h3">Harness engineering</h3>
					<span className="pl-panel__sub">same suite · graded signal · converge</span>
				</div>
				<div className="pl-panel__headmeta">
					{running && (
						<button type="button" className="pl-linkbtn" onClick={() => go("run")}>
							v{sim.version} is running — watch it →
						</button>
					)}
					{converged && (
						<button type="button" className="pl-linkbtn" onClick={sim.resetLoop}>
							start over from v1 ↺
						</button>
					)}
				</div>
			</header>

			<div className="pl-panel__body pl-loop">
				<section className="pl-loop__left">
					<h4 className="pl-side__title">Convergence</h4>
					<p className="pl-side__text">
						Every row is the same specification — only the harness changed.
					</p>
					<div className="pl-loop__versions">
						{([1, 2, 3] as VersionId[]).map((version) => {
							const row = sim.history.find((h) => h.version === version);
							return (
								<div
									key={version}
									className={`pl-vrow${sim.version === version ? " pl-vrow--current" : ""}${
										row ? "" : " pl-vrow--future"
									}`}
								>
									<span className="pl-vrow__chip">v{version}</span>
									<span className="pl-vrow__label">{VERSION_LABELS[version]}</span>
									{row ? (
										<>
											<span className="pl-vrow__bar" aria-hidden="true">
												{TESTS.map((t) => {
													const outcome = sim.outcome(version, t.id);
													return (
														<span
															key={t.id}
															className={`pl-vrow__seg pl-vrow__seg--${outcome.verdict}`}
														/>
													);
												})}
											</span>
											<span className="pl-vrow__grade">
												{row.passed}/{row.total}
											</span>
											<VerdictChip verdict={row.verdict} />
										</>
									) : (
										<span className="pl-vrow__notrun">not run yet</span>
									)}
								</div>
							);
						})}
					</div>
					{converged && (
						<div className="pl-loop__converged">
							<strong>The loop closed.</strong> Two changes, both read off judge evidence —
							3/5 → 4/5 → 5/5. The suite now guards this capability: every future harness
							change runs against it.
						</div>
					)}
					<p className="pl-side__text pl-loop__belief">
						apo never edits the harness itself — the verdict plus evidence is the control
						signal; the change is yours (or your coding agent's).
					</p>
				</section>

				<section className="pl-loop__right">
					<h4 className="pl-side__title">From evidence to change</h4>
					<p className="pl-side__text">
						Each fix answers a judge quote. Apply it and the suite re-runs.
					</p>
					<div className="pl-loop__fixes">
						{FIXES.map((fix) => (
							<FixCard key={fix.id} sim={sim} fix={fix} />
						))}
					</div>
				</section>
			</div>
		</div>
	);
}

function FixCard({ sim, fix }: { sim: CapabilitySim; fix: FixDef }) {
	const applied = sim.appliedFixes.includes(fix.id);
	const blocked = !applied && fix.requires !== undefined && !sim.appliedFixes.includes(fix.requires);
	const running = sim.phase === "running" || sim.phase === "collecting" || sim.phase === "judging";
	const isRunningThis = applied && running && sim.version === (fix.id === "tone-guide" ? 3 : 2);

	return (
		<article
			className={`pl-fix${applied ? " pl-fix--applied" : ""}${blocked ? " pl-fix--locked" : ""}`}
		>
			<header className="pl-fix__head">
				<h5 className="pl-fix__title">{fix.title}</h5>
				{applied ? (
					<span className="pl-fix__state">applied ✓{isRunningThis ? " · re-running…" : ""}</span>
				) : blocked ? (
					<span className="pl-fix__state pl-fix__state--locked">after the wiring fix</span>
				) : (
					<button type="button" className="pl-fix__apply" onClick={() => sim.applyFix(fix.id)}>
						Apply fix → re-run
					</button>
				)}
			</header>
			<code className="pl-fix__change">{fix.change}</code>
			<blockquote className="pl-fix__evidence">
				<span className="pl-fix__evidlabel">evidence</span>
				{fix.evidence}
			</blockquote>
			<p className="pl-fix__rationale">{fix.rationale}</p>
		</article>
	);
}
