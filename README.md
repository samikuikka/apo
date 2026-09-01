<p align="center">
  <img src="apps/dashboard/public/brand/signal-sphere.svg" width="96" alt="Apo" />
</p>

<h1 align="center">Apo</h1>

<p align="center">
  Give every agent task a definition of done.
</p>

<p align="center">
  <a href="https://docs.test-apo.online/">Docs</a> ·
  <a href="https://docs.test-apo.online/quickstart/">Quickstart</a> ·
  <a href="https://docs.test-apo.online/llms.txt">Docs for agents</a> ·
  <a href="PROJECT-BELIEFS.md">Beliefs</a> ·
  <a href="docs/self-hosted-alpha.md">Self-hosting</a>
</p>

<p align="center">
  <a href="https://app.codspeed.io/samikuikka/apo?utm_source=badge"><img src="https://img.shields.io/endpoint?url=https://codspeed.io/badge.json" alt="CodSpeed"/></a>
</p>

---

Apo is an opinionated end-to-end testing framework for agent systems. Define the behavior you expect as executable tests, run your **real agent implementation**, and get a **binary verdict** — pass or fail — backed by the test breakdown, trace, and deliverables. Execution problems are surfaced separately as errors.

It is not a prompt-scoring tool, an LLM-call optimizer, or an observability dashboard. It answers a more useful engineering question: **did the agent system actually do what we said it must do?**

> **Coding agent?** The docs are machine-readable: fetch [`docs.test-apo.online/llms.txt`](https://docs.test-apo.online/llms.txt) for the full index (every page has a `.md` rendition), or [`docs.test-apo.online/start.md`](https://docs.test-apo.online/start.md) for a complete setup skill.

## Close the loop

```text
expected behavior
       ↓
run the real agent
       ↓
PASS / FAIL + tests + trace + deliverables
       ↓
improve the implementation
       ↺
```

Apo owns one Task Run and the evidence it produces. A developer, CI workflow, or coding agent reads that evidence, changes the system, and decides whether to start another Task Run. Apo does not edit your agent or autonomously rerun a failed task to improve it.

## The model

| Term | Meaning |
|---|---|
| **Task** | One reusable validation case with inputs, an adapter, and tests. |
| **Task Run** | One execution of one task. A completed evaluation produces pass or fail; execution failures surface as errors. |
| **Batch Run** | One container that may produce one or more task runs. |
| **Test** | One assertion within a task — deterministic code or an LLM-backed judgment. |
| **Trace** | The runtime debugging surface — a core product surface, not garnish. |

The full reasoning lives in [`PROJECT-BELIEFS.md`](PROJECT-BELIEFS.md).

## Self-host

Apo runs on a single host. Bring up the backend, dashboard, and database with the self-host helper, which generates the `AUTH_SECRET` for you before anything starts:

```bash
git clone https://github.com/samikuikka/apo.git
cd apo
scripts/self-host init --profile local
scripts/self-host up --build
# dashboard  → http://localhost:3000
# readiness  → curl -fsS http://localhost:8000/health/ready | jq
```

Operator guide — single-host topology, env vars, TLS, deployment profiles — is in [`docs/self-hosted-alpha.md`](docs/self-hosted-alpha.md).

To make the same installation reachable by teammates and sandboxed agents, switch to the server profile with `scripts/self-host init --profile server` and bring it up:

```bash
scripts/self-host up --build
# dashboard  → https://apo.example.com
# CLI API    → https://apo.example.com/backend-proxy
# OTLP       → https://apo.example.com/api/public/otel/v1/traces
```

## Define a task

A task is a folder convention, not a config file you fight with:

```text
data-extraction/
  data-extraction.eval.ts   # definition + turn behavior + all tests
  files/                    # files available to the task, auto-discovered
```

A real task from this repo, lightly trimmed. It layers three kinds of test: a deterministic trajectory check, a deterministic fact check, and an LLM judge.

```typescript
import { task, test, includes, satisfies, filePaths } from "@apo-ai/sdk/agent-task";
import { invoiceAgentAdapter } from "./adapter";

task("data-extraction", {
  adapter: invoiceAgentAdapter,
  description: "Extract structured data from an invoice document.",
  maxTurns: 2,
  deliverables: ["result", "tool_log", "stats"],
});

// Layer 1: trajectory — did the agent actually read the file and use the tools,
// or answer from memory? A plausible-sounding answer fails here.
test("used-extraction-workflow", (t) => {
  t.calledTool("list_files");
  t.calledTool("read_file", { input: { path: /invoice\.txt/ } });
  t.calledTool("extract_entities");
  t.noFailedActions();
});

// Layer 2: objective facts — verifiable values the agent can't fake.
test("extracted-all-key-fields", (t, { deliverables }) => {
  const findings = deliverables.result.findings;
  t.check(findings, includes("INV-2024-00847"));
  t.check(findings, includes("9,376.60"));
  t.check(findings, includes("Net 30"));
  t.check(
    deliverables.stats.total_tool_calls,
    satisfies((n: number) => n >= 2, "used at least 2 tools"),
  );
});

// Layer 3: judged quality — the subjective dimensions code can't assess.
test("findings-grounded-in-invoice", async (t, { deliverables }) => {
  await t.judge(
    deliverables.result.findings,
    "PASS if every number, date, name, and email can be traced to the invoice. FAIL if any value is fabricated or generic.",
  );
});
```

Deterministic tests pin down objective facts so judges can't be gamed by plausible-sounding hallucinations. Judges assess the quality code can't. A task with only one layer is either too weak or too flaky — so real tasks layer both.

## Run it

The CLI talks to your self-hosted instance. Install it once, authenticate, point at a project, then run and inspect tasks:

```bash
npm install -g @apo-ai/cli   # one-time: install the Apo CLI
apo login                   # one-time: save credentials to ~/.apo/credentials
apo project list            # pick a project
apo project use <id>        # set it as the current project
apo task list               # see available tasks
apo task run data-extraction    # completed evaluation → binary verdict; execution errors exit 2
apo task show data-extraction   # test breakdown: which passed, which failed
apo traces show <run-id>        # debug the failure
```

## Schedules are policy, not cron

Test importance isn't hardcoded in the task. Schedules say *how often* each subset runs — full suite nightly, smoke on every commit, regression on release. Different subsets have different operational value and different cost, so teams choose cadence per subset.

## Traces

Every failing run is debuggable through traces: parent/child call relationships, token usage, model parameters, the actual messages exchanged. The trace is the first place you go when a run fails — that's by design, not an afterthought.

## Status

Apo is in alpha. The single-host self-hosted topology is the only supported deployment shape; horizontal scaling, multi-replica backends, and queue brokers are explicitly out of scope for now. See [`docs/self-hosted-alpha.md`](docs/self-hosted-alpha.md) for what the alpha contract covers.

## License

[MIT](LICENSE).
