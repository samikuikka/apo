/**
 * useCapabilitySim — drives the scripted fixture on a wall clock so the
 * landing-page panels behave like the product: a run streams spans in,
 * deliverables collect, tests settle one by one, judges stream reasoning
 * before their verdict, and applying a harness fix starts the next run.
 *
 * Ticks come from a Web Worker when possible — an occluded webview
 * starves page timers (down to ~1/min) while its event loop stays alive,
 * and worker timers keep firing, so the demo streams instead of
 * freezing. Each tick advances an ACCUMULATED clock by real elapsed time
 * × speed (so changing speed mid-run doesn't jump-cut), and the judging
 * schedule is snapshotted at run start (toggling tests mid-judging can't
 * mutate the live schedule). Reduced motion collapses to instant
 * completion.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import {
	buildRunScript,
	gradedSignal,
	outcomeFor,
	TESTS,
	versionForFixes,
	type FixId,
	type RunScript,
	type SpanScript,
	type TestId,
	type VersionId,
} from "./capability-sim";

export type RunPhase = "idle" | "running" | "collecting" | "judging" | "done";

export interface JudgeRowState {
	readonly testId: TestId;
	readonly status: "pending" | "judging" | "settled";
	/** How many reasoning excerpts have streamed in (judged tests only). */
	readonly reasoningShown: number;
}

export interface HistoryRow {
	readonly version: VersionId;
	readonly passed: number;
	readonly total: number;
	readonly verdict: "pass" | "fail";
}

interface SimState {
	readonly version: VersionId;
	readonly appliedFixes: readonly FixId[];
	readonly enabled: Readonly<Record<TestId, boolean>>;
	/** Enabled set frozen at run start — the judging schedule can't mutate mid-flight. */
	readonly judgingEnabled: Readonly<Record<TestId, boolean>>;
	readonly phase: RunPhase;
	/** Scaled ms since the run started; drives every derived state. */
	readonly elapsed: number;
	/** performance.now() when the current run started (0 when idle). */
	readonly startedAt: number;
	readonly history: readonly HistoryRow[];
}

type SimAction =
	| { type: "start"; startedAt: number }
	| { type: "tick"; elapsed: number }
	| { type: "toggle-test"; testId: TestId }
	| { type: "apply-fix"; fixId: FixId; startedAt: number }
	| { type: "reset-loop" };

/** Judge schedule: when each test settles, ms after judging begins. */
function judgeSchedule(enabled: Readonly<Record<TestId, boolean>>) {
	const rows: { testId: TestId; settleAt: number; kind: "code" | "judged" }[] = [];
	let t = 150;
	for (const test of TESTS) {
		if (!enabled[test.id]) continue;
		if (test.kind === "code") {
			rows.push({ testId: test.id, settleAt: t, kind: "code" });
			t += 260;
		} else {
			// Stream two reasoning excerpts, then the verdict card.
			rows.push({ testId: test.id, settleAt: t + 1200, kind: "judged" });
			t += 1700;
		}
	}
	return { rows, total: t + 250 };
}

function judgeTotal(enabled: Readonly<Record<TestId, boolean>>): number {
	return judgeSchedule(enabled).total;
}

/** Phase thresholds on the accumulated elapsed clock. */
function phaseAt(
	elapsed: number,
	script: RunScript,
	enabled: Readonly<Record<TestId, boolean>>,
): { phase: RunPhase; judgeClock: number } {
	const collectingAt = script.totalMs;
	const judgingAt = script.totalMs + 700;
	const doneAt = judgingAt + judgeTotal(enabled);
	if (elapsed >= doneAt) return { phase: "done", judgeClock: doneAt - judgingAt };
	if (elapsed >= judgingAt) return { phase: "judging", judgeClock: elapsed - judgingAt };
	if (elapsed >= collectingAt) return { phase: "collecting", judgeClock: 0 };
	return { phase: "running", judgeClock: 0 };
}

function upsertHistory(history: readonly HistoryRow[], row: HistoryRow): HistoryRow[] {
	const existing = history.find((h) => h.version === row.version);
	if (existing && existing.passed === row.passed && existing.verdict === row.verdict) {
		return history;
	}
	if (existing) {
		return history.map((h) => (h.version === row.version ? row : h));
	}
	return [...history, row];
}

function withHistory(state: SimState): SimState {
	const { passed, total } = gradedSignal(state.version);
	return {
		...state,
		history: upsertHistory(state.history, {
			version: state.version,
			passed,
			total,
			verdict: passed === total ? "pass" : "fail",
		}),
	};
}

function startState(state: SimState, startedAt: number): SimState {
	return {
		...state,
		phase: "running",
		elapsed: 0,
		startedAt,
		judgingEnabled: { ...state.enabled },
	};
}

function initialState(): SimState {
	// The page opens on a completed v1 run: every panel has something real
	// to show immediately, and the visitor's first act is usually "re-run"
	// or "apply the fix".
	const enabled = Object.fromEntries(TESTS.map((t) => [t.id, true])) as Record<TestId, boolean>;
	const script = buildRunScript(1);
	return withHistory({
		version: 1,
		appliedFixes: [],
		enabled,
		judgingEnabled: enabled,
		phase: "done",
		elapsed: script.totalMs + 700 + judgeTotal(enabled) + 9999,
		startedAt: 0,
		history: [],
	});
}

function reducer(state: SimState, action: SimAction): SimState {
	switch (action.type) {
		case "start":
			return startState(state, action.startedAt);
		case "tick": {
			if (state.phase === "idle" || state.phase === "done") return state;
			const script = buildRunScript(state.version);
			const { phase } = phaseAt(action.elapsed, script, state.judgingEnabled);
			if (phase === "done") {
				return withHistory({ ...state, elapsed: action.elapsed, phase: "done" });
			}
			return { ...state, elapsed: action.elapsed, phase };
		}
		case "toggle-test":
			return {
				...state,
				enabled: { ...state.enabled, [action.testId]: !state.enabled[action.testId] },
			};
		case "apply-fix": {
			if (state.appliedFixes.includes(action.fixId)) return state;
			const appliedFixes = [...state.appliedFixes, action.fixId];
			// The fix lands and the loop immediately re-runs the same suite.
			return startState(
				{ ...state, appliedFixes, version: versionForFixes(appliedFixes) },
				action.startedAt,
			);
		}
		case "reset-loop":
			// Start over: v1 complete again, history cleared.
			return withHistory({ ...initialState(), enabled: state.enabled, judgingEnabled: state.enabled });
	}
}

export interface VisibleSpan extends SpanScript {
	readonly status: "active" | "done";
}

const TICK_MS = 50;

export function useCapabilitySim(reducedMotion: boolean) {
	const [state, dispatch] = useReducer(reducer, undefined, initialState);
	const speedRef = useRef(1);

	const startRun = useCallback(() => {
		dispatch({ type: "start", startedAt: performance.now() });
	}, []);
	const toggleTest = useCallback((testId: TestId) => dispatch({ type: "toggle-test", testId }), []);
	const applyFix = useCallback((fixId: FixId) => {
		dispatch({ type: "apply-fix", fixId, startedAt: performance.now() });
	}, []);
	const resetLoop = useCallback(() => dispatch({ type: "reset-loop" }), []);
	const setSpeed = useCallback((speed: number) => {
		speedRef.current = speed;
	}, []);

	// The single driver. The elapsed clock ACCUMULATES per tick (real gap ×
	// speed), so a mid-run speed change is a smooth re-rate, not a jump.
	useEffect(() => {
		if (reducedMotion) {
			if (state.phase === "running" || state.phase === "collecting" || state.phase === "judging") {
				dispatch({ type: "tick", elapsed: Number.POSITIVE_INFINITY });
			}
			return;
		}
		if (state.phase === "idle" || state.phase === "done") return;
		let last = performance.now();
		let elapsed = state.elapsed;
		const fire = () => {
			const now = performance.now();
			elapsed += (now - last) * speedRef.current;
			last = now;
			dispatch({ type: "tick", elapsed });
		};
		fire();

		let worker: Worker | null = null;
		let fallbackId = 0;
		let workerUrl = "";
		try {
			const src = `setInterval(() => postMessage(0), ${TICK_MS});`;
			workerUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
			worker = new Worker(workerUrl);
			worker.onmessage = fire;
		} catch {
			fallbackId = window.setInterval(fire, TICK_MS);
		}
		// Catch up the instant the tab becomes visible again after throttling.
		const onVisible = () => {
			if (document.visibilityState === "visible") fire();
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			worker?.terminate();
			if (workerUrl) URL.revokeObjectURL(workerUrl);
			window.clearInterval(fallbackId);
			document.removeEventListener("visibilitychange", onVisible);
		};
		// startedAt changes on start/apply-fix and re-arms the effect.
	}, [state.phase, state.startedAt, reducedMotion]);

	const script = useMemo(() => buildRunScript(state.version), [state.version]);

	const { phase, judgeClock } = phaseAt(state.elapsed, script, state.judgingEnabled);

	const visibleSpans: VisibleSpan[] = useMemo(() => {
		if (state.phase === "idle") return [];
		const streamable = state.phase === "running" || state.phase === "collecting";
		if (!streamable) {
			return script.spans.map((s) => ({ ...s, status: "done" as const }));
		}
		return script.spans
			.filter((s) => s.startAt <= state.elapsed)
			.map((s) => ({
				...s,
				status: state.elapsed >= s.startAt + s.durMs ? ("done" as const) : ("active" as const),
			}));
	}, [script, state.elapsed, state.phase]);

	const judgeRows: JudgeRowState[] = useMemo(() => {
		if (phase !== "judging" && phase !== "done") {
			return TESTS.filter((t) => state.judgingEnabled[t.id]).map((t) => ({
				testId: t.id,
				status: "pending" as const,
				reasoningShown: 0,
			}));
		}
		const { rows } = judgeSchedule(state.judgingEnabled);
		return rows.map((row) => {
			if (phase === "done" || judgeClock >= row.settleAt) {
				return { testId: row.testId, status: "settled" as const, reasoningShown: 2 };
			}
			if (row.kind === "judged" && judgeClock >= row.settleAt - 1200) {
				const elapsed = judgeClock - (row.settleAt - 1200);
				return {
					testId: row.testId,
					status: "judging" as const,
					reasoningShown: Math.min(2, Math.floor(elapsed / 500)),
				};
			}
			return { testId: row.testId, status: "pending" as const, reasoningShown: 0 };
		});
	}, [state.judgingEnabled, judgeClock, phase]);

	const elapsedLabel = useMemo(() => {
		const ms = Math.min(state.elapsed, script.totalMs);
		return `${(Math.max(ms, 0) / 1000).toFixed(1)}s`;
	}, [script.totalMs, state.elapsed]);

	return {
		// state
		version: state.version,
		appliedFixes: state.appliedFixes,
		enabled: state.enabled,
		phase,
		history: state.history,
		startedAt: state.startedAt,
		// derived
		script,
		visibleSpans,
		judgeRows,
		elapsedLabel,
		outcome: outcomeFor,
		// actions
		startRun,
		toggleTest,
		applyFix,
		resetLoop,
		setSpeed,
	};
}

export type CapabilitySim = ReturnType<typeof useCapabilitySim>;
