/**
 * RunPanel — run the real harness, watch it work, then read the trace it
 * leaves behind. One surface, two views of the same spans: the live
 * stream while the run is in flight, the to-scale waterfall once it
 * settles (a manual Stream/Waterfall toggle overrides). The selected
 * span's payload sits on the right; the input email is the empty state,
 * the deliverables land at the end.
 */
import { useState } from "react";
import { CodeLine, StatusPill, formatMs, spanGlyph, type PanelId } from "../panel-bits";
import { INBOUND_EMAIL } from "../capability-sim";
import type { CapabilitySim, VisibleSpan } from "../use-capability-sim";

type View = "stream" | "waterfall";

export function RunPanel({ sim, go }: { sim: CapabilitySim; go: (panel: PanelId) => void }) {
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [speed, setSpeed] = useState(1);
	const [viewOverride, setViewOverride] = useState<View | null>(null);

	const running = sim.phase === "running" || sim.phase === "collecting";
	// Natural pairing: the stream while it happens, the trace once it's history.
	const view: View = viewOverride ?? (running ? "stream" : "waterfall");
	const selected: VisibleSpan | undefined =
		sim.visibleSpans.find((s) => s.id === selectedId) ??
		(sim.visibleSpans.length > 0 && !running ? sim.visibleSpans[sim.visibleSpans.length - 1] : undefined);
	const showDeliverables = sim.phase === "collecting" || sim.phase === "judging" || sim.phase === "done";
	const total = Math.max(sim.script.totalMs, 1);
	const failingJudged =
		sim.phase === "done" &&
		sim.outcome(sim.version, "reply-addresses-the-complaint").verdict === "fail";

	return (
		<div className="pl-native pl-panel">
			<header className="pl-panel__head">
				<div className="pl-panel__headtitle">
					<h3 className="pl-panel__h3">process-refund-request</h3>
					<span className="pl-panel__sub">
						v{sim.version} · {sim.script.runId} · trace {sim.script.traceId}
					</span>
				</div>
				<div className="pl-panel__headmeta">
					<StatusPill phase={sim.phase} />
					<span className="pl-metric">{sim.elapsedLabel}</span>
					<span className="pl-metric">{sim.tokensSoFar.toLocaleString("en-US")} tok</span>
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
						{sim.phase === "idle" ? "Run task" : running ? "Restart" : "Re-run"}
					</button>
				</div>
			</header>

			<div className="pl-panel__body pl-run">
				<section className="pl-run__stream" aria-label="Run spans">
					<div className="pl-run__streamhead">
						<span
							className="pl-speed"
							role="group"
							aria-label="Span view"
							style={{ gap: 0, border: "none" }}
						>
							{(["stream", "waterfall"] as const).map((v) => (
								<button
									key={v}
									type="button"
									className={`pl-speed__btn${view === v ? " pl-speed__btn--on" : ""}`}
									aria-pressed={view === v}
									onClick={() => setViewOverride(v)}
								>
									{v === "stream" ? "Stream" : "Waterfall"}
								</button>
							))}
						</span>
						<span>{view === "stream" ? "latency" : `0s … ${(total / 1000).toFixed(1)}s`}</span>
					</div>

					{sim.visibleSpans.length === 0 && view === "stream" && (
						<div className="pl-run__empty">
							<p>The harness hasn't run yet.</p>
							<p className="pl-run__emptydim">
								Press <strong>Run task</strong> — apo drives your adapter turn by turn and
								records every generation and tool call as a span.
							</p>
						</div>
					)}

					{view === "stream" &&
						sim.visibleSpans.map((span) => (
							<button
								key={span.id}
								type="button"
								className={`pl-spanrow${span.status === "active" ? " pl-spanrow--active" : ""}${
									selected?.id === span.id ? " pl-spanrow--sel" : ""
								}`}
								style={{ paddingLeft: `${0.9 + span.depth * 1.1}rem` }}
								onClick={() => setSelectedId(span.id)}
							>
								<span className={`pl-spanrow__glyph pl-spanrow__glyph--${span.kind}`} aria-hidden="true">
									{spanGlyph(span.kind)}
								</span>
								<span className="pl-spanrow__name">{span.name}</span>
								<span className="pl-spanrow__kind">
									{span.kind === "generation" ? span.model?.split("/")[1] : "tool"}
								</span>
								<span
									className={`pl-spanrow__latency${span.status === "active" ? " pl-spanrow__latency--live" : ""}`}
								>
									{span.status === "active" ? "…" : formatMs(span.durMs)}
								</span>
							</button>
						))}

					{view === "waterfall" &&
						(sim.visibleSpans.length === 0 ? (
							<div className="pl-run__empty">
								<p>No spans yet — run the task.</p>
							</div>
						) : (
							sim.visibleSpans.map((span) => {
								const isEvidence = failingJudged && span.id === "span-6";
								return (
									<button
										key={span.id}
										type="button"
										className={`pl-wfrow${selected?.id === span.id ? " pl-wfrow--sel" : ""}${
											isEvidence ? " pl-wfrow--evidence" : ""
										}`}
										onClick={() => setSelectedId(span.id)}
									>
										<span className="pl-wfrow__label" style={{ paddingLeft: `${span.depth * 0.9}rem` }}>
											<span
												className={`pl-spanrow__glyph pl-spanrow__glyph--${span.kind}`}
												aria-hidden="true"
											>
												{spanGlyph(span.kind)}
											</span>
											{span.name}
											{isEvidence && <span className="pl-wfrow__evmark">✗ graded FAIL</span>}
										</span>
										<span className="pl-wfrow__track">
											<span
												className={`pl-wfrow__bar pl-wfrow__bar--${span.kind}${
													span.status === "active" ? " pl-wfrow__bar--live" : ""
												}`}
												style={{
													marginLeft: `${(span.startAt / total) * 100}%`,
													width: `${Math.max((span.durMs / total) * 100, 1.2)}%`,
												}}
											/>
										</span>
										<span className="pl-wfrow__dur">{formatMs(span.durMs)}</span>
									</button>
								);
							})
						))}

					{sim.phase === "collecting" && (
						<div className="pl-run__collecting">
							<span className="pl-spanrow__glyph" aria-hidden="true">⤓</span>
							collecting deliverables: reply, refund
						</div>
					)}
					{showDeliverables && (
						<div className="pl-deliv">
							<div className="pl-deliv__head">deliverable · reply</div>
							<pre className="pl-deliv__text">{sim.script.reply.join("\n")}</pre>
							<div className="pl-deliv__foot">
								<span className="pl-metric">refund · ref_9xk2m4 · $84.00</span>
								<button type="button" className="pl-linkbtn" onClick={() => go("verify")}>
									Open the verdict →
								</button>
							</div>
						</div>
					)}
				</section>

				<section className="pl-run__detail" aria-label="Span detail">
					{selected ? (
						<SpanDetail span={selected} failingJudged={failingJudged} go={go} />
					) : (
						<div className="pl-run__input">
							<div className="pl-run__inputhead">first turn · files/inbound-8841.eml</div>
							<pre className="pl-run__inputtext">{INBOUND_EMAIL.join("\n")}</pre>
							<p className="pl-run__inputnote">
								<code>turn()</code> feeds this to the agent once — click a span as it appears.
							</p>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}

function SpanDetail({
	span,
	failingJudged,
	go,
}: {
	span: VisibleSpan;
	failingJudged: boolean;
	go: (panel: PanelId) => void;
}) {
	return (
		<div className="pl-spandetail">
			<header className="pl-spandetail__head">
				<span className={`pl-spanrow__glyph pl-spanrow__glyph--${span.kind}`} aria-hidden="true">
					{spanGlyph(span.kind)}
				</span>
				<h4 className="pl-spandetail__name">{span.name}</h4>
				<span className="pl-tag">{span.kind}</span>
			</header>
			<div className="pl-spandetail__meta">
				{span.model && <span className="pl-metric">{span.model}</span>}
				{span.tokens !== undefined && <span className="pl-metric">{span.tokens} tok</span>}
				<span className="pl-metric">{formatMs(span.durMs)}</span>
			</div>
			{span.input && (
				<section className="pl-spandetail__section">
					<h5 className="pl-spandetail__label">input</h5>
					<div className="pl-code">
						{span.input.split("\n").map((line, i) => (
							<CodeLine key={i} line={line} />
						))}
					</div>
				</section>
			)}
			{span.output && (
				<section className="pl-spandetail__section">
					<h5 className="pl-spandetail__label">output</h5>
					<div className="pl-code">
						{span.output.split("\n").map((line, i) => (
							<CodeLine key={i} line={line} />
						))}
					</div>
				</section>
			)}
			{span.id === "span-6" && failingJudged && (
				<p className="pl-trace__evidencenote">
					This generation produced the <code>reply</code> the judges graded.{" "}
					<button type="button" className="pl-linkbtn" onClick={() => go("verify")}>
						back to the verdict →
					</button>
				</p>
			)}
		</div>
	);
}
