// V2 fixture: run-level evidence with the dimensions apo actually stores.
// Contrast with `data.ts`, which hardcodes a single Project-wide baseline.
//
// Each Task Run carries:
//   - run_configuration (model + effort) — apo stores this per run
//   - task_source_commit_sha + parent batch's task_revision — two real revisions
//   - trigger kind (schedule | ci | manual | ad_hoc) — what kind of evidence
//
// Derivation strategies live at the bottom: cohortBaseline (Model B) and
// scheduleBaseline (Model A). Each variant imports one and renders the
// result; the fixture itself stays free of presentation choices.

export type TriggerKind = "schedule" | "ci" | "manual" | "ad_hoc";
export type RunStatus = "passed" | "failed" | "error";
export type ModelName = "opus" | "sonnet";
export type EffortName = "low" | "medium" | "high";

export interface RunConfig {
  model: ModelName;
  effort: EffortName;
}

export interface TaskRevision {
  commitSha: string;
  contentSha: string;
  dirty: boolean;
}

export interface PrototypeRunV2 {
  id: string;
  taskId: string;
  status: RunStatus;
  passedChecks: number;
  totalChecks: number;
  errors: number;
  cost: number;
  startedAt: string; // ISO date; used only for ordering
  config: RunConfig;
  trigger: TriggerKind;
  scheduleName?: string;
  taskRevision: TaskRevision;
  sourceCommitSha: string;
  prNumber?: number;
}

export interface PrototypeSchedule {
  name: string;
  cadence: "daily" | "weekly";
  config: RunConfig;
  lastTriggeredAt: string;
  nextRunAt: string;
}

export interface PrototypeTaskV2 {
  id: string;
  name: string;
  folder: string;
  tag: string;
  schedule?: PrototypeSchedule;
  runs: PrototypeRunV2[]; // chronological, oldest first
}

export interface PrototypeProjectScope {
  publishedTaskRevision: TaskRevision;
  publishedSourceCommit: string;
  availableConfigs: RunConfig[]; // distinct configs observed across all runs
}

// ---------------------------------------------------------------------------
// Project scope: the "current published" definitions and source revision.
// In production these would come from ProjectTaskSource.last_resolved_commit_sha
// + the latest published Task Definition revision.
// ---------------------------------------------------------------------------

const PUBLISHED_REVISION: TaskRevision = {
  commitSha: "b772ef1",
  contentSha: "9c4f1e2a",
  dirty: false,
};

const PUBLISHED_SOURCE = "b772ef1";

// Older revisions used in history so trends can show boundaries.
const REVISION_V3: TaskRevision = { commitSha: "8d101aa", contentSha: "67b2c90", dirty: false };
const REVISION_V3B: TaskRevision = { commitSha: "a3d91c4", contentSha: "67b2c90", dirty: false };
const REVISION_DIRTY: TaskRevision = { commitSha: "a3d91c4", contentSha: "67b2c90", dirty: true };

const OPUS_HIGH: RunConfig = { model: "opus", effort: "high" };
const SONNET_MED: RunConfig = { model: "sonnet", effort: "medium" };

let runCounter = 0;
function run(partial: Omit<PrototypeRunV2, "id">): PrototypeRunV2 {
  runCounter += 1;
  return { id: `r${runCounter}`, ...partial };
}

function day(offset: number): string {
  // Deterministic ISO dates so "time ago" formatting is stable across reloads.
  return new Date(Date.UTC(2026, 6, 1 + offset)).toISOString();
}

// ---------------------------------------------------------------------------
// Fixture: 8 tasks covering every state the handoff asks about.
//   1. refund-request      — scheduled, daily, opus high, healthy, one stray manual sonnet
//   2. document-search     — scheduled, weekly, opus high, healthy, recent def bump
//   3. account-cancellation — schedule exists but config is mixed
//   4. incident-triage     — schedule exists, NO scheduled runs yet (only one CI run)
//   5. migration-plan      — no schedule, only CI runs
//   6. security-audit      — no schedule, manual runs across two models
//   7. research-synthesis  — never run (empty state)
//   8. billing-dispute     — scheduled, daily, sonnet medium (different from project default)
// ---------------------------------------------------------------------------

export const TASKS_V2: PrototypeTaskV2[] = [
  {
    id: "refund-request",
    name: "Resolve refund request",
    folder: "support/refunds",
    tag: "critical",
    schedule: {
      name: "Refunds daily check",
      cadence: "daily",
      config: OPUS_HIGH,
      lastTriggeredAt: day(20),
      nextRunAt: day(22),
    },
    runs: [
      run({ taskId: "refund-request", status: "failed",  passedChecks: 3, totalChecks: 10, errors: 0, cost: 0.41, startedAt: day(2),  config: OPUS_HIGH,   trigger: "schedule", scheduleName: "Refunds daily check", taskRevision: REVISION_V3,  sourceCommitSha: "8d101aa" }),
      run({ taskId: "refund-request", status: "passed",  passedChecks: 10, totalChecks: 10, errors: 0, cost: 0.40, startedAt: day(4),  config: OPUS_HIGH,   trigger: "schedule", scheduleName: "Refunds daily check", taskRevision: REVISION_V3,  sourceCommitSha: "8d101aa" }),
      run({ taskId: "refund-request", status: "failed",  passedChecks: 4,  totalChecks: 9,  errors: 0, cost: 0.16, startedAt: day(6),  config: SONNET_MED,  trigger: "manual",   taskRevision: REVISION_V3,  sourceCommitSha: "8d101aa" }),
      run({ taskId: "refund-request", status: "passed",  passedChecks: 9,  totalChecks: 10, errors: 0, cost: 0.42, startedAt: day(10), config: OPUS_HIGH,   trigger: "schedule", scheduleName: "Refunds daily check", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4" }),
      run({ taskId: "refund-request", status: "error",   passedChecks: 0,  totalChecks: 0,  errors: 1, cost: 0.05, startedAt: day(13), config: OPUS_HIGH,   trigger: "schedule", scheduleName: "Refunds daily check", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4" }),
      run({ taskId: "refund-request", status: "passed",  passedChecks: 8,  totalChecks: 10, errors: 0, cost: 0.42, startedAt: day(17), config: OPUS_HIGH,   trigger: "schedule", scheduleName: "Refunds daily check", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
      run({ taskId: "refund-request", status: "passed",  passedChecks: 9,  totalChecks: 10, errors: 0, cost: 0.43, startedAt: day(20), config: OPUS_HIGH,   trigger: "schedule", scheduleName: "Refunds daily check", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
    ],
  },
  {
    id: "document-search",
    name: "Find policy document",
    folder: "support/search",
    tag: "retrieval",
    schedule: {
      name: "Search weekly",
      cadence: "weekly",
      config: OPUS_HIGH,
      lastTriggeredAt: day(19),
      nextRunAt: day(26),
    },
    runs: [
      run({ taskId: "document-search", status: "failed", passedChecks: 3, totalChecks: 6, errors: 0, cost: 0.29, startedAt: day(1), config: OPUS_HIGH, trigger: "schedule", scheduleName: "Search weekly", taskRevision: REVISION_V3, sourceCommitSha: "8d101aa" }),
      run({ taskId: "document-search", status: "passed", passedChecks: 6, totalChecks: 6, errors: 0, cost: 0.30, startedAt: day(8), config: OPUS_HIGH, trigger: "schedule", scheduleName: "Search weekly", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4" }),
      run({ taskId: "document-search", status: "passed", passedChecks: 6, totalChecks: 6, errors: 0, cost: 0.31, startedAt: day(15), config: OPUS_HIGH, trigger: "schedule", scheduleName: "Search weekly", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
      run({ taskId: "document-search", status: "passed", passedChecks: 6, totalChecks: 6, errors: 0, cost: 0.32, startedAt: day(19), config: OPUS_HIGH, trigger: "schedule", scheduleName: "Search weekly", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
    ],
  },
  {
    id: "account-cancellation",
    name: "Cancel customer account",
    folder: "support/accounts",
    tag: "destructive",
    schedule: {
      name: "Accounts daily",
      cadence: "daily",
      config: OPUS_HIGH, // schedule says opus, but recent scheduled runs span both models
      lastTriggeredAt: day(18),
      nextRunAt: day(19),
    },
    runs: [
      run({ taskId: "account-cancellation", status: "passed", passedChecks: 4, totalChecks: 4, errors: 0, cost: 0.45, startedAt: day(3), config: OPUS_HIGH,  trigger: "schedule", scheduleName: "Accounts daily", taskRevision: REVISION_V3, sourceCommitSha: "8d101aa" }),
      run({ taskId: "account-cancellation", status: "passed", passedChecks: 4, totalChecks: 4, errors: 0, cost: 0.46, startedAt: day(7), config: OPUS_HIGH,  trigger: "schedule", scheduleName: "Accounts daily", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4" }),
      run({ taskId: "account-cancellation", status: "failed", passedChecks: 2, totalChecks: 4, errors: 0, cost: 0.18, startedAt: day(11), config: SONNET_MED, trigger: "schedule", scheduleName: "Accounts daily", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4" }),
      run({ taskId: "account-cancellation", status: "failed", passedChecks: 1, totalChecks: 4, errors: 0, cost: 0.18, startedAt: day(14), config: SONNET_MED, trigger: "schedule", scheduleName: "Accounts daily", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
      run({ taskId: "account-cancellation", status: "passed", passedChecks: 3, totalChecks: 4, errors: 0, cost: 0.48, startedAt: day(18), config: OPUS_HIGH,  trigger: "schedule", scheduleName: "Accounts daily", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
    ],
  },
  {
    id: "incident-triage",
    name: "Triage production incident",
    folder: "engineering/operations",
    tag: "reasoning",
    schedule: {
      name: "On-call daily",
      cadence: "daily",
      config: OPUS_HIGH,
      lastTriggeredAt: day(21), // scheduled, but the schedule has not produced a run yet
      nextRunAt: day(22),
    },
    runs: [
      // Only one CI run exists; the schedule is configured but never fired.
      run({ taskId: "incident-triage", status: "passed", passedChecks: 8, totalChecks: 9, errors: 0, cost: 0.55, startedAt: day(5), config: OPUS_HIGH, trigger: "ci", taskRevision: REVISION_DIRTY, sourceCommitSha: "f1f1f1f", prNumber: 421 }),
    ],
  },
  {
    id: "migration-plan",
    name: "Draft migration plan",
    folder: "engineering/planning",
    tag: "long-running",
    // No schedule — only CI runs against PRs.
    runs: [
      run({ taskId: "migration-plan", status: "failed", passedChecks: 2, totalChecks: 5, errors: 0, cost: 0.66, startedAt: day(4),  config: OPUS_HIGH, trigger: "ci", taskRevision: REVISION_V3,  sourceCommitSha: "8d101aa", prNumber: 401 }),
      run({ taskId: "migration-plan", status: "passed", passedChecks: 4, totalChecks: 5, errors: 0, cost: 0.69, startedAt: day(9),  config: OPUS_HIGH, trigger: "ci", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4", prNumber: 412 }),
      run({ taskId: "migration-plan", status: "failed", passedChecks: 2, totalChecks: 5, errors: 0, cost: 0.71, startedAt: day(16), config: OPUS_HIGH, trigger: "ci", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE, prNumber: 442 }),
    ],
  },
  {
    id: "security-audit",
    name: "Audit authentication flow",
    folder: "engineering/security",
    tag: "security",
    // No schedule; manual experiments across two models.
    runs: [
      run({ taskId: "security-audit", status: "passed", passedChecks: 6, totalChecks: 6, errors: 0, cost: 0.61, startedAt: day(2), config: OPUS_HIGH,  trigger: "manual", taskRevision: REVISION_V3,  sourceCommitSha: "8d101aa" }),
      run({ taskId: "security-audit", status: "passed", passedChecks: 6, totalChecks: 6, errors: 0, cost: 0.64, startedAt: day(8), config: OPUS_HIGH,  trigger: "manual", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4" }),
      run({ taskId: "security-audit", status: "failed", passedChecks: 5, totalChecks: 6, errors: 0, cost: 0.21, startedAt: day(12), config: SONNET_MED, trigger: "manual", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
      run({ taskId: "security-audit", status: "passed", passedChecks: 6, totalChecks: 6, errors: 0, cost: 0.66, startedAt: day(17), config: OPUS_HIGH,  trigger: "manual", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
    ],
  },
  {
    id: "research-synthesis",
    name: "Synthesize competitor research",
    folder: "research",
    tag: "judge",
    // Never run — empty state.
    runs: [],
  },
  {
    id: "billing-dispute",
    name: "Resolve billing dispute",
    folder: "finance",
    tag: "critical",
    schedule: {
      name: "Billing daily",
      cadence: "daily",
      config: SONNET_MED, // schedule is on Sonnet — forces model picker to consider Sonnet baseline
      lastTriggeredAt: day(21),
      nextRunAt: day(22),
    },
    runs: [
      run({ taskId: "billing-dispute", status: "passed", passedChecks: 5, totalChecks: 5, errors: 0, cost: 0.16, startedAt: day(7),  config: SONNET_MED, trigger: "schedule", scheduleName: "Billing daily", taskRevision: REVISION_V3B, sourceCommitSha: "a3d91c4" }),
      run({ taskId: "billing-dispute", status: "passed", passedChecks: 4, totalChecks: 5, errors: 0, cost: 0.17, startedAt: day(12), config: SONNET_MED, trigger: "schedule", scheduleName: "Billing daily", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
      run({ taskId: "billing-dispute", status: "failed", passedChecks: 3, totalChecks: 5, errors: 0, cost: 0.55, startedAt: day(15), config: OPUS_HIGH,   trigger: "manual", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
      run({ taskId: "billing-dispute", status: "passed", passedChecks: 5, totalChecks: 5, errors: 0, cost: 0.18, startedAt: day(21), config: SONNET_MED, trigger: "schedule", scheduleName: "Billing daily", taskRevision: PUBLISHED_REVISION, sourceCommitSha: PUBLISHED_SOURCE }),
    ],
  },
];

export const PROJECT_SCOPE_V2: PrototypeProjectScope = {
  publishedTaskRevision: PUBLISHED_REVISION,
  publishedSourceCommit: PUBLISHED_SOURCE,
  availableConfigs: distinctConfigs(TASKS_V2),
};

// ---------------------------------------------------------------------------
// Derivation helpers
// ---------------------------------------------------------------------------

export interface DerivedBaseline {
  // The runs that counted towards "current".
  runs: PrototypeRunV2[];
  passedChecks: number;
  totalChecks: number;
  errors: number;
  cost: number;
  checkRate: number; // 0..100
  passRate: number | null; // null when no verdicts
  distinctConfigs: RunConfig[];
}

export function emptyBaseline(): DerivedBaseline {
  return { runs: [], passedChecks: 0, totalChecks: 0, errors: 0, cost: 0, checkRate: 0, passRate: null, distinctConfigs: [] };
}

function aggregate(runs: PrototypeRunV2[]): DerivedBaseline {
  const passedChecks = runs.reduce((s, r) => s + r.passedChecks, 0);
  const totalChecks = runs.reduce((s, r) => s + r.totalChecks, 0);
  const errors = runs.filter((r) => r.status === "error").length;
  const cost = runs.reduce((s, r) => s + r.cost, 0);
  const checkRate = totalChecks === 0 ? 0 : Math.round((passedChecks / totalChecks) * 100);
  const passRate = runs.length === 0 ? null : Math.round((runs.filter((r) => r.status === "passed").length / runs.length) * 100);
  return { runs, passedChecks, totalChecks, errors, cost, checkRate, passRate, distinctConfigs: distinctConfigsInRuns(runs) };
}

/**
 * Model B — Published-cohort baseline.
 *
 * Current = runs whose task revision and source commit match the published
 * ones, filtered further by an optional model. When `configFilter` is null
 * every matching run counts, regardless of model.
 */
export function cohortBaseline(
  task: PrototypeTaskV2,
  scope: PrototypeProjectScope,
  configFilter: RunConfig | null,
): DerivedBaseline {
  const matches = task.runs.filter((r) =>
    r.taskRevision.contentSha === scope.publishedTaskRevision.contentSha &&
    r.sourceCommitSha === scope.publishedSourceCommit &&
    (configFilter === null || sameConfig(r.config, configFilter)),
  );
  return aggregate(matches);
}

/**
 * Model A — Schedule-anchored baseline.
 *
 * Current = the most recent run produced by the Task's primary schedule.
 * Tasks without a schedule have no baseline; callers surface a provisional
 * fallback themselves so the rule stays explicit here.
 */
export function scheduleBaseline(task: PrototypeTaskV2): DerivedBaseline {
  if (!task.schedule) return emptyBaseline();
  const scheduled = task.runs
    .filter((r) => r.trigger === "schedule" && r.scheduleName === task.schedule!.name)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  if (scheduled.length === 0) return emptyBaseline();
  // Last scheduled run is the canonical baseline; we still aggregate the
  // trailing comparable cohort (same config) for sample-size confidence.
  const latest = scheduled[0];
  const cohort = scheduled.filter((r) => sameConfig(r.config, latest.config));
  return aggregate(cohort);
}

export function provisionalFallback(task: PrototypeTaskV2): DerivedBaseline & { latest?: PrototypeRunV2 } {
  if (task.runs.length === 0) return { ...emptyBaseline(), latest: undefined };
  const sorted = [...task.runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  const latest = sorted[0];
  return { ...aggregate([latest]), latest };
}

export function sameConfig(a: RunConfig, b: RunConfig): boolean {
  return a.model === b.model && a.effort === b.effort;
}

export function describeConfig(c: RunConfig): string {
  const modelLabel = c.model === "opus" ? "Opus 4" : "Sonnet 4";
  return `${modelLabel} · ${c.effort}`;
}

export function shortSha(sha: string, len = 7): string {
  return sha.slice(0, len);
}

function distinctConfigs(tasks: PrototypeTaskV2[]): RunConfig[] {
  const seen: RunConfig[] = [];
  for (const t of tasks) {
    for (const r of t.runs) {
      if (!seen.some((c) => sameConfig(c, r.config))) seen.push(r.config);
    }
  }
  return seen;
}

function distinctConfigsInRuns(runs: PrototypeRunV2[]): RunConfig[] {
  const seen: RunConfig[] = [];
  for (const r of runs) {
    if (!seen.some((c) => sameConfig(c, r.config))) seen.push(r.config);
  }
  return seen;
}
