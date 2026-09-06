# apo canonical example — START HERE

This is apo's single canonical first-Task example. It wires a real Vercel AI
SDK agent through an Apo Adapter to a `data-extraction` Task that extracts
structured data from an invoice.

## The four concepts

| Concept | Source file |
|---|---|
| **Real agent** | [`app/lib/agent/service.ts`](../../app/lib/agent/service.ts) — the Vercel AI SDK agent (`handleChat`) |
| **Apo Adapter** | [`ai-sdk-adapter.ts`](../ai-sdk-adapter.ts) — thin bridge calling `handleChat()` |
| **First Task** | [`tasks/ai-sdk-agent/data-extraction/data-extraction.eval.ts`](tasks/ai-sdk-agent/data-extraction/data-extraction.eval.ts) |
| **Task inputs** | [`tasks/ai-sdk-agent/data-extraction/files/`](tasks/ai-sdk-agent/data-extraction/files/) — `invoice.txt` + `instructions.md` |

## Prerequisites

- An Apo Control Plane you can reach. Either:
  - **Self-hosted, running locally** (see the [Quickstart](https://docs.test-apo.online/quickstart/)), or
  - **Invited to a hosted apo** — accept your invitation, then copy the exact
    `apo login --backend <url> --project <id>` command from your Project's
    Tasks page ([Hosted Alpha](https://docs.test-apo.online/hosted-alpha/)).
- `OPENROUTER_API_KEY` set in this environment (the real agent calls a model).
- `@apo-ai/cli` installed (`npm install -g @apo-ai/cli`).
- pnpm (`npm install -g pnpm`) — this example lives inside apo's pnpm
  workspace, so its dependencies (including `@apo-ai/sdk`, which builds
  automatically during install) come from a workspace install, not from
  `npm install` in this directory.

## Set up the workspace

From a clone of the public repository:

```bash
git clone --depth 1 https://github.com/samikuikka/apo
cd apo
pnpm install --filter @apo/example-service...
# ✓ resolves the workspace, builds packages/sdk/dist (prepare script)
```

Then work from this directory:

```bash
cd apps/example-service/e2e/agent-task-demo
```

Use Node 22 or 24 (LTS); Node 25 also works. The demo site's `sharp`
dependency (via Next.js) ships prebuilt binaries that install without
running its build script — its native source build is disabled in
`pnpm-workspace.yaml` precisely so it can never abort the install (#153).

## Run it outside the monorepo

The monorepo path above is the default. If you keep your evaluation tree
outside the repository (a separate project directory, a CI runner), copy the
example **plus its sibling `app/` directory** and install at the workspace
root — the adapter imports `../../app/lib/agent/service.ts`, so the tree has
a fixed shape:

```text
my-evals/
├── package.json        ← install here: npm i @apo-ai/sdk ai @ai-sdk/openai zod
├── node_modules/
├── app/                ← copy from apps/example-service/app (the real agent)
└── e2e/
    └── agent-task-demo/   ← copy from apps/example-service/e2e/agent-task-demo
```

```bash
mkdir -p my-evals/e2e
cp -r apo/apps/example-service/app my-evals/app
cp -r apo/apps/example-service/e2e/agent-task-demo my-evals/e2e/agent-task-demo
cd my-evals
npm init -y && npm install @apo-ai/sdk ai @ai-sdk/openai zod

cd e2e/agent-task-demo
OPENROUTER_API_KEY=... apo task run tasks/ai-sdk-agent/data-extraction --dir .
```

`package.json` inside `agent-task-demo` declares the same runtime
dependencies for container installs — a root `npm install` that includes
them satisfies both.

## Run it

```bash
export OPENROUTER_API_KEY=...

# Publish the Task catalog to your Apo project.
apo task publish --dir ./tasks/ai-sdk-agent

# Run the Task locally — the real agent calls the model.
apo task run data-extraction --dir ./tasks/ai-sdk-agent

# Inspect the verdict and trace.
apo runs show
apo traces show <trace-id>
```

## What happens

1. `apo task publish` sends bounded Task metadata (not source) to the Control Plane.
2. `apo task run` executes the real agent on this machine via the Vercel AI SDK.
3. The Adapter drives `handleChat()`, which calls the model with tools (`list_files`, `read_file`, `extract_entities`).
4. After the turn loop, `collectDeliverables` shapes the session into structured outputs.
5. Tests assert that the agent called the right tools and the deliverables are well-formed.
6. The Control Plane records the verdict (pass/fail), checks, trace, and deliverables.

## Adapt this to your agent

Replace `app/lib/agent/service.ts` with your real agent, write an Adapter that
calls it through `sendUserTurn`, and define a Task that asserts what "good"
means. See the [Adapter API reference](https://docs.test-apo.online/reference/adapter/)
for the full lifecycle.
