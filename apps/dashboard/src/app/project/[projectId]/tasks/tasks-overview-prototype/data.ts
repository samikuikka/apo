export type PrototypeStatus = "passed" | "failed" | "error";

export interface PrototypeMetrics {
  passed: number;
  verdicts: number;
  errors: number;
  checkRate: number;
  cost: number;
}

export interface PrototypeHistoryPoint {
  status: PrototypeStatus;
  definition: "v3" | "v4";
  execution: "8d101aa" | "a3d91c4" | "b772ef1";
  model: "opus" | "sonnet";
}

export interface PrototypeTaskOverview {
  id: string;
  name: string;
  folder: string;
  tag: string;
  baseline: PrototypeMetrics;
  allHistoryRate: number;
  models: {
    opus: PrototypeMetrics;
    sonnet: PrototypeMetrics;
  };
  executions: {
    current: PrototypeMetrics;
    previous: PrototypeMetrics;
  };
  history: PrototypeHistoryPoint[];
}

const metric = (
  passed: number,
  verdicts: number,
  checkRate: number,
  cost: number,
  errors = 0,
): PrototypeMetrics => ({ passed, verdicts, errors, checkRate, cost });

export const TASK_OVERVIEW_FIXTURE: PrototypeTaskOverview[] = [
  {
    id: "refund-request",
    name: "Resolve refund request",
    folder: "support/refunds",
    tag: "critical",
    baseline: metric(8, 10, 94, 0.42, 1),
    allHistoryRate: 61,
    models: { opus: metric(8, 10, 94, 0.42, 1), sonnet: metric(4, 9, 79, 0.15) },
    executions: { current: metric(8, 10, 94, 0.42, 1), previous: metric(5, 9, 86, 0.39) },
    history: history(["failed", "passed", "failed", "passed", "passed", "passed", "error", "failed", "passed", "passed"]),
  },
  {
    id: "document-search",
    name: "Find policy document",
    folder: "support/search",
    tag: "retrieval",
    baseline: metric(6, 6, 100, 0.31),
    allHistoryRate: 82,
    models: { opus: metric(6, 6, 100, 0.31), sonnet: metric(5, 6, 91, 0.11) },
    executions: { current: metric(6, 6, 100, 0.31), previous: metric(4, 6, 84, 0.28) },
    history: history(["failed", "passed", "passed", "passed", "passed", "passed", "passed", "passed"]),
  },
  {
    id: "account-cancellation",
    name: "Cancel customer account",
    folder: "support/accounts",
    tag: "destructive",
    baseline: metric(2, 4, 87, 0.47),
    allHistoryRate: 74,
    models: { opus: metric(2, 4, 87, 0.47), sonnet: metric(3, 4, 91, 0.18) },
    executions: { current: metric(2, 4, 87, 0.47), previous: metric(4, 5, 95, 0.45) },
    history: history(["passed", "passed", "passed", "passed", "failed", "passed", "failed", "passed"]),
  },
  {
    id: "incident-triage",
    name: "Triage production incident",
    folder: "engineering/operations",
    tag: "reasoning",
    baseline: metric(7, 8, 96, 0.58),
    allHistoryRate: 69,
    models: { opus: metric(7, 8, 96, 0.58), sonnet: metric(3, 8, 73, 0.20, 1) },
    executions: { current: metric(7, 8, 96, 0.58), previous: metric(4, 7, 80, 0.53) },
    history: history(["failed", "error", "passed", "failed", "passed", "passed", "passed", "passed", "passed"]),
  },
  {
    id: "migration-plan",
    name: "Draft migration plan",
    folder: "engineering/planning",
    tag: "long-running",
    baseline: metric(3, 5, 89, 0.71),
    allHistoryRate: 60,
    models: { opus: metric(3, 5, 89, 0.71), sonnet: metric(2, 5, 76, 0.24) },
    executions: { current: metric(3, 5, 89, 0.71), previous: metric(3, 5, 88, 0.68) },
    history: history(["failed", "passed", "failed", "passed", "failed", "passed", "passed"]),
  },
  {
    id: "security-audit",
    name: "Audit authentication flow",
    folder: "engineering/security",
    tag: "security",
    baseline: metric(1, 2, 92, 0.66),
    allHistoryRate: 86,
    models: { opus: metric(1, 2, 92, 0.66), sonnet: metric(5, 6, 95, 0.22) },
    executions: { current: metric(1, 2, 92, 0.66), previous: metric(6, 6, 98, 0.64) },
    history: history(["passed", "passed", "passed", "passed", "passed", "passed", "failed", "passed"]),
  },
  {
    id: "research-synthesis",
    name: "Synthesize competitor research",
    folder: "research",
    tag: "judge",
    baseline: metric(0, 0, 0, 0, 1),
    allHistoryRate: 67,
    models: { opus: metric(0, 0, 0, 0, 1), sonnet: metric(2, 3, 81, 0.17) },
    executions: { current: metric(0, 0, 0, 0, 1), previous: metric(2, 3, 81, 0.51) },
    history: history(["passed", "failed", "passed", "error"]),
  },
];

export const BASELINE_SCOPE = {
  definition: "Current published definitions",
  execution: "b772ef1",
  configuration: "Opus 4 · high",
};

function history(statuses: PrototypeStatus[]): PrototypeHistoryPoint[] {
  return statuses.map((status, index) => ({
    status,
    definition: index < Math.ceil(statuses.length / 2) ? "v3" : "v4",
    execution: index < 2 ? "8d101aa" : index < 5 ? "a3d91c4" : "b772ef1",
    model: index === 1 || index === 2 ? "sonnet" : "opus",
  }));
}

export function passRate(metrics: PrototypeMetrics): number | null {
  return metrics.verdicts === 0 ? null : Math.round((metrics.passed / metrics.verdicts) * 100);
}

export function projectSummary(tasks: PrototypeTaskOverview[]) {
  const passing = tasks.filter((task) => (passRate(task.baseline) ?? 0) >= 80).length;
  const failing = tasks.filter((task) => task.baseline.verdicts > 0 && (passRate(task.baseline) ?? 0) < 80).length;
  const errors = tasks.filter((task) => task.baseline.verdicts === 0 && task.baseline.errors > 0).length;
  return { passing, failing, errors };
}
