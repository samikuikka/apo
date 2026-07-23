/**
 * harbor-adapter — wraps an external benchmark runner (Harbor) as an apo adapter.
 *
 * Read this alongside `real-agent-adapter.ts`. Both adapters have the same
 * shape: `initialize` → `startSession` → `sendUserTurn` → `collectDeliverables`.
 * The difference is *who owns the agent loop*:
 *
 *   real-agent-adapter  →  an in-process `handleChat` (apo's own agent code)
 *   harbor-adapter      →  a child process running the `harbor` CLI
 *
 * apo doesn't care. The adapter is the membrane; behind it can be a function
 * call, a subprocess, an HTTP API, or a queue. As long as the adapter turns
 * the run into deliverables, apo will record the Task Run, run the Tests,
 * capture the trace, and let you compare runs.
 *
 * This is why a real benchmark (Terminal-Bench via Harbor) is a better
 * showcase than a hand-authored demo: it proves apo can adopt an existing
 * external verifier instead of inventing its own rubric.
 */
import { defineAdapter } from "@apo/sdk/agent-task";
import { z } from "zod";
import {
  runHarborTrial,
  loadHarborFixture,
  preflightHarbor,
  HARBOR_VERSION,
  type HarborConfig,
  type HarborTrialResult,
  type HarborRunResult,
} from "./lib/harbor-command.ts";

export type HarborDeliverables = {
  official_verdict: {
    benchmark: string;
    benchmark_task: string;
    benchmark_task_revision: number;
    harbor_version: string;
    task_checksum?: string;
    reward: number;
    rewards: Record<string, unknown>;
  };
  harbor_trial: {
    job_name: string;
    agent: string;
    model?: string;
    environment: string;
    status: string;
    trajectory_event_count: number;
    n_input_tokens?: number;
    n_output_tokens?: number;
    n_cache_tokens?: number;
    cost_usd?: number | null;
  };
  harbor_artifacts: {
    result_path: string;
    trial_dir: string;
    job_dir: string;
  };
};

type HarborState = {
  cfg?: HarborConfig;
  fixturePath?: string;
  ran?: HarborRunResult;
  trial?: HarborTrialResult;
  resultPath?: string;
  trialDir?: string;
  jobDir?: string;
  error?: Error;
};

const TASK_REF = "terminal-bench/count-dataset-tokens";
const TASK_REVISION = 3;

/**
 * Read the fixture override fresh from the environment. Done lazily (inside
 * `initialize`, not at module top-level) because the adapter module is
 * imported once and cached — a top-level read would freeze on the first
 * value across multiple runs in the same process (i.e. the test suite).
 */
function fixturePathFromEnv(): string | undefined {
  return process.env.APO_HARBOR_FIXTURE;
}

const officialVerdictSchema = z.object({
  benchmark: z.literal("terminal-bench"),
  benchmark_task: z.literal(TASK_REF),
  benchmark_task_revision: z.literal(TASK_REVISION),
  harbor_version: z.literal(HARBOR_VERSION),
  reward: z.number().finite(),
  rewards: z.record(z.unknown()),
});

export const harborAdapter = defineAdapter({
  name: "harbor",
  deliverables: {
    official_verdict: officialVerdictSchema,
    harbor_trial: null,
    harbor_artifacts: null,
  },

  // Single turn: Harbor runs the whole benchmark (agent + verifier) in one
  // shot. There is no back-and-forth for apo to drive.
  turn: async () => "Run terminal-bench/count-dataset-tokens and report the official verdict.",

  async initialize() {
    const fixturePath = fixturePathFromEnv();
    if (fixturePath) {
      return { fixturePath };
    }
    const cfg = configFromEnv();
    await preflightHarbor(cfg.bin);
    return { cfg };
  },

  async startSession(ctx) {
    const state = (ctx.state ?? {}) as HarborState;
    return {
      async sendUserTurn() {
        try {
          const ran: HarborRunResult = state.fixturePath
            ? await loadHarborFixture(state.fixturePath)
            : await runHarborTrial(state.cfg!);
          state.ran = ran;
          state.trial = ran.trial;
          state.resultPath = ran.resultPath;
          state.trialDir = ran.trialDir;
          state.jobDir = ran.jobDir;
          return { response: ran.trial };
        } catch (err) {
          // A spawn/load failure is an *execution error*. We surface it on
          // state and let collectDeliverables throw — never coerce to reward 0.
          state.error = err as Error;
          return { response: { error: (err as Error).message } };
        }
      },
    };
  },

  async collectDeliverables(ctx) {
    const state = (ctx.state ?? {}) as HarborState;
    return buildDeliverables(state);
  },
});

function configFromEnv(): HarborConfig {
  const agent = process.env.APO_HARBOR_AGENT;
  if (!agent) throw new Error("APO_HARBOR_AGENT is required (e.g. opencode)");
  return {
    task: `${TASK_REF}@${TASK_REVISION}`,
    agent,
    model: process.env.APO_HARBOR_MODEL,
    env: process.env.APO_HARBOR_ENV ?? "docker",
    bin: process.env.APO_HARBOR_BIN ?? "harbor",
    jobsDir: process.env.APO_HARBOR_JOBS_DIR,
    jobName: `apo-${process.pid}-${Date.now()}`,
  };
}

function buildDeliverables(state: HarborState): HarborDeliverables {
  const trial = state.trial;
  const reward = extractReward(trial, state.error);
  const cfg = state.cfg;
  const ar = trial?.agent_result;

  return {
    official_verdict: {
      benchmark: "terminal-bench",
      benchmark_task: TASK_REF,
      benchmark_task_revision: TASK_REVISION,
      harbor_version: HARBOR_VERSION,
      task_checksum: trial?.task_checksum,
      reward: reward.value,
      rewards: trial?.verifier_result?.rewards ?? {},
    },
    harbor_trial: {
      job_name: cfg?.jobName ?? "fixture",
      agent: cfg?.agent ?? trial?.agent_info?.name ?? "fixture",
      model: cfg?.model ?? trial?.agent_info?.model_info?.name,
      environment: cfg?.env ?? "docker",
      status: state.error ? "error" : reward.value === 1 ? "pass" : "fail",
      trajectory_event_count: countTrajectoryEvents(trial),
      n_input_tokens: ar?.n_input_tokens,
      n_output_tokens: ar?.n_output_tokens,
      n_cache_tokens: ar?.n_cache_tokens,
      cost_usd: ar?.cost_usd,
    },
    harbor_artifacts: {
      result_path: state.resultPath ?? "",
      trial_dir: state.trialDir ?? "",
      job_dir: state.jobDir ?? "",
    },
  };
}

type ExtractedReward = { value: number };

/**
 * The three-way verdict, enforced at the data layer:
 *   - finite reward (0 or 1) → a real verdict
 *   - missing / NaN / Infinity / parse error → throws → execution error
 *
 * This is the crux of the showcase: reward 0 is a *test failure* (the agent
 * ran, the verifier ran, the answer was wrong). A missing reward is an
 * *execution error* (something broke). Coercing the latter to 0 would turn
 * an infrastructure fault into a silent false negative.
 */
function extractReward(
  trial: HarborTrialResult | undefined,
  error: Error | undefined,
): ExtractedReward {
  if (error) throw error;
  const raw = trial?.verifier_result?.rewards?.reward;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new Error(
      `verifier reward is missing or non-finite: ${JSON.stringify(raw)}`,
    );
  }
  return { value: raw };
}

/**
 * Trajectory events are *diagnostic only* in this showcase. See the eval
 * file: we count them but never gate on them, because that would change
 * apo's verdict relative to the official benchmark. Harbor stores the ATIF
 * trajectory in `agent_result.rollout_details` (the opencode agent leaves it
 * null; real replay of its `agent/opencode.txt` stream is the future
 * lib/harbor-trajectory.ts work from issue #20). For now we count honestly.
 */
function countTrajectoryEvents(trial?: HarborTrialResult): number {
  const rd = trial?.agent_result?.rollout_details;
  if (Array.isArray(rd)) return rd.length;
  if (rd && typeof rd === "object" && Array.isArray((rd as { events?: unknown[] }).events)) {
    return (rd as { events: unknown[] }).events.length;
  }
  return 0;
}
