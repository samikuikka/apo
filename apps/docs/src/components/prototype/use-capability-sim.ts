/**
 * useCapabilitySim — drives the scripted fixture on a wall clock so the
 * landing-page panels behave like the product: a run streams spans in,
 * deliverables collect, tests settle one by one, judges stream reasoning
 * before their verdict, and applying a harness fix starts the next run.
 *
 * The sim clock is ABSOLUTE: every tick recomputes elapsed from
 * performance.now() minus the run's start, so heavy timer throttling (an
 * occluded webview can clamp timers to one firing per minute) only delays
 * renders — the run itself can never fall behind wall-clock schedule.
 * Reduced motion collapses the timeline to instant completion.
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
function judgeSchedule(script: RunScript, enabled: Readonly<Record<TestId, boolean>>) {
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

function judgeTotal(script: RunScript, enabled: Readonly<Record<TestId, boolean>>): number {
	return judgeSchedule(script, enabled).total;
}

/** Phase thresholds on the absolute elapsed clock. */
function phaseAt(elapsed: number, script: RunScript, enabled: Readonly<Record<TestId, boolean>>): {
	phase: RunPhase;
	judgeClock: number;
} {
	const collectingAt = script.totalMs;
	const judgingAt = script.totalMs + 700;
	const doneAt = judgingAt + judgeTotal(script, enabled);
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
		phase: "done",
		elapsed: script.totalMs + 700 + judgeTotal(script, enabled) + 9999,
		startedAt: 0,
		history: [],
	});
}

function reducer(state: SimState, action: SimAction): SimState {
	switch (action.type) {
		case "start":
			return { ...state, phase: "running", elapsed: 0, startedAt: action.startedAt };
		case "tick": {
			if (state.phase === "idle" || state.phase === "done") return state;
			const script = buildRunScript(state.version);
			const { phase } = phaseAt(action.elapsed, script, state.enabled);
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
			return {
				...state,
				appliedFixes,
				version: versionForFixes(appliedFixes),
				phase: "running",
				elapsed: 0,
				startedAt: action.startedAt,
			};
		}
		case "reset-loop": {
			const enabled = state.enabled;
			return withHistory({ ...initialState(), enabled, history: state.history });
		}
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

	// The single driver: while a run is in flight, recompute the absolute
	// elapsed from the wall clock. Ticks come from a Web Worker when
	// possible — an occluded webview starves page timers (down to ~1/min)
	// while its event loop stays alive, and worker timers keep firing, so
	// the demo streams instead of freezing. Reduced motion skips the
	// theatre and lands on the completed state directly.
	useEffect(() => {
		if (reducedMotion) {
			if (state.phase === "running" || state.phase === "collecting" || state.phase === "judging") {
				dispatch({ type: "tick", elapsed: Number.POSITIVE_INFINITY });
			}
			return;
		}
		if (state.phase === "idle" || state.phase === "done") return;
		const fire = () => {
			const elapsed = (performance.now() - state.startedAt) * speedRef.current;
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
		// startedAt is the dependency that changes on start/apply-fix; the
		// elapsed reads inside fire() are always fresh from performance.now().
	}, [state.phase, state.startedAt, reducedMotion]);

	const script = useMemo(() => buildRunScript(state.version), [state.version]);

	const { phase, judgeClock } = phaseAt(state.elapsed, script, state.enabled);

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
			return TESTS.filter((t) => state.enabled[t.id]).map((t) => ({
				testId: t.id,
				status: "pending" as const,
				reasoningShown: 0,
			}));
		}
		const { rows } = judgeSchedule(script, state.enabled);
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
	}, [script, state.enabled, judgeClock, phase]);

	const elapsedLabel = useMemo(() => {
		if (state.phase === "idle") return "0.0s";
		const ms = Math.min(state.elapsed, script.totalMs);
		return `${(ms / 1000).toFixed(1)}s`;
	}, [script.totalMs, state.elapsed, state.phase]);

	const tokensSoFar = useMemo(() => {
		if (state.phase === "idle") return 0;
		if (state.phase !== "running") return script.spans.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
		return visibleSpans
			.filter((s) => s.status === "done")
			.reduce((sum, s) => sum + (s.tokens ?? 0), 0);
	}, [script.spans, visibleSpans, state.phase]);

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
		tokensSoFar,
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
