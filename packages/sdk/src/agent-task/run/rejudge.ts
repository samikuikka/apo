/**
 * Issue #159: replay Phase 2 of a completed Run against its stored
 * Deliverables — without re-running the agent.
 *
 * The backend serves what replay reads (run detail, Deliverable bodies, the
 * pinned Task Definition source, the canonical trace projection) and stores
 * what replay produces (a judgment record — submitted by the CLI, not here).
 * The eval source itself is executed HERE, never in the backend: the
 * definition revision's contract is that the backend stores source as
 * private data and never executes it.
 *
 * Rules this module enforces on itself:
 * - whole-run replay: the full registered check set runs every sample;
 * - the Run must be terminal (passed/failed) and every Deliverable ready —
 *   a missing Deliverable must surface as a refusal, not a low score;
 * - scoring defaults to the Run's pinned definition revision; an explicit
 *   different revision is allowed but reported as unpinned so it can never
 *   be misread as "the same eval, better judge".
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { JudgeConfig } from "../checks/t.ts";
import { resolveJudgeConfig } from "../checks/t.ts";
import {
  loadAndRunFlowChecks,
  proxyBrokenDeliverables,
  runTraceChecks,
} from "../checks/flow-runner.ts";
import { validateDeliverables } from "../deliverables/validate.ts";
import { loadEvalSource } from "../task/loadTask.ts";
import { readTaskRunProjection } from "../trace-projection/remote-capture.ts";
import type { TraceProjectionSnapshot } from "../trace-projection/types.ts";
import { aggregateResult } from "./aggregate.ts";
import type { EvaluationItemResult } from "./types.ts";

/** Backend coordinates for every read replay performs. */
export interface RejudgeEndpoints {
  /** Backend base URL, e.g. ``"http://localhost:8000"``. */
  backendUrl: string;
  /** Project API key (Authorization: Bearer …). Never recorded on judgments. */
  authToken: string;
}

export interface RejudgeOptions {
  /** Judge config for ``t.judge`` calls; the API key stays client-side. */
  judge?: JudgeConfig;
  /** Judge the same Deliverables N times for a per-criterion stability measure. */
  samples?: number;
  /** Score against this revision instead of the Run's pinned one. */
  definitionRevisionId?: string;
  /**
   * Local checkout of the task directory. The stored revision pins only the
   * eval file, so relative imports and `files/` fixtures resolve from here.
   */
  taskDir?: string;
  /** Max wait for the canonical trace projection (default 30s). */
  projectionDeadlineMs?: number;
  /** Progress sink for human-facing operators (CLI prints to stderr). */
  onProgress?: (message: string) => void;
}

/**
 * Per-check pass counts across samples — "fails 2 of 5", not "failed".
 *
 * Samples where the check errored (judge produced no verdict) are tracked
 * in {@link errored} and count as neither pass nor fail: an unreachable
 * judge says nothing about stability, so it must not read as a flaky fail.
 */
export interface RejudgeCheckStability {
  check_id: string;
  passes: number;
  samples: number;
  /** Samples that produced no verdict (judge error) — issue #323. */
  errored?: number;
}

export interface RejudgeOutcome {
  runId: string;
  taskId: string;
  /** Revision the checks were actually scored against. */
  definitionRevisionId: string;
  /** False when an explicit --definition-revision moved the target. */
  definitionRevisionIsPinned: boolean;
  /** Resolved judge config actually used (model + base URL, never the key). */
  judge: { model: string; baseURL?: string } | null;
  samples: number;
  /** Full check results from the primary (first) sample. */
  checks: EvaluationItemResult[];
  pass: boolean;
  /** Only meaningful with samples > 1; ordered like the primary sample. */
  stability: RejudgeCheckStability[];
  /** False when the trace projection was unreadable — trajectory assertions were unsupported. */
  traceSnapshotAvailable: boolean;
  /** The local task dir replay ran against, or null for an isolated scaffold. */
  taskDirUsed: string | null;
}

/** A deliberate, operator-facing replay failure (refusals, bad state). */
export class RejudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RejudgeError";
  }
}

const TERMINAL_VERDICT_STATUSES = new Set(["passed", "failed"]);
const MAX_SAMPLES = 50;

interface RunDetailResponse {
  id: string;
  task_id: string;
  status: string;
  deliverables_json?: Record<string, unknown>;
  task_definition?: { id?: string } | null;
}

interface DeliverablesManifestResponse {
  task_run_id: string;
  items: RunDeliverableItem[];
}

interface RunDeliverableItem {
  id: string;
  name: string;
  kind: string;
  status: string;
  media_type?: string;
  display_filename?: string | null;
}

interface DefinitionSourceResponse {
  task_definition_revision_id: string;
  task_id: string;
  files: Array<{ path: string; content: string }>;
}

export async function rejudgeTaskRun(
  runId: string,
  endpoints: RejudgeEndpoints,
  options: RejudgeOptions = {},
): Promise<RejudgeOutcome> {
  const api = createApiClient(endpoints);
  const progress = options.onProgress ?? (() => {});

  const detail = await api.get<RunDetailResponse>(`/v1/agent-task-runs/${runId}`);
  if (!TERMINAL_VERDICT_STATUSES.has(detail.status)) {
    throw new RejudgeError(
      `Run ${runId} is '${detail.status}', not a completed run with a verdict — ` +
        `there is nothing to replay against yet`,
    );
  }

  // The dedicated manifest endpoint (same one `apo runs deliverable` reads)
  // projects AgentTaskDeliverableDB rows and synthesizes legacy manifests —
  // the run-detail response does not carry it.
  const manifest = await api.get<DeliverablesManifestResponse>(
    `/v1/agent-task-runs/${runId}/deliverables`,
  );
  const items = manifest.items ?? [];
  const notReady = items.filter((item) => item.status !== "ready");
  if (notReady.length > 0) {
    const names = notReady.map((item) => `${item.name} (${item.status})`).join(", ");
    throw new RejudgeError(
      `Refusing to replay run ${runId}: deliverables are not ready: ${names}. ` +
        `A missing deliverable must not render as a low score — re-run the agent instead.`,
    );
  }

  const requestedRevision =
    options.definitionRevisionId ?? detail.task_definition?.id ?? null;
  if (!requestedRevision) {
    throw new RejudgeError(
      `Run ${runId} has no pinned Task Definition Revision — its checks cannot be replayed`,
    );
  }
  const sourceQuery =
    options.definitionRevisionId && options.definitionRevisionId !== detail.task_definition?.id
      ? `?revision=${encodeURIComponent(options.definitionRevisionId)}`
      : "";
  progress(`fetching definition source (${requestedRevision})`);
  const source = await api.get<DefinitionSourceResponse>(
    `/v1/agent-task-runs/${runId}/definition-source${sourceQuery}`,
  );
  const revisionId = source.task_definition_revision_id;
  const revisionIsPinned = revisionId === (detail.task_definition?.id ?? null);
  const evalFile = source.files[0];
  if (!evalFile) {
    throw new RejudgeError(`Definition revision ${revisionId} carries no source files`);
  }

  progress("fetching stored deliverables");
  const artifactDir = mkdtempSync(join(tmpdir(), "apo-rejudge-artifacts-"));
  let scaffoldDir: string | null = null;
  try {
    const taskDir = options.taskDir ?? null;
    scaffoldDir = taskDir ? null : isolatedScaffoldDir();
    const deliverables = await fetchDeliverables(api, runId, items, artifactDir);

    progress("reading canonical trace projection");
    const snapshotResult = await readCanonicalSnapshot(
      endpoints,
      runId,
      options.projectionDeadlineMs,
    );
    if (!snapshotResult.available) {
      progress(
        "trace projection unavailable — trajectory assertions (t.calledTool, …) will be " +
          "recorded as unsupported rather than replayed",
      );
    }
    const snapshot = snapshotResult.snapshot;

    const loaded = await loadEvalSource(evalFile.path, evalFile.content, {
      siblingDir: taskDir,
      isolatedDir: scaffoldDir,
    });
    progress(`loaded eval ${evalFile.path} from revision ${revisionId}`);

    const missingDeliverables = loaded.task.deliverables.filter(
      (name) => !Object.prototype.hasOwnProperty.call(deliverables, name),
    );
    if (missingDeliverables.length > 0) {
      throw new RejudgeError(
        `Refusing to replay run ${runId}: stored deliverables are incomplete; ` +
          `missing ${missingDeliverables.join(", ")}. Re-run the agent instead.`,
      );
    }

    const samples = Math.max(1, Math.min(options.samples ?? 1, MAX_SAMPLES));
    const validation = validateDeliverables(
      loaded.task,
      deliverables,
      loaded.adapter.deliverables,
    );
    const proxied = proxyBrokenDeliverables(deliverables, validation.brokenDeliverables);

    const passCounts = new Map<string, number>();
    const errorCounts = new Map<string, number>();
    let primary: EvaluationItemResult[] = [];
    // Task-level judge config beats the caller-supplied one (#161), same as
    // a live run. The key never reaches the resolved config's report below.
    const judgeConfig = resolveJudgeConfig(options.judge, loaded.task.judge);
    for (let sample = 0; sample < samples; sample++) {
      if (samples > 1) progress(`judging sample ${sample + 1}/${samples}`);
      const results = await runChecksOnce(loaded, proxied, snapshot, judgeConfig);
      if (sample === 0) primary = results;
      for (const result of results) {
        passCounts.set(result.id, (passCounts.get(result.id) ?? 0) + (result.pass ? 1 : 0));
        // A judge error is not a fail: it must not depress the stability
        // reading, only shrink the judged denominator (#323).
        if (!result.pass && result.outcome === "error") {
          errorCounts.set(result.id, (errorCounts.get(result.id) ?? 0) + 1);
        }
      }
    }

    const stability = primary.map((result) => ({
      check_id: result.id,
      passes: passCounts.get(result.id) ?? 0,
      samples,
      ...(errorCounts.get(result.id) ? { errored: errorCounts.get(result.id) } : {}),
    }));
    const aggregate = aggregateResult(primary);

    return {
      runId,
      taskId: detail.task_id,
      definitionRevisionId: revisionId,
      definitionRevisionIsPinned: revisionIsPinned,
      judge: judgeConfig
        ? {
            model: judgeConfig.model,
            baseURL: judgeConfig.baseURL ?? process.env.OPENROUTER_BASE_URL,
          }
        : null,
      samples,
      checks: aggregate.checks,
      pass: aggregate.pass,
      stability,
      traceSnapshotAvailable: snapshotResult.available,
      taskDirUsed: taskDir,
    };
  } finally {
    // Check evidence (judge responses, artifacts re-hydrated to disk) has
    // already been captured into the returned results by the time we get
    // here, so the scratch dirs can go.
    rmSync(artifactDir, { recursive: true, force: true });
    if (scaffoldDir) rmSync(scaffoldDir, { recursive: true, force: true });
  }
}

async function runChecksOnce(
  loaded: Awaited<ReturnType<typeof loadEvalSource>>,
  deliverables: Record<string, unknown>,
  snapshot: TraceProjectionSnapshot,
  judgeConfig: JudgeConfig | undefined,
): Promise<EvaluationItemResult[]> {
  if (loaded.inlineChecks) {
    return runTraceChecks({
      snapshot,
      deliverables,
      files: loaded.files,
      task: loaded.task,
      judgeConfig,
      moduleUrl: loaded.moduleUrl,
      displayFile: loaded.evalFileName,
    });
  }
  return loadAndRunFlowChecks(
    loaded.checksPath,
    {
      snapshot,
      deliverables,
      files: loaded.files,
      task: loaded.task,
      judgeConfig,
    },
    {},
  );
}

async function fetchDeliverables(
  api: ReturnType<typeof createApiClient>,
  runId: string,
  items: RunDeliverableItem[],
  artifactDir: string,
): Promise<Record<string, unknown>> {
  const deliverables: Record<string, unknown> = {};
  for (const [index, item] of items.entries()) {
    if (item.kind === "artifact") {
      const bytes = await api.getBytes(`/v1/agent-task-runs/${runId}/deliverables/${item.id}`);
      const displayFilename = item.display_filename || item.name;
      // display_filename is remote metadata, not a trusted local path. A
      // unique prefix also prevents two artifacts with the same display name
      // from overwriting each other during replay.
      const safeFilename = basename(displayFilename) || "artifact";
      const path = join(artifactDir, `artifact-${index}-${safeFilename}`);
      writeFileSync(path, bytes);
      deliverables[item.name] = Object.freeze({
        kind: "apo.file-artifact",
        path,
        mediaType: item.media_type ?? "application/octet-stream",
        displayFilename,
      });
    } else {
      deliverables[item.name] = await api.getJson(
        `/v1/agent-task-runs/${runId}/deliverables/${item.id}`,
      );
    }
  }
  return deliverables;
}

interface SnapshotRead {
  available: boolean;
  snapshot: TraceProjectionSnapshot;
}

async function readCanonicalSnapshot(
  endpoints: RejudgeEndpoints,
  runId: string,
  deadlineMs: number | undefined,
): Promise<SnapshotRead> {
  try {
    const snapshot = await readTaskRunProjection({
      endpoint: endpoints.backendUrl,
      authToken: endpoints.authToken,
      taskRunId: runId,
      deadlineMs: deadlineMs ?? 15_000,
    });
    return { available: true, snapshot };
  } catch {
    // No claimed trace (409), unreadable projection, or timeout. Fall back
    // to a degenerate snapshot: every capability is honestly unavailable, so
    // trace assertions fail closed as "unsupported" instead of vacuously
    // passing or silently skipping.
    return { available: false, snapshot: degenerateSnapshot(runId) };
  }
}

function degenerateSnapshot(runId: string): TraceProjectionSnapshot {
  return {
    schemaVersion: 1,
    projectionVersion: 1,
    source: "local",
    trace: { traceId: `rejudge-${runId}`, complete: true },
    capabilities: {
      messages: "unavailable",
      tools: "unavailable",
      errors: "unavailable",
      timing: "unavailable",
      skills: "unavailable",
      subagents: "unavailable",
    },
    observations: [],
  };
}

/**
 * Scaffold next to this SDK module for evals without a local task dir.
 * Package imports (`@apo-ai/sdk/agent-task`) resolve from here because the
 * scaffold sits inside the package's module-resolution tree; a system
 * temp dir would have no node_modules above it.
 */
function isolatedScaffoldDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return mkdtempSync(join(here, ".rejudge-scaffold-"));
}

function createApiClient(endpoints: RejudgeEndpoints) {
  const base = endpoints.backendUrl.replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${endpoints.authToken}` };

  async function request(path: string): Promise<Response> {
    const response = await fetch(`${base}${path}`, { headers });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new RejudgeError(
        `${path} failed (${response.status}): ${body.slice(0, 200) || response.statusText}`,
      );
    }
    return response;
  }

  return {
    async get<T>(path: string): Promise<T> {
      return (await request(path).then((r) => r.json())) as T;
    },
    async getJson(path: string): Promise<unknown> {
      return request(path).then((r) => r.json());
    },
    async getBytes(path: string): Promise<Buffer> {
      const buffer = await request(path).then((r) => r.arrayBuffer());
      return Buffer.from(new Uint8Array(buffer));
    },
  };
}
