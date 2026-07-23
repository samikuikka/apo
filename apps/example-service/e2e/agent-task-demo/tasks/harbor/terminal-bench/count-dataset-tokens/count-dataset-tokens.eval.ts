/**
 * count-dataset-tokens — apo's first benchmark-backed evaluation.
 *
 * Read this alongside the hand-authored tasks in tasks/real-agent/ (e.g.
 * documents/data-extraction/data-extraction.eval.ts). The contrast is the
 * whole point:
 *
 *   data-extraction.eval.ts  →  apo authors the rubric: trajectory checks,
 *                               objective-fact anchors, and LLM judges.
 *                               Apo IS the source of truth.
 *
 *   count-dataset-tokens     →  an EXTERNAL benchmark (Terminal-Bench) owns
 *                               correctness via its official verifier. Apo
 *                               wraps that verifier as a single gating Test
 *                               and adds trajectory facts only as
 *                               diagnostics. The benchmark IS the source of
 *                               truth; apo is the run/trace/compare layer.
 *
 * Both are legitimate apo usage. This file exists to show the second mode,
 * because every other demo in this tree already shows the first.
 *
 * Acceptance mapped to this file:
 *   - reward 1            → Apo pass
 *   - reward 0            → Apo Test failure (NOT an execution error)
 *   - missing/NaN reward  → execution error (never coerced to 0)
 */
import {
  task,
  test,
  equals,
  satisfies,
} from "@apo/sdk/agent-task";
import { harborAdapter } from "../../../../harbor-adapter.ts";
import type { HarborDeliverables } from "../../../../harbor-adapter.ts";

task("count-dataset-tokens", {
  adapter: harborAdapter,
  execution: "local",
  maxTurns: 1,
  description:
    "Terminal-Bench 2.0 count-dataset-tokens, run via Harbor. Correctness is the official benchmark verifier; apo records the run, trace, and artifacts.",
  deliverables: ["official_verdict", "harbor_trial", "harbor_artifacts"],
  metadata: {
    benchmark: "terminal-bench",
    benchmark_version: "2.0",
    benchmark_task: "terminal-bench/count-dataset-tokens",
    benchmark_task_revision: 3,
    executor: "harbor",
  },
});

const check = test<HarborDeliverables>;

// ── The only gating Test in v1 ───────────────────────────────────────────
// apo's binary verdict is EXACTLY the official Terminal-Bench reward. We add
// no trajectory gates, no judge, no fact anchors of our own — doing so would
// change apo's verdict relative to the benchmark, which defeats the point of
// wrapping an external verifier.
check("official-terminal-bench-verifier", (t, { deliverables }) => {
  t.check(
    deliverables.official_verdict.reward,
    equals(1),
    "official Terminal-Bench reward",
  );
});

// ── Diagnostic only — never gating ───────────────────────────────────────
// These report provenance and trajectory presence so a run is debuggable,
// but they cannot flip the pass/fail verdict above. Compare with
// data-extraction.eval.ts, where the trajectory layer (calledTool /
// maxToolCalls / noFailedActions) IS gating. That's the deliberate contrast
// this showcase exists to make.
check("trajectory-events-recorded-for-trace", (t, { deliverables }) => {
  t.check(
    deliverables.harbor_trial.trajectory_event_count,
    satisfies(
      (n: number) => n >= 0,
      "trajectory event count is reported (diagnostic, not gating)",
    ),
  );
});

check("provenance-preserved", (t, { deliverables }) => {
  t.check(
    deliverables.official_verdict.benchmark,
    equals("terminal-bench"),
    "benchmark provenance",
  );
  t.check(
    deliverables.official_verdict.benchmark_task_revision,
    equals(3),
    "pinned task revision",
  );
});
