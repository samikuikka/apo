/**
 * start.md — the agent-readable setup prompt for apo.
 *
 * Served at https://apo.dev/start.md as text/markdown. The "Copy Prompt"
 * button on the landing page copies a one-line instruction that points a
 * coding agent at this URL. The agent fetches it, gets a complete guide,
 * and helps the user set up apo end-to-end.
 *
 * The prompt is intentionally self-contained — it embeds the *why* behind
 * adapters, tracing, and self-hosting, not just the *what*. This lets the
 * agent guide the user through real decisions and troubleshoot without
 * fetching every docs page first. Deeper docs are linked inline for when
 * the agent needs API reference or advanced patterns.
 *
 * Every docs page has a `.md` version (e.g. /concepts/adapters.md).
 * Fetch those instead of the HTML — cleaner, smaller, no chrome.
 */
import type { APIRoute } from 'astro';

const START_INSTRUCTIONS = `# Skill: Set up apo and run a first task

You are helping the user set up **apo** — an opinionated testing framework for
agent systems. Your goal: get the user from zero to a real run result — a task
that passes or fails against their actual agent.

## What apo is (and isn't)

apo is a testing framework for AI agents, the same way Jest or pytest is for
code. You write tests that say what "good" means, apo runs the **real** agent
(not a mock), and each run comes back **pass or fail**. When it fails, a trace
shows exactly what the agent did wrong.

What apo is **not**: it's not a prompt-scoring tool, not an LLM-call optimizer,
and not an observability dashboard. It doesn't grade the chat conversation — it
judges the **deliverable** (the artifact, file, or structured output the agent
produced).

## How apo works (the 30-second mental model)

1. **You write an adapter** — a small TypeScript module that calls your real
   agent. apo doesn't know how to run your agent; the adapter is the bridge.
   This is the load-bearing piece — without it, nothing runs.

2. **You define a task** — a folder with one \`.eval.ts\` file containing
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

5. **Every run gets a binary verdict (pass/fail) plus a trace.** The trace is
   the full runtime record — call tree, tokens, messages. When a run fails, the
   trace is where you find out why.

> **Deeper docs:** https://apo.dev/overview.md (what apo is),
> https://apo.dev/concepts/mental-model.md (the canonical vocabulary),
> https://apo.dev/why-apo.md (the design reasoning).

---

## Step 1: Discover what the user has

Ask only what you can't determine from their codebase. Treat any prior choice
as binding. Before building, restate the choices as an implementation contract
and confirm with the user.

1. **Do they have a running agent?** An agent = LLM + tools + the code that
   wires them. If they don't have one yet, help them build the smallest useful
   agent first — apo can't test what doesn't exist.

2. **What stack?** This determines how the adapter calls the agent and how
   tracing is set up:
   - **Vercel AI SDK** (\`ai\` package + \`@ai-sdk/openai\` or
     \`@ai-sdk/anthropic\`) → the adapter calls \`generateText()\` /
     \`streamText()\`. Tracing is **automatic** — one \`registerApoTracing()\`
     call at startup + \`experimental_telemetry: { isEnabled: true }\` on the
     call. Zero span code. **This is the recommended path.**
   - **OpenAI Agents SDK / Claude Agent SDK** → these emit OTel natively. Use
     \`registerApoTracing()\` + \`withApoRun()\`. See
     https://apo.dev/reference/tracing-integrations.md.
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
     https://apo.dev/reference/flow-normalizers.md. This is a secondary path — the
     primary path is always the adapter if the agent can run live.

3. **What should the first task test?** Pick the simplest behavior the user
   cares about — one the agent already mostly does right. A good first task:
   one input file, one turn, two tests (one code assertion, one judge). Don't
   start with a complex multi-turn workflow.

4. **Is apo already running?** Check if the user has an instance at
   \`localhost:3000\` (dashboard) and \`localhost:8000\` (backend). If yes,
   skip to Step 3. If no, proceed to Step 2.

---

## Step 2: Self-host the apo stack

apo is source-open and self-hosted. It runs as a Docker Compose stack:

\`\`\`bash
git clone https://github.com/samikuikka/apo.git apo
cd apo
docker compose up -d --build
\`\`\`

**Why self-host?** apo runs your agent — the real thing, your code, your API
keys. Hosting it yourself means your data and your agent's behavior never leave
your infrastructure. You own the runtime.

**Wait for readiness** — the healthcheck confirms the database, task cache, and
auth are ready, not just that the process booted:

\`\`\`bash
curl -fsS http://localhost:8000/health/ready | jq
# {"ok": true, ...}
\`\`\`

**Create the admin account:**
1. Open http://localhost:3000 in a browser
2. Create the first admin account (email + password)
3. Authenticate the CLI: \`pnpm apo login\`
4. Confirm: \`pnpm apo project list\` — should show the default project

> **Deeper docs:** https://apo.dev/self-hosting/topology.md (architecture),
> https://apo.dev/self-hosting/configuration.md (env vars, ports).

---

## Step 3: Write the adapter

This is the load-bearing step. **apo ships no built-in adapters.** The adapter
is the only place real code runs during a task — it's the bridge between apo's
lifecycle and the user's actual agent.

**Why the adapter exists:** apo can't know how to call your agent. Your agent
might be an OpenAI call, an Anthropic call, a Vercel AI SDK streamText, or a
custom HTTP service. The adapter is a shim that calls your existing code as-is.
You don't change your agent to fit apo; the adapter adapts to your system.

**The lifecycle the adapter implements:**

\`\`\`
initialize(ctx)          optional — load task inputs, set up state
  ↓
startSession(ctx)        required — return an object with sendUserTurn
  ↓
sendUserTurn(turn)       apo calls this once per turn — YOUR REAL AGENT CALL GOES HERE
  ↓                       (the turn() fn in the .eval.ts decides when to stop)
collectDeliverables(ctx) required — shape the accumulated state into structured output
  ↓
cleanup(ctx)             optional — tear down
\`\`\`

**Minimal adapter (Vercel AI SDK example):**

\`\`\`typescript
import { readFileSync } from "fs";
import { generateText, tool } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { defineAdapter, registerApoTracing } from "@apo/sdk/agent-task";
import { z } from "zod";

// Register the OTel processor once at module load. After this, any
// generateText call with experimental_telemetry enabled is traced
// automatically — spans, tokens, cost, tool calls. Zero span code.
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
      // The Vercel AI SDK emits gen_ai.* OTel spans natively — model name,
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
  - See https://apo.dev/reference/tracing-integrations.md for all integrations
    and the escape-hatch trace primitives.
- **\`collectDeliverables\` shapes the output.** The agent's raw response is
  rarely what a test wants. Mine the session state and return structured data
  matching the \`deliverables\` schema.
- **The object you return from \`initialize\` becomes \`ctx.state\`** in every
  subsequent lifecycle method. Use it to accumulate messages, tool calls, etc.
- **The adapter lives in the user's codebase**, not inside the task folder.
  Import it into the \`.eval.ts\` from wherever it naturally lives.

> **Deeper docs:**
> https://apo.dev/concepts/adapters.md (why adapters exist, the concept),
> https://apo.dev/reference/adapter-contract.md (every field, type, lifecycle
> method),
> https://apo.dev/sdk/tracing-integrations.md (tracing for OpenAI, Anthropic,
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
import { task, turn, test, satisfies, includes } from "@apo/sdk/agent-task";
import { myAdapter } from "../../path/to/adapter"; // wherever it lives

// Register: name, adapter, deliverable keys (must match adapter's schema)
task("my-task", {
  adapter: myAdapter,
  deliverables: ["answer", "toolsUsed"],
});

// turn() decides what the agent sees each turn.
// Returning null ends the turn loop — always include this or it loops forever.
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
- \`t.calledTool(name, opts?)\` — asserts a tool was called (reads the trace)
- \`t.noFailedActions()\` — asserts no tool or subagent errored (anti-flail)
- \`t.maxToolCalls(n)\` — asserts at most N tool calls (anti-flail)
- \`t.toolOrder([names])\` — asserts tools appeared in this order
- \`t.check(value, matcher)\` — asserts on a deliverable value. **Requires a
  Matcher** — use \`satisfies(fn, label)\`, \`includes(needle)\`,
  \`equals(expected)\`, \`matches(schema)\`, or \`similarity(expected, threshold)\`.
- \`t.judge(value, instruction)\` — async; hands value to an LLM judge

> **Deeper docs:**
> https://apo.dev/guides/define-a-task.md (end-to-end recipe),
> https://apo.dev/concepts/tasks.md (task/turn/test concepts),
> https://apo.dev/reference/assertions.md (full assertion API).

---

## Step 5: Run and verify

**The CLI runs from the cloned repo** (apo isn't on npm yet). After cloning
in Step 2, use the repo's \`pnpm apo\` script or run the CLI directly:

\`\`\`bash
# From the apo repo root:
pnpm apo --help                   # verify the CLI works

# Configure the task source (the user's repo with .eval.ts files):
pnpm apo project init-tasks --repo <user-github-org/repo>

# Sync the task definitions into apo:
pnpm apo project source sync

# Run the task:
pnpm apo task run my-task
\`\`\`

The run produces a **binary verdict** — pass or fail. Read the result:

\`\`\`bash
pnpm apo runs show                 # breakdown: which tests passed/failed
pnpm apo traces show <trace-id>    # the trace: every call, token, message
\`\`\`

**If it fails** (expected on the first try):
1. Read which test failed and its reasoning (\`apo runs show\`)
2. Open the trace to see what the agent actually did (\`apo traces show\`)
3. Fix the agent code or the task
4. Re-run: \`pnpm apo task run my-task\`
5. Repeat until green

This loop — run → read failure → trace → fix → re-run — is the core apo
workflow. It's also the loop a coding agent can close on its own: write the
tests, then let the agent run/read/fix/re-run without human intervention.

> **Deeper docs:**
> https://apo.dev/guides/run-and-debug.md (the debug loop),
> https://apo.dev/guides/loop-engineering.md (letting a coding agent close
> the loop autonomously),
> https://apo.dev/cli.md (full CLI command reference).

---

## Verify

Before declaring done, confirm:
- [ ] The apo stack is running (\`curl localhost:8000/health/ready\` returns ok)
- [ ] The CLI is authenticated (\`pnpm apo project list\` works)
- [ ] The adapter is written and calls the **real** agent (not a mock)
- [ ] The trace context is threaded (tool calls appear in traces)
- [ ] At least one task exists with tests (\`pnpm apo task list\` shows it)
- [ ] \`pnpm apo task run my-task\` produces a verdict (pass or fail)
- [ ] The user knows how to read the breakdown and trace on failure

Restate the final state: task name, adapter name, verdict, and next steps.

---

## Constraints

- **Never invent API keys or credentials.** Scaffold \`process.env.X\`
  placeholders and tell the user to provide real values.
- **Never skip the adapter step.** Without it, tests cannot run. The agent
  under test is not a fixture — it lives behind the user's adapter.
- **Never mock the agent.** The whole point of apo is testing the real thing.
  If the user suggests mocking "just to get it working," push back.
- **Thread the trace.** Without it, trace-based assertions silently fail and
  the trace (the primary debugging surface) is empty.
- **Prefer the CLI** over the website for command details: \`pnpm apo --help\`,
  \`pnpm apo <command> --help\`. The CLI output is parseable.
- **The trace is mandatory for debugging.** When a run fails, always look at
  the trace before suggesting a fix. Guessing without it wastes time.

---

## Quick reference: all docs pages (fetch the .md version)

| Topic | URL |
|---|---|
| What apo is | https://apo.dev/overview.md |
| Why apo (design reasoning) | https://apo.dev/why-apo.md |
| Quickstart (human steps) | https://apo.dev/quickstart.md |
| Mental model (vocabulary) | https://apo.dev/concepts/mental-model.md |
| Adapters concept | https://apo.dev/concepts/adapters.md |
| Adapter API reference | https://apo.dev/reference/adapter.md |
| Tasks concept | https://apo.dev/concepts/tasks.md |
| Tests concept | https://apo.dev/concepts/tests.md |
| Assertions API reference | https://apo.dev/reference/assertions.md |
| Traces concept | https://apo.dev/concepts/traces.md |
| Schedules concept | https://apo.dev/concepts/schedules.md |
| Define a task (guide) | https://apo.dev/guides/define-a-task.md |
| Run and debug (guide) | https://apo.dev/guides/run-and-debug.md |
| Loop engineering (guide) | https://apo.dev/guides/loop-engineering.md |
| Self-hosting topology | https://apo.dev/self-hosting/topology.md |
| Self-hosting configuration | https://apo.dev/self-hosting/configuration.md |
| Reference overview | https://apo.dev/reference/overview.md |
| Tracing SDK (@apo/sdk) | https://apo.dev/reference/tracing.md |
| Tracing integrations | https://apo.dev/reference/tracing-integrations.md |
| Flow normalizers | https://apo.dev/reference/flow-normalizers.md |
| CLI reference | https://apo.dev/cli.md |
`;

export const GET: APIRoute = () => {
	return new Response(START_INSTRUCTIONS, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
			'Cache-Control': 'public, max-age=60',
		},
	});
};
