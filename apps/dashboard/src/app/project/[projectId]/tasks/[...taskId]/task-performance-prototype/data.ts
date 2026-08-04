export type PrototypeRunStatus = "passed" | "failed" | "error";

export interface PrototypeRun {
  id: string;
  relativeTime: string;
  status: PrototypeRunStatus;
  definition: "v3" | "v4" | "working";
  definitionDigest: string;
  baseline: boolean;
  execution: string;
  dirty?: boolean;
  model: "Claude Sonnet 4" | "Claude Opus 4";
  effort: "medium" | "high";
  checksPassed: number;
  checksTotal: number;
  cost: number;
  durationSeconds: number;
}

export const PUBLISHED_DEFINITION = {
  label: "v4",
  digest: "7b18c2f",
  publishedAt: "2 days ago",
};

export const PROTOTYPE_RUNS: PrototypeRun[] = [
  {
    id: "run-18",
    relativeTime: "12 min ago",
    status: "passed",
    definition: "working",
    definitionDigest: "a91d031",
    baseline: false,
    execution: "dirty:31acb2e",
    dirty: true,
    model: "Claude Opus 4",
    effort: "high",
    checksPassed: 15,
    checksTotal: 15,
    cost: 0.48,
    durationSeconds: 31,
  },
  {
    id: "run-17",
    relativeTime: "38 min ago",
    status: "failed",
    definition: "working",
    definitionDigest: "a91d031",
    baseline: false,
    execution: "dirty:31acb2e",
    dirty: true,
    model: "Claude Opus 4",
    effort: "high",
    checksPassed: 14,
    checksTotal: 15,
    cost: 0.44,
    durationSeconds: 27,
  },
  {
    id: "run-16",
    relativeTime: "2 h ago",
    status: "passed",
    definition: "v4",
    definitionDigest: "7b18c2f",
    baseline: true,
    execution: "b772ef1",
    model: "Claude Opus 4",
    effort: "high",
    checksPassed: 15,
    checksTotal: 15,
    cost: 0.47,
    durationSeconds: 29,
  },
  {
    id: "run-15",
    relativeTime: "4 h ago",
    status: "failed",
    definition: "v4",
    definitionDigest: "7b18c2f",
    baseline: true,
    execution: "b772ef1",
    model: "Claude Opus 4",
    effort: "high",
    checksPassed: 12,
    checksTotal: 15,
    cost: 0.42,
    durationSeconds: 24,
  },
  {
    id: "run-14",
    relativeTime: "6 h ago",
    status: "error",
    definition: "v4",
    definitionDigest: "7b18c2f",
    baseline: true,
    execution: "b772ef1",
    model: "Claude Opus 4",
    effort: "high",
    checksPassed: 0,
    checksTotal: 0,
    cost: 0.08,
    durationSeconds: 8,
  },
  {
    id: "run-13",
    relativeTime: "Yesterday",
    status: "passed",
    definition: "v4",
    definitionDigest: "7b18c2f",
    baseline: true,
    execution: "b772ef1",
    model: "Claude Sonnet 4",
    effort: "medium",
    checksPassed: 15,
    checksTotal: 15,
    cost: 0.18,
    durationSeconds: 19,
  },
  {
    id: "run-12",
    relativeTime: "Yesterday",
    status: "failed",
    definition: "v4",
    definitionDigest: "7b18c2f",
    baseline: true,
    execution: "b772ef1",
    model: "Claude Sonnet 4",
    effort: "medium",
    checksPassed: 13,
    checksTotal: 15,
    cost: 0.17,
    durationSeconds: 18,
  },
  {
    id: "run-11",
    relativeTime: "2 days ago",
    status: "passed",
    definition: "v3",
    definitionDigest: "44d720a",
    baseline: false,
    execution: "b772ef1",
    model: "Claude Opus 4",
    effort: "high",
    checksPassed: 12,
    checksTotal: 12,
    cost: 0.45,
    durationSeconds: 25,
  },
  {
    id: "run-10",
    relativeTime: "3 days ago",
    status: "passed",
    definition: "v3",
    definitionDigest: "44d720a",
    baseline: false,
    execution: "a3d91c4",
    model: "Claude Sonnet 4",
    effort: "medium",
    checksPassed: 12,
    checksTotal: 12,
    cost: 0.16,
    durationSeconds: 17,
  },
  {
    id: "run-09",
    relativeTime: "3 days ago",
    status: "failed",
    definition: "v3",
    definitionDigest: "44d720a",
    baseline: false,
    execution: "a3d91c4",
    model: "Claude Sonnet 4",
    effort: "medium",
    checksPassed: 10,
    checksTotal: 12,
    cost: 0.15,
    durationSeconds: 16,
  },
  {
    id: "run-08",
    relativeTime: "4 days ago",
    status: "passed",
    definition: "v3",
    definitionDigest: "44d720a",
    baseline: false,
    execution: "8d101aa",
    model: "Claude Sonnet 4",
    effort: "medium",
    checksPassed: 12,
    checksTotal: 12,
    cost: 0.14,
    durationSeconds: 15,
  },
  {
    id: "run-07",
    relativeTime: "4 days ago",
    status: "failed",
    definition: "v3",
    definitionDigest: "44d720a",
    baseline: false,
    execution: "8d101aa",
    model: "Claude Sonnet 4",
    effort: "medium",
    checksPassed: 7,
    checksTotal: 12,
    cost: 0.13,
    durationSeconds: 14,
  },
];

export function summarizeRuns(runs: PrototypeRun[]) {
  const verdicts = runs.filter((run) => run.status !== "error");
  const passed = verdicts.filter((run) => run.status === "passed").length;
  const errors = runs.filter((run) => run.status === "error").length;
  const checksPassed = runs.reduce((sum, run) => sum + run.checksPassed, 0);
  const checksTotal = runs.reduce((sum, run) => sum + run.checksTotal, 0);
  const averageCost = runs.length === 0
    ? 0
    : runs.reduce((sum, run) => sum + run.cost, 0) / runs.length;

  return {
    total: runs.length,
    verdicts: verdicts.length,
    passed,
    failed: verdicts.length - passed,
    errors,
    passRate: verdicts.length === 0 ? 0 : Math.round((passed / verdicts.length) * 100),
    checksPassed,
    checksTotal,
    checkRate: checksTotal === 0 ? 0 : Math.round((checksPassed / checksTotal) * 100),
    averageCost,
  };
}
