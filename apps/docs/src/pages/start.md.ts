/**
 * start.md, the agent-readable setup prompt for apo.
 *
 * Served at the configured site origin (import.meta.env.SITE) + /start.md as
 * text/markdown. The "Copy Prompt" button on the landing page copies a
 * one-line instruction that points a coding agent at this URL. The agent
 * fetches it, gets a complete guide,
 * and helps the user set up apo end-to-end.
 *
 * The prompt is intentionally self-contained, it embeds the *why* behind
 * adapters, tracing, and self-hosting, not just the *what*. This lets the
 * agent guide the user through real decisions and troubleshoot without
 * fetching every docs page first. Deeper docs are linked inline for when
 * the agent needs API reference or advanced patterns.
 *
 * Every docs page has a `.md` version (e.g. /concepts/adapters.md).
 * Fetch those instead of the HTML, cleaner, smaller, no chrome.
 */
import type { APIRoute } from 'astro';

const ORIGIN = import.meta.env.SITE;

const START_INSTRUCTIONS = `# Skill: Set up apo and run a first end-to-end test

You are helping the user set up **apo**: a testing and engineering system
for agent harnesses. Your goal: give one real agent task an executable
definition of done, then get a pass/fail result with evidence.

## What apo is (and isn't)

apo turns expected agent behavior into executable tests. It runs the **real**
agent orchestration, and each completed evaluation comes back **pass or fail**
with the test breakdown, trace, and deliverables. A human, CI workflow, or
coding agent can use that evidence to change the system and decide when to run
again. apo itself
does not edit the implementation or autonomously start another Task Run to
improve a failed verdict. Transport or finalization work may retry without
creating a new Task Run.

What apo is **not**: not another eval framework, not a prompt-scoring tool,
and not an observability platform. It doesn't grade the chat conversation, it
judges the **deliverable** (the artifact, file, or structured output the agent
produced).

## How apo works (the 30-second mental model)

1. **You write an adapter**: a small TypeScript module that calls your real
   agent. apo doesn't know how to run your agent; the adapter is the bridge.
   This is the load-bearing piece, without it, nothing runs.

2. **You define a task**: a folder with one \`.eval.ts\` file containing
   \`task()\`, \`turn()\`, and \`test()\` calls. The task says: "run my agent
   against this input, then check these things about what it produced."

3. **apo drives the adapter through a fixed lifecycle:**
   \`initialize → startSession → sendUserTurn (the turn loop) →
   collectDeliverables → cleanup\`. Inside \`sendUserTurn\`, your adapter calls
   the real LLM. After the loop, \`collectDeliverables\` shapes the output into
   structured data the tests assert on.

4. **Tests run against the deliverables and the trace.** Code assertions
   (\`t.calledTool\`, \`t.noFailedActions\`) check what the agent *did* (from
   the trace). Deliverable assertions (\`t.check\`, \`t.judge\`) check what the
   agent *produced*. An LLM judge (\`t.judge\`) can evaluate quality that code
   can't.

5. **Every completed evaluation gets a binary verdict (pass/fail) plus a
   trace.** The trace is the full runtime record, call tree, tokens, messages.
   When evaluation cannot complete, apo surfaces an execution error instead.

> **Deeper docs:** ${ORIGIN}/overview.md (what apo is),
> ${ORIGIN}/concepts/mental-model.md (the canonical vocabulary),
> ${ORIGIN}/why-apo.md (the design reasoning).

---

## Step 1: Discover what the user has

Ask only what you can't determine from their codebase. Treat any prior choice
as binding. Before building, restate the choices as an implementation contract
and confirm with the user.

1. **Do they have a running agent?** An agent = LLM + tools + the code that
   wires them. If they don't have one yet, help them build the smallest useful
   agent first, apo can't test what doesn't exist.

2. **What stack?** This determines how the adapter calls the agent and how
   tracing is set up:
   - **Vercel AI SDK** (\`ai\` package + \`@ai-sdk/openai\` or
     \`@ai-sdk/anthropic\`) → the adapter calls \`generateText()\` /
     \`streamText()\`. Tracing is **automatic**: one \`registerApoTracing()\`
     call at startup + \`experimental_telemetry: { isEnabled: true }\` on the
     call. Zero span code. **This is the recommended path.**
   - **OpenAI Agents SDK / Claude Agent SDK** → these emit OTel natively. Use
     \`registerApoTracing()\` + \`withApoRun()\`. See
     ${ORIGIN}/reference/tracing-integrations.md.
   - **Raw OpenAI/Anthropic SDK** (\`openai\` / \`@anthropic-ai/sdk\` packages)
     → these don't emit OTel. Use the \`createApoOpenAI()\` /
     \`createApoAnthropic()\` wrappers, or the trace primitives manually.
   - **Custom service** (HTTP endpoint, internal library) → the adapter calls
     whatever function runs the agent. Use the trace primitives
     (\`traceRun\`, \`traceTool\`, etc.) manually.
   - **Already-recorded logs** (no live re-run) → if the user has agent runs
     logged as message arrays and can't re-run through an adapter, use flow
     normalizers (\`fromOpenAIMessages\`, \`fromAnthropicMessages\`,
     \`fromAISDK\`) to convert them. See
     ${ORIGIN}/reference/flow-normalizers.md. This is a secondary path, the
     primary path is always the adapter if the agent can run live.

3. **What should the first task test?** Pick the simplest behavior the user
   cares about, one the agent already mostly does right. A good first task:
   one input file, one turn, two tests (one code assertion, one judge). Don't
   start with a complex multi-turn workflow.

4. **Does the user have an apo server to connect to?** Ask: "What's your team's
   apo server URL?" If they don't have one yet, they'll self-host (Path B in
   Step 2). If they do, they just need the CLI (Path A).

---

## Step 2: Get connected to an apo server

There are two paths. **Path A** is for teams with a shared server. **Path B**
is for the first person setting up a new server.

### Path A: Connect to an existing server (most teams)

Invited to a hosted apo? Your Project's Tasks page shows the exact
\`apo login --backend <url> --project <id>\` command to copy, see the
[Hosted Alpha guide](${ORIGIN}/hosted-alpha.md). Everyone else:

Install the CLI from npm:

\`\`\`bash
npm install -g @apo-ai/cli
\`\`\`

Point it at your team's apo server (the backend URL, ask your team lead or
check your deployment docs):

\`\`\`bash
export APO_BACKEND_URL=https://your-apo-server.example.com
\`\`\`

Add this to your shell profile (\`~/.bashrc\`, \`~/.zshrc\`, etc.) so it persists.

Authenticate:

\`\`\`bash
apo login
\`\`\`

Confirm the connection:

\`\`\`bash
apo project list   # should show projects you have access to
\`\`\`

If \`apo login\` fails, check that \`APO_BACKEND_URL\` is reachable:
\`curl -fsS $APO_BACKEND_URL/health/ready\`.

### Path B: Self-host a new server (first setup / solo)

apo is source-open and self-hosted. It runs as a Docker Compose stack:

\`\`\`bash
git clone https://github.com/samikuikka/apo.git apo
cd apo
scripts/self-host init --profile local
scripts/self-host up --build
\`\`\`

**Wait for readiness**: the healthcheck confirms the database, task cache, and
auth are ready:

\`\`\`bash
curl -fsS http://localhost:8000/health/ready | jq
# {"ok": true, ...}
\`\`\`

**Create the admin account:**
1. Open http://localhost:3000 in a browser
2. Create the first admin account (email + password)
3. Install the CLI: \`npm install -g @apo-ai/cli\`
4. Authenticate: \`apo login\` (defaults to \`http://localhost:8000\`)
5. Confirm: \`apo project list\`, should show the default project

> **Deeper docs:** ${ORIGIN}/self-hosting/topology.md (architecture),
> ${ORIGIN}/self-hosting/configuration.md (env vars, ports).

---

## Step 3: Write the adapter

This is the load-bearing step. **apo ships no built-in adapters.** The adapter
is the only place real code runs during a task, it's the bridge between apo's
lifecycle and the user's actual agent.

**Install the SDK in the user's project** (where the adapter and .eval.ts files
will live):

\`\`\`bash
npm install @apo-ai/sdk
\`\`\`

Requires Node.js ≥ 20. TypeScript consumers also install \`@types/node\`.

**Why the adapter exists:** apo can't know how to call your agent. Your agent
might be an OpenAI call, an Anthropic call, a Vercel AI SDK streamText, or a
custom HTTP service. The adapter is a shim that calls your existing code as-is.
You don't change your agent to fit apo; the adapter adapts to your system.

**Canonical example:** apo's repo contains one complete, checked example, a
real Vercel AI SDK agent wired through an adapter to a \`data-extraction\` task.
Inspect and adapt these files rather than writing from scratch:
- Real agent: \`apps/example-service/app/lib/agent/service.ts\`
- Adapter: \`apps/example-service/e2e/agent-task-demo/ai-sdk-adapter.ts\`
- Task: \`apps/example-service/e2e/agent-task-demo/tasks/ai-sdk-agent/data-extraction/\`
- Guide: \`apps/example-service/e2e/agent-task-demo/START-HERE.md\`

**The lifecycle the adapter implements:**

\`\`\`
initialize(ctx)          optional, load task inputs, set up state
  ↓
startSession(ctx)        required, return an object with sendUserTurn
  ↓
sendUserTurn(turn)       apo calls this once per turn, YOUR REAL AGENT CALL GOES HERE
  ↓                       (the turn() fn in the .eval.ts decides when to stop)
collectDeliverables(ctx) required, shape the accumulated state into structured output
  ↓
cleanup(ctx)             optional, tear down
\`\`\`

**Minimal adapter (Vercel AI SDK example):**

\`\`\`typescript
import { readFileSync } from "fs";
import { generateText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { defineAdapter, registerApoTracing } from "@apo-ai/sdk/agent-task";
import { z } from "zod";

// Register the OTel processor once at module load. After this, any
// generateText call with experimental_telemetry enabled is traced
// automatically, spans, tokens, cost, tool calls. Zero span code.
await registerApoTracing();

const client = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const myAdapter = defineAdapter({
  name: "my-agent",
  deliverables: {
    // Declare the structured outputs tests will assert on.
    answer: z.string(),
    toolsUsed: z.array(z.string()),
  },

  async initialize(ctx) {
    const fileContents: Record<string, string> = {};
    for (const f of ctx.files) {
      fileContents[f.relativePath] = readFileSync(f.absolutePath, "utf-8");
    }
    return { messages: [], fileContents, toolCalls: [] };
  },

  async startSession(ctx) {
    const state = ctx.state;
    return {
      // apo calls this once per turn. INSIDE HERE you call your real agent.
      // The Vercel AI SDK emits gen_ai.* OTel spans natively, model name,
      // token usage, tool calls are all captured automatically.
      async sendUserTurn(turn, { trace, parentSpanId, turnNumber }) {
        const userMessage = String(turn);
        state.messages.push({ role: "user", content: userMessage });

        const result = await generateText({
          model: client.chat("gpt-4o"),
          messages: state.messages,
          tools: MY_TOOLS,
          experimental_telemetry: { isEnabled: true }, // ← that's it
        });

        const reply = result.text;
        state.messages.push({ role: "assistant", content: reply });
        state.toolCalls.push(...result.toolCalls.map(tc => tc.toolName));
        return { response: reply };
      },
    };
  },

  async collectDeliverables(ctx) {
    const state = ctx.state;
    const lastMessage = state.messages.at(-1)?.content ?? "";
    return {
      answer: lastMessage,
      toolsUsed: state.toolCalls,
    };
  },
});
\`\`\`

**Critical rules:**
- **\`sendUserTurn\` is where the real LLM call goes.** Not a mock, not a stub.
- **Thread the trace.** This is what makes trace-based assertions work
  (\`t.calledTool\`, \`t.noFailedActions\`, \`t.toolOrder\`). Without it, the
  agent's tool calls aren't recorded and those tests silently fail.
  - Vercel AI SDK (recommended): call \`registerApoTracing()\` once at module
    load, then set \`experimental_telemetry: { isEnabled: true }\` on each
    \`generateText\` / \`streamText\` call. Tracing is fully automatic —
    the example above shows this.
  - OpenAI Agents SDK / Claude Agent SDK: these emit OTel natively. Use
    \`registerApoTracing()\` + wrap your agent call in \`withApoRun()\`.
  - Raw \`openai\` / \`@anthropic-ai/sdk\` packages: these don't emit OTel.
    Use the \`createApoOpenAI()\` / \`createApoAnthropic()\` wrappers.
  - See ${ORIGIN}/reference/tracing-integrations.md for all integrations
    and the escape-hatch trace primitives.
- **\`collectDeliverables\` shapes the output.** The agent's raw response is
  rarely what a test wants. Mine the session state and return structured data
  matching the \`deliverables\` schema.
- **The object you return from \`initialize\` becomes \`ctx.state\`** in every
  subsequent lifecycle method. Use it to accumulate messages, tool calls, etc.
- **The adapter lives in the user's codebase**, not inside the task folder.
  Import it into the \`.eval.ts\` from wherever it naturally lives.

> **Deeper docs:**
> ${ORIGIN}/concepts/adapters.md (why adapters exist, the concept),
> ${ORIGIN}/reference/adapter.md (every field, type, lifecycle
> method),
> ${ORIGIN}/reference/tracing-integrations.md (tracing for OpenAI, Anthropic,
> and Vercel AI SDK).

---

## Step 4: Define a task

A task is a folder with one \`.eval.ts\` file. Create it in the user's task
source directory (typically a \`tasks/\` folder in their repo):

\`\`\`text
tasks/
  my-task/
    my-task.eval.ts       # task() + turn() + test()
    files/                # optional: inputs, auto-discovered
      input.txt
\`\`\`

The \`.eval.ts\` imports the adapter (from wherever it lives), registers the
task, defines the turn behavior, and writes the tests:

\`\`\`typescript
import { task, turn, test, satisfies, includes } from "@apo-ai/sdk/agent-task";
import { myAdapter } from "../../path/to/adapter"; // wherever it lives

// Register: name, adapter, deliverable keys (must match adapter's schema)
task("my-task", {
  adapter: myAdapter,
  deliverables: ["answer", "toolsUsed"],
});

// turn() decides what the agent sees each turn.
// Returning null ends the turn loop, always include this or it loops forever.
turn(async ({ files, transcript }) => {
  if (transcript.length > 0) return null;  // one turn only
  return await files.read("input.txt");
});

// Code assertion: did the agent call the right tool? (reads the trace)
test("used-correct-tool", (t) => {
  t.calledTool("my_tool");
  t.noFailedActions();
});

// Deliverable assertion: is the output correct? (t.check needs a Matcher)
test("answer-is-complete", (t, { deliverables }) => {
  t.check(deliverables.answer.length, satisfies((n: number) => n > 0, "answer is non-empty"));
});

// LLM judge: is the output actually good? (hands it to a judge model)
test("answer-is-accurate", async (t, { deliverables }) => {
  await t.judge(deliverables.answer,
    "PASS when the answer is accurate, complete, and adds nothing false.");
});
\`\`\`

**The test vocabulary:**
- \`t.calledTool(name, opts?)\`, asserts a tool was called (reads the trace)
- \`t.noFailedActions()\`, asserts no tool or subagent errored (anti-flail)
- \`t.maxToolCalls(n)\`, asserts at most N tool calls (anti-flail)
- \`t.toolOrder([names])\`, asserts tools appeared in this order
- \`t.check(value, matcher)\`, asserts on a deliverable value. **Requires a
  Matcher**: use \`satisfies(fn, label)\`, \`includes(needle)\`,
  \`equals(expected)\`, \`matches(schema)\`, or \`similarity(expected, threshold)\`.
- \`t.judge(value, instruction)\`, async; hands value to an LLM judge

> **Deeper docs:**
> ${ORIGIN}/guides/define-a-task.md (end-to-end recipe),
> ${ORIGIN}/concepts/tasks.md (task/turn/test concepts),
> ${ORIGIN}/reference/assertions.md (full assertion API).

---

## Step 5: Run and verify

**The CLI is published to npm** as \`@apo-ai/cli\`. If you installed it globally
in Step 2 (\`npm install -g @apo-ai/cli\`), use \`apo\` directly. If you're running
from the cloned repo, use \`pnpm apo\` instead.

\`\`\`bash
# Verify the CLI works:
apo --version

# Publish the task metadata to apo's catalog:
apo task publish --dir ./my-tasks

# Run the task locally:
apo task run my-task

# Or connect as a persistent executor (dashboard can then dispatch runs to you):
apo connect --dir ./my-tasks
\`\`\`

If evaluation completes, the run produces a **binary verdict**: pass or fail.
An adapter, configuration, or infrastructure failure is reported as an error
instead. Read the exact result:

\`\`\`bash
apo runs show <run-id>        # exact breakdown: which tests passed/failed
apo traces show <trace-id>    # the trace: every call, token, message
\`\`\`

**See results in the dashboard:** open your team's apo dashboard URL (the
frontend for the server you configured in Step 2), go to the task or runs page —
you'll see the verdict, cost, tokens, duration, and a full trace breakdown.

**If it fails** (expected on the first try):
1. Capture the run id printed by \`apo task run\` and inspect that exact run
2. Read which test failed and its reasoning (\`apo runs show <run-id>\`)
3. Open the matching trace to see what the agent actually did
4. Treat the confirmed task, tests, and fixtures as read-only; fix the agent code
5. Re-run with a limit of 5 Task Runs, stopping earlier on pass, error, or two
   iterations without progress

If the loop stops without a pass, report the failed tests, trace evidence,
changes tried, and the next hypothesis to the user. Never weaken the definition
of done to make the result green.

This loop (run → read failure → trace → fix → re-run) is the core apo
workflow. A coding agent can drive it without a human watching every run, while
the confirmed behavioral contract and stopping policy stay fixed.

> **Deeper docs:**
> ${ORIGIN}/guides/run-and-debug.md (the debug loop),
> ${ORIGIN}/guides/loop-engineering.md (letting a coding agent close
> the loop autonomously),
> ${ORIGIN}/cli.md (full CLI command reference).

---

## Verify

Before declaring done, confirm:
- [ ] The CLI is installed (\`apo --version\` works)
- [ ] The CLI can reach the server (\`apo project list\` works)
- [ ] The adapter calls the user's real agent orchestration in the chosen test environment
- [ ] The trace context is threaded (tool calls appear in traces)
- [ ] At least one task exists with tests (\`apo task list\` shows it)
- [ ] \`apo task run my-task\` produces a verdict (pass or fail), or an explicit execution error to resolve
- [ ] The user knows how to read the breakdown and trace on failure

Restate the final state: task name, adapter name, verdict, and next steps.

---

## Constraints

- **Never invent API keys or credentials.** Scaffold \`process.env.X\`
  placeholders and tell the user to provide real values.
- **Never skip the adapter step.** Without it, tests cannot run. The agent
  under test is not a fixture, it lives behind the user's adapter.
- **Never mock the agent.** The whole point of apo is testing the real thing.
  If the user suggests mocking "just to get it working," push back.
- **Thread the trace.** Without it, trace-based assertions silently fail and
  the trace (the primary debugging surface) is empty.
- **Prefer the CLI** over the website for command details: \`apo --help\`,
  \`apo <command> --help\`. The CLI output is parseable.
- **The trace is mandatory for debugging.** When a run fails, always look at
  the trace before suggesting a fix. Guessing without it wastes time.

---

## Quick reference: all docs pages (fetch the .md version)

| Topic | URL |
|---|---|
| What apo is | ${ORIGIN}/overview.md |
| Why apo (design reasoning) | ${ORIGIN}/why-apo.md |
| Quickstart (human steps) | ${ORIGIN}/quickstart.md |
| Hosted alpha (invited users) | ${ORIGIN}/hosted-alpha.md |
| Mental model (vocabulary) | ${ORIGIN}/concepts/mental-model.md |
| Adapters concept | ${ORIGIN}/concepts/adapters.md |
| Adapter API reference | ${ORIGIN}/reference/adapter.md |
| Tasks concept | ${ORIGIN}/concepts/tasks.md |
| Tests concept | ${ORIGIN}/concepts/tests.md |
| Assertions API reference | ${ORIGIN}/reference/assertions.md |
| Traces concept | ${ORIGIN}/concepts/traces.md |
| Schedules concept | ${ORIGIN}/concepts/schedules.md |
| Define a task (guide) | ${ORIGIN}/guides/define-a-task.md |
| Run and debug (guide) | ${ORIGIN}/guides/run-and-debug.md |
| Loop engineering (guide) | ${ORIGIN}/guides/loop-engineering.md |
| Self-hosting topology | ${ORIGIN}/self-hosting/topology.md |
| Self-hosting configuration | ${ORIGIN}/self-hosting/configuration.md |
| Reference overview | ${ORIGIN}/reference/overview.md |
| Tracing SDK (@apo-ai/sdk) | ${ORIGIN}/reference/tracing.md |
| Tracing integrations | ${ORIGIN}/reference/tracing-integrations.md |
| Flow normalizers | ${ORIGIN}/reference/flow-normalizers.md |
| CLI reference | ${ORIGIN}/cli.md |
`;

export const GET: APIRoute = () => {
	return new Response(START_INSTRUCTIONS, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Cache-Control': 'public, max-age=60',
		},
	});
};
