import type { AgentTaskRunSummary } from "@/lib/agent-task-api";

/**
 * PROTOTYPE — deterministic synthetic run pairs for density previews
 * ("how would the chart look with 50 tasks?"). Seeded LCG, clearly-labeled
 * demo data; never mixed with real batches.
 */
function lcg(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

const FOLDERS: { folder: string; count: number }[] = [
  { folder: "real-agent/documents", count: 6 },
  { folder: "real-agent/engineering", count: 14 },
  { folder: "real-agent/operations", count: 8 },
  { folder: "real-agent/research", count: 10 },
  { folder: "real-agent/security", count: 6 },
  { folder: "", count: 6 },
];

function makeRun(
  id: string,
  taskPath: string,
  model: string,
  r: () => number,
  expensive: boolean,
): AgentTaskRunSummary {
  const total = 3 + Math.floor(r() * 6);
  const passRate = expensive ? 0.5 + r() * 0.45 : 0.1 + r() * 0.4;
  const passed = Math.min(total, Math.round(total * passRate));
  const baseCost = 400 + r() * 6000; // micro-USD
  const cost = Math.round(expensive ? baseCost * (8 + r() * 20) : baseCost);
  const durS = expensive ? 20 + r() * 110 : 5 + r() * 35;
  const start = new Date(Date.UTC(2026, 8, 22, 10, 0, 0));
  return {
    id,
    batch_run_id: "demo",
    task_id: taskPath,
    task_path: taskPath,
    adapter_name: "demo",
    status: passed === total ? "passed" : "failed",
    pass_result: passed === total,
    started_at: start.toISOString(),
    completed_at: new Date(start.getTime() + durS * 1000).toISOString(),
    trace_run_id: null,
    primary_model: model,
    task_source_commit_sha: null,
    error_message: null,
    total_cost: cost,
    total_tokens: Math.round((cost / 1000) * (30 + r() * 40)),
    total_checks: total,
    passed_checks: passed,
    failed_checks: total - passed,
    trigger: null,
    trace_persistence_status: "persisted",
    trace_error_message: null,
    error_category: null,
    run_configuration: { model, effort: null },
  };
}

let cached: { leftRuns: AgentTaskRunSummary[]; rightRuns: AgentTaskRunSummary[] } | null = null;

export function makeDemoRuns(): { leftRuns: AgentTaskRunSummary[]; rightRuns: AgentTaskRunSummary[] } {
  // deterministic dataset — build once per session, not per render
  if (cached) return cached;
  const r = lcg(20260922);
  const leftRuns: AgentTaskRunSummary[] = [];
  const rightRuns: AgentTaskRunSummary[] = [];
  let n = 0;
  for (const { folder, count } of FOLDERS) {
    for (let i = 0; i < count; i++) {
      n += 1;
      const name = `task-${String(n).padStart(2, "0")}`;
      const taskPath = folder ? `${folder}/${name}` : name;
      leftRuns.push(makeRun(`demo-a-${n}`, taskPath, "gemini-2.5-flash-lite", r, false));
      rightRuns.push(makeRun(`demo-b-${n}`, taskPath, "claude-haiku-4-5", r, true));
    }
  }
  cached = { leftRuns, rightRuns };
  return cached;
}
