/**
 * harbor-command — invoke the Harbor CLI as a child process.
 *
 * This is the seam between apo and Harbor. Apo never runs the benchmark
 * itself; it spawns `harbor run` with an argv array (never a shell), points
 * it at an isolated jobs directory, and reads back the structured trial
 * result. Everything apo needs — model/tool activity, the official verdict,
 * the agent trajectory — is in that result; we just parse it.
 *
 * Showcase note: preflight (binary/version/Docker checks), the secret
 * allow-list, log bounding, and cancellation live here so they stay OUT of
 * the adapter. The adapter's job is "drive one Harbor trial, collect
 * deliverables"; this module's job is "talk to a subprocess safely".
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const execFileAsync = promisify(execFile);

export const HARBOR_VERSION = "0.20.0";

export type HarborConfig = {
  task: string;
  agent: string;
  model?: string;
  env?: string;
  bin?: string;
  jobsDir?: string;
  jobName: string;
};

export type HarborRewards = {
  reward?: number;
  [k: string]: unknown;
};

/**
 * The real shape of a Harbor *trial* result.json (verified against Harbor
 * 0.20.0). A job writes one trial per attempt into its own subdirectory:
 *   <jobsDir>/<jobName>/<task-slug>__<id>/result.json
 * There is no `trial_results[]` wrapper — the trial is a standalone object.
 */
export type HarborTrialResult = {
  task_name?: string;
  task_checksum?: string;
  agent_info?: {
    name?: string;
    version?: string;
    model_info?: { name?: string; provider?: string };
    [k: string]: unknown;
  };
  agent_result?: {
    n_input_tokens?: number;
    n_cache_tokens?: number;
    n_output_tokens?: number;
    cost_usd?: number | null;
    /** ATIF trajectory (opencode agent leaves this null; replay is future work). */
    rollout_details?: unknown[] | { events?: unknown[] } | null;
    [k: string]: unknown;
  };
  verifier_result: {
    rewards: HarborRewards;
    [k: string]: unknown;
  };
  exception_info?: { [k: string]: unknown } | null;
  [k: string]: unknown;
};

/**
 * Credentials are inherited through an explicit allow-list, never through
 * argv. Anything not listed here is dropped from the child's environment so
 * a provider key can never leak into logs, deliverables, or metadata.
 */
const ENV_ALLOW_LIST = [
  "PATH",
  "HOME",
  "USER",
  "DOCKER_HOST",
  // Provider keys the selected Harbor agent needs. Add narrowly.
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
];

export type HarborRunResult = {
  trial: HarborTrialResult;
  resultPath: string;
  trialDir: string;
  jobDir: string;
};

export async function runHarborTrial(cfg: HarborConfig): Promise<HarborRunResult> {
  const bin = cfg.bin ?? "harbor";
  const jobsDir = cfg.jobsDir ?? (await mkdtemp(join(tmpdir(), "apo-harbor-")));
  const jobDir = join(jobsDir, cfg.jobName);
  const argv = buildHarborArgv(cfg, jobsDir);
  const env = buildHarborEnv(process.env);

  // `harbor run` writes one trial per attempt into <jobDir>/<task-slug>__<id>/.
  // The stdout stream is bounded separately (TODO: cap + stream to a log file).
  await execFileAsync(bin, argv, {
    env: env as NodeJS.ProcessEnv,
    maxBuffer: 16 * 1024 * 1024,
    // No shell — argv array only. Never mount the Docker socket.
    shell: false,
  });

  return readTrialResult(jobDir);
}

/**
 * Locate the trial subdirectory Harbor wrote and read its result.json. With
 * one attempt there is exactly one trial dir matching `<slug>__<id>/`; we pick
 * the first result.json whose JSON carries a `verifier_result`.
 */
export async function readTrialResult(
  jobDir: string,
): Promise<HarborRunResult> {
  const entries = await readdir(jobDir);
  for (const entry of entries) {
    const candidate = join(jobDir, entry, "result.json");
    if (!(await safeExists(candidate))) continue;
    const raw = await readFile(candidate, "utf8");
    const parsed = JSON.parse(raw) as HarborTrialResult;
    if (parsed && typeof parsed === "object" && parsed.verifier_result) {
      return {
        trial: parsed,
        resultPath: candidate,
        trialDir: join(jobDir, entry),
        jobDir,
      };
    }
  }
  throw new Error(`no trial result.json with a verifier_result found under ${jobDir}`);
}

/**
 * Build the `harbor run` argv as a plain array. Pure — no side effects — so it
 * can be unit-tested without spawning anything. The contract this enforces:
 *   - argv array (never a shell string)  → no shell injection
 *   - pinned task revision (`@3`)
 *   - one attempt, one concurrent trial
 *   - output isolated under the per-run jobs dir + job name
 *   - no credentials ever appear in argv (model/agent names only)
 */
export function buildHarborArgv(cfg: HarborConfig, jobsDir: string): string[] {
  const argv = [
    "run",
    "--task", cfg.task,
    "--agent", cfg.agent,
    "--n-attempts", "1",
    "--n-concurrent", "1",
    "--jobs-dir", jobsDir,
    "--job-name", cfg.jobName,
  ];
  if (cfg.model) argv.push("--model", cfg.model);
  if (cfg.env) argv.push("--env", cfg.env);
  return argv;
}

/**
 * Filter the process env down to an explicit allow-list. Pure. Provider keys
 * the selected Harbor agent needs are listed here; anything else (including
 * unrelated secrets) is dropped so it can never leak into logs, deliverables,
 * or metadata. Add keys narrowly — never widen the list casually.
 */
export function buildHarborEnv(
  source: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return filterEnv(source, ENV_ALLOW_LIST);
}

/**
 * Load a fixed, redacted Harbor `result.json` instead of spawning the CLI.
 *
 * This is the test/showcase seam: set `APO_HARBOR_FIXTURE=<path>` and the
 * adapter reads this fixture, producing the exact same `HarborRunResult`
 * shape that `runHarborTrial` would. The full apo pipeline — initialize →
 * turn → session → collectDeliverables → checks — runs for real, against a
 * frozen verdict. No Docker, no network, no provider credentials, no Harbor
 * registry. This is how the three-way verdict is proven in CI.
 */
export async function loadHarborFixture(
  fixturePath: string,
): Promise<HarborRunResult> {
  const raw = await readFile(fixturePath, "utf8");
  const trialDir = dirname(fixturePath);
  return {
    trial: JSON.parse(raw) as HarborTrialResult,
    resultPath: fixturePath,
    trialDir,
    jobDir: dirname(trialDir),
  };
}

/**
 * Preflight: confirm the Harbor binary exists and reports the pinned version.
 * A missing or wrong CLI is an *execution error*, not a test failure — this
 * distinction matters: see count-dataset-tokens.eval.ts.
 */
export async function preflightHarbor(bin = "harbor"): Promise<void> {
  try {
    const { stdout } = await execFileAsync(bin, ["--version"], { shell: false });
    if (!stdout.includes(HARBOR_VERSION)) {
      throw new Error(`harbor ${HARBOR_VERSION} required, got: ${stdout.trim()}`);
    }
  } catch (err) {
    throw new Error(`harbor preflight failed: ${(err as Error).message}`);
  }
}

function filterEnv(
  source: Record<string, string | undefined>,
  allow: readonly string[],
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of allow) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

async function safeExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export { ENV_ALLOW_LIST };
