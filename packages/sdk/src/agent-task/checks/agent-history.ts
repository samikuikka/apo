/**
 * The history plane for `t.agent` — read-only access to this task's prior
 * runs through the same backend the executor already talks to. Credentials
 * are the executor's own (staged-auth decision: the fixed, read-only tool
 * surface is the permission boundary; a dedicated judge token arrives only
 * if external harnesses ever hold the tools).
 *
 * History is FROZEN once per evaluation: the run list is fetched a single
 * time and every check's session sees the same snapshot, so concurrent
 * checks never disagree about what "previous attempts" means. Per-run detail
 * is a lazy GET against a frozen id — new runs appearing mid-evaluation are
 * simply not part of this judgment's world.
 */

/** Minimal GET-only view of the backend the history tools may use. */
export type BackendReader = {
  /** GET a JSON path under the backend's /v1 prefix; throws on non-2xx. */
  get(path: string): Promise<unknown>;
};

/** One prior attempt of this task, as frozen at evaluation start. */
export type FrozenRunSummary = {
  id: string;
  status: string;
  passed: boolean | null;
  started_at?: string;
  primary_model?: string | null;
  passed_checks?: number | null;
  failed_checks?: number | null;
  corrected_tests?: unknown[];
  /** True when this entry IS the run under judgment. */
  is_run_under_judgment?: boolean;
};

/** A prior run's full check report (merged view, like the run detail page). */
export type HistoryRunDetail = {
  id: string;
  status: string;
  checks: {
    id: string;
    pass: boolean;
    evaluator: string;
    reasoning?: string;
    assertions?: { pass: boolean; expected?: string; received?: string }[];
  }[];
  /** Human corrections recorded against this run; "none" when empty. */
  human_corrections: unknown[] | "none";
};

/**
 * Build a reader from the executor's environment. Returns undefined when no
 * credentials are present — callers surface that honestly (the history plane
 * is simply unavailable) rather than degrading to anonymous requests.
 */
export function createBackendReaderFromEnv(env = process.env): BackendReader | undefined {
  const token = env.APO_AUTH_TOKEN;
  const publicKey = env.APO_PUBLIC_KEY;
  const secretKey = env.APO_SECRET_KEY;
  const headers: Record<string, string> | undefined = token
    ? { Authorization: `Bearer ${token}` }
    : publicKey && secretKey
      ? { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` }
      : undefined;
  if (!headers) return undefined;

  const endpoint = env.AGENT_TASK_TRACE_ENDPOINT ?? "http://127.0.0.1:8000";
  return {
    async get(path: string): Promise<unknown> {
      const res = await fetch(`${endpoint.replace(/\/$/, "")}/v1${path}`, { headers });
      if (!res.ok) {
        throw new Error(`history read failed: GET ${path} -> ${res.status}`);
      }
      return res.json();
    },
  };
}

/** The frozen evidence plane handed to every `t.agent` session. */
export type AgentHistoryPlane = {
  /** Prior attempts of this task, frozen at evaluation start. */
  runs: FrozenRunSummary[];
  /**
   * Fetch one prior run's merged check report. The run-under-judgment id
   * returns an honest "you are deciding this run" answer instead of data
   * whose checks are still being evaluated.
   */
  getRun(runId: string): Promise<HistoryRunDetail | { error: string }>;
  /** The backend's id for the run under judgment, when known. */
  selfRunId?: string;
};

/**
 * Freeze the history plane for one evaluation: a single list fetch, cached
 * detail fetches (a run the judge reads twice costs one GET), self excluded
 * from detail reads.
 */
export function freezeHistoryPlane(args: {
  reader: BackendReader;
  taskId: string;
  selfRunId?: string;
}): Promise<AgentHistoryPlane> {
  const { reader, taskId, selfRunId } = args;
  const detailCache = new Map<string, HistoryRunDetail>();

  const loadRuns = (async () => {
    const raw = (await reader.get(
      `/agent-task-runs?task_id=${encodeURIComponent(taskId)}&limit=50`,
    )) as Array<Record<string, unknown>>;
    return (raw ?? []).map(
      (r): FrozenRunSummary => ({
        id: String(r.id),
        status: String(r.status ?? "unknown"),
        passed: typeof r.pass_result === "boolean" ? r.pass_result : null,
        ...(typeof r.started_at === "string" ? { started_at: r.started_at } : {}),
        ...(r.primary_model != null ? { primary_model: r.primary_model as string } : {}),
        ...(typeof r.passed_checks === "number" ? { passed_checks: r.passed_checks } : {}),
        ...(typeof r.failed_checks === "number" ? { failed_checks: r.failed_checks } : {}),
        ...(Array.isArray(r.corrected_tests) ? { corrected_tests: r.corrected_tests } : {}),
        ...(selfRunId && r.id === selfRunId ? { is_run_under_judgment: true } : {}),
      }),
    );
  })();

  return loadRuns.then((runs) => ({
    runs,
    ...(selfRunId ? { selfRunId } : {}),
    async getRun(runId: string): Promise<HistoryRunDetail | { error: string }> {
      if (runId === selfRunId) {
        return {
          error:
            "this is the run under judgment — its verdict is what this session decides; " +
            "use list_runs to inspect prior attempts",
        };
      }
      const known = runs.find((r) => r.id === runId);
      if (!known) return { error: "run not in this task's history" };

      const cached = detailCache.get(runId);
      if (cached) return cached;

      const raw = (await reader.get(`/agent-task-runs/${encodeURIComponent(runId)}`)) as Record<string, unknown>;
      const checks = typeof raw.checks_json === "string" ? JSON.parse(raw.checks_json) : raw.checks_json;
      const detail: HistoryRunDetail = {
        id: runId,
        status: String(raw.status ?? known.status),
        checks: (Array.isArray(checks) ? checks : []).map(
          (c: Record<string, unknown>) => ({
            id: String(c.id ?? "check"),
            pass: Boolean(c.pass),
            evaluator: String(c.evaluator_type ?? "code"),
            ...(typeof c.reasoning === "string" && c.reasoning.length > 0
              ? { reasoning: c.reasoning.slice(0, 500) }
              : {}),
            ...(Array.isArray(c.assertions)
              ? {
                  assertions: (c.assertions as Record<string, unknown>[]).map((a) => ({
                    pass: Boolean(a.pass),
                    ...(a.expected !== undefined ? { expected: String(a.expected).slice(0, 200) } : {}),
                    ...(a.received !== undefined ? { received: String(a.received).slice(0, 200) } : {}),
                  })),
                }
              : {}),
          }),
        ),
        human_corrections:
          Array.isArray(known.corrected_tests) && known.corrected_tests.length > 0
            ? known.corrected_tests
            : "none",
      };
      detailCache.set(runId, detail);
      return detail;
    },
  }));
}

/**
 * Freeze the history plane from the executor environment for one evaluation.
 * Returns undefined when credentials are absent or the list fetch fails —
 * `t.agent` then judges without history (briefing says so honestly); a
 * history outage must never fail a run that can otherwise be evaluated.
 */
export async function freezeHistoryPlaneFromEnv(
  taskId: string,
  env = process.env,
): Promise<AgentHistoryPlane | undefined> {
  const reader = createBackendReaderFromEnv(env);
  if (!reader) return undefined;
  try {
    return await freezeHistoryPlane({
      reader,
      taskId,
      ...(env.AGENT_TASK_RUN_ID ? { selfRunId: env.AGENT_TASK_RUN_ID } : {}),
    });
  } catch {
    return undefined;
  }
}
