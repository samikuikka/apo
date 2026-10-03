// Validation campaign — three-way agreement:
// single-shot judge vs agentic judge (the REAL SDK t.agent session) vs the
// deterministic dabstep gold (recorded answer-matches-benchmark per run).
//
//   node --experimental-strip-types campaign.mjs \
//     --judges single,agent --models deepseek/deepseek-v4.1-flash --samples 1
//
// Cross-project batches: the runs list is project-scoped by the token, so a
// second project's runs are fed via --ids-file (one run id per line) plus
// APO_CAMPAIGN_KEY / APO_CAMPAIGN_BASE overrides. --skip-existing leaves
// session files that are already on disk untouched (merge across batches).
//
// Output: campaign-sessions/*.json (+ report via report.py, which reads the
// whole directory — every transcript is retained as the audit artifact).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { runAgentSession } from "../../src/agent-task/checks/agent-session.ts";
import { freezeHistoryPlane } from "../../src/agent-task/checks/agent-history.ts";

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const JUDGES = (flag("judges", "single,agent")).split(",");
const MODELS = (flag("models", "deepseek/deepseek-v4.1-flash")).split(",");
const SAMPLES = parseInt(flag("samples", "1"), 10);
const LIMIT = parseInt(flag("limit", "0"), 10); // 0 = all
const IDS_FILE = flag("ids-file", "");
const SKIP_EXISTING = argv.includes("--skip-existing");
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

// The validated rubric family (prototype NOTES + spec 202): does the answer
// respond to the question the task actually asked, per the run's own work.
const RUBRIC = [
  "You are judging a completed data-analysis agent run (the run under judgment).",
  "PASS if the submitted final answer responds to the question the task actually asked,",
  "as evidenced by the run's own work (deliverables, especially tool_log).",
  "FAIL if the answer computes a plausible but DIFFERENT quantity than the task asked for,",
  "or is unsupported by the work shown.",
  "Explicitly adjudicate: an answer that is numerically plausible but answers a different",
  "slice/variant of the question is a FAIL. Investigate before deciding.",
].join(" ");

const SINGLE_SHOT_SYSTEM =
  "You are an evaluation judge. Evaluate the given value(s) against the instruction. " +
  'Respond with JSON: {"reasoning": "...", "pass": true|false}.';

// ── Backend (read-only; env overrides let one campaign span projects) ──────
const creds = JSON.parse(readFileSync(`${process.env.HOME}/.apo/credentials`, "utf8"));
const BASE = process.env.APO_CAMPAIGN_BASE ?? creds.backend_url;
const KEY = process.env.APO_CAMPAIGN_KEY ?? creds.api_key;
const reader = {
  async get(path) {
    const res = await fetch(`${BASE}/v1${path}`, { headers: { Authorization: `Bearer ${KEY}` } });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return res.json();
  },
};

async function fetchRunBundle(runId) {
  const detail = await reader.get(`/agent-task-runs/${runId}`);
  const checks = typeof detail.checks_json === "string" ? JSON.parse(detail.checks_json) : detail.checks_json;
  let task_description;
  try {
    const src = await reader.get(`/agent-task-runs/${runId}/definition-source`);
    const evalFile = (src.files ?? []).find((f) => f.path.endsWith(".eval.ts"));
    const m = evalFile?.content.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
    if (m) task_description = m[1].replaceAll('\\"', '"');
  } catch { /* definition source unavailable — judge must cope */ }
  const deliverables = {};
  const dl = await reader.get(`/agent-task-runs/${runId}/deliverables`);
  for (const item of dl.items ?? []) {
    const body = await fetch(`${BASE}${item.download_url}`, {
      headers: { Authorization: `Bearer ${KEY}` },
    }).then((r) => r.text());
    deliverables[item.name] = body;
  }
  return { detail, checks: checks ?? [], task_description, deliverables };
}

// ── Judges ─────────────────────────────────────────────────────────────────
async function singleShotJudge(bundle, model) {
  const answer = bundle.deliverables.answer ?? "(missing)";
  const user = [
    `Task description: ${bundle.task_description ?? "(unavailable)"}`,
    "",
    "Values to evaluate:",
    `  answer: ${answer}`,
    "",
    "Instruction:",
    RUBRIC,
  ].join("\n");
  const t0 = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    // OpenRouter can queue long; a single-shot call that never returns would
    // hang the whole campaign, so bound it well above any observed p95.
    signal: AbortSignal.timeout(180_000),
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SINGLE_SHOT_SYSTEM },
        { role: "user", content: user },
      ],
    }),
  }).then((r) => r.json());
  const text = res.choices?.[0]?.message?.content ?? "";
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* unparseable */ } }
  }
  const hasVerdict = parsed && typeof parsed.pass === "boolean" && typeof parsed.reasoning === "string";
  return {
    judge: "single",
    model,
    outcome: hasVerdict ? "verdict" : "no_verdict",
    pass: hasVerdict ? parsed.pass : false,
    reasoning: hasVerdict ? parsed.reasoning : `UNPARSEABLE: ${text.slice(0, 300)}`,
    steps: 1,
    cost_usd: res.usage?.cost ?? null,
    latency_ms: Date.now() - t0,
    tokens: { input: res.usage?.prompt_tokens, output: res.usage?.completion_tokens },
  };
}

async function agenticJudge(bundle, model, runId) {
  const history = await freezeHistoryPlane({ reader, taskId: bundle.detail.task_id, selfRunId: runId });
  const result = await runAgentSession({
    instruction: RUBRIC,
    model,
    apiKey: process.env.OPENROUTER_API_KEY,
    evidence: { deliverables: bundle.deliverables, history },
    scope: {
      taskId: bundle.detail.task_id,
      taskDescription: bundle.task_description,
      checkName: "campaign-agentic",
    },
  });
  const usedHistory = (result.session.steps ?? []).some((s) =>
    (s.tool_calls ?? []).some((c) => c.name === "get_run" || c.name === "list_runs"));
  return {
    judge: "agent",
    model,
    outcome: result.outcome,
    pass: result.verdict?.pass ?? false,
    reasoning: result.verdict?.reasoning ?? null,
    steps: result.session.usage?.steps ?? (result.session.steps ?? []).length,
    cost_usd: result.cost ?? null,
    latency_ms: result.latency_ms,
    tokens: result.usage,
    used_history_tools: usedHistory,
    session: result.session,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────
mkdirSync("campaign-sessions", { recursive: true });
let runs;
if (IDS_FILE) {
  // Explicit run ids (cross-project batches the token's list view can't see).
  const ids = readFileSync(IDS_FILE, "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
  runs = [];
  for (const id of ids) runs.push(await reader.get(`/agent-task-runs/${id}`));
} else {
  const list = await reader.get("/agent-task-runs?limit=100");
  runs = list
    .filter((r) => `${r.task_id}`.includes("dabstep") && (r.status === "passed" || r.status === "failed"))
    .sort((a, b) => `${a.task_id}${a.started_at}`.localeCompare(`${b.task_id}${b.started_at}`));
}
if (LIMIT > 0) runs = runs.slice(0, LIMIT);
console.log(`gold candidates: ${runs.length} runs (judges: ${JUDGES.join("+")}, models: ${MODELS.join(",")}, samples: ${SAMPLES}${SKIP_EXISTING ? ", skip-existing" : ""})`);

const sessionPath = (job) =>
  `campaign-sessions/${job.runId}_${job.judge}_${job.model.replaceAll("/", "_")}_s${job.sample}.json`;

const jobs = [];
const bundles = new Map();
for (const r of runs) {
  if (SKIP_EXISTING && existsSync(`campaign-sessions/${r.id}_agent_${MODELS[0].replaceAll("/", "_")}_s0.json`) &&
      existsSync(`campaign-sessions/${r.id}_single_${MODELS[0].replaceAll("/", "_")}_s0.json`)) {
    continue; // both arms already judged — keep the original session files
  }
  if (!bundles.has(r.id)) bundles.set(r.id, await fetchRunBundle(r.id));
  const bundle = bundles.get(r.id);
  for (let s = 0; s < SAMPLES; s++) {
    if (JUDGES.includes("single")) {
      for (const model of MODELS) jobs.push({ runId: r.id, bundle, judge: "single", model, sample: s });
      if (!SKIP_EXISTING || !existsSync(`campaign-sessions/${r.id}_single_${DEFAULT_MODEL.replaceAll("/", "_")}_s0.json`)) {
        jobs.push({ runId: r.id, bundle, judge: "single", model: DEFAULT_MODEL, sample: s });
      }
    }
    if (JUDGES.includes("agent")) {
      for (const model of MODELS) jobs.push({ runId: r.id, bundle, judge: "agent", model, sample: s });
    }
  }
}

const results = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const tag = `${job.runId}|${job.judge}|${job.model}|s${job.sample}`;
    try {
      const res = job.judge === "single"
        ? await singleShotJudge(job.bundle, job.model)
        : await agenticJudge(job.bundle, job.model, job.runId);
      results.push({ run_id: job.runId, task_id: job.bundle.detail.task_id, sample: job.sample, ...res });
      writeFileSync(sessionPath(job), JSON.stringify(res, null, 2));
      console.log(`[${results.length}/${jobs.length}] ${tag} -> ${res.outcome} pass=${res.pass} steps=${res.steps} $${res.cost_usd ?? "?"} ${(res.latency_ms / 1000).toFixed(0)}s`);
    } catch (error) {
      results.push({
        run_id: job.runId, task_id: job.bundle.detail.task_id, sample: job.sample,
        judge: job.judge, model: job.model, outcome: "error", pass: false,
        reasoning: String(error?.message ?? error), steps: 0, cost_usd: null, latency_ms: null,
      });
      console.log(`[${results.length}/${jobs.length}] ${tag} -> ERROR ${error?.message}`);
    }
  }
}
await Promise.all(Array.from({ length: 4 }, worker));

// Report generation lives in report.py (reads campaign-sessions/), so a
// skip-existing merge run doesn't produce a partial in-memory report.
console.log(`done: ${results.length} new sessions (${jobs.length} jobs), report via python3 report.py`);
