# Example Service (TypeScript)

A Next.js app that hosts:

1. **`POST /api/agent/chat`** — a small agent chat endpoint with tool-calling
2. **The agent-task e2e demo** (`e2e/agent-task-demo/`) — the demo dataset and
   adapters consumed by the agent-task evaluation feature and the `apo` CLI
   (`apo task run`)

It runs on **:3001**. `pnpm dev` at the repo root starts it alongside the
dashboard (:3000), backend (:8000), and Python example service (:3002).

For the Python mirror (FastAPI + OTel auto-instrumentation), see
[`apps/example-service-py`](../example-service-py).

## Setup

```bash
pnpm install          # at repo root
cp .env.example .env  # then fill in OPENROUTER_API_KEY
```

## Run

```bash
pnpm --filter example-service dev   # starts on :3001
```

## Chat endpoint

`POST /api/agent/chat` runs a Vercel-AI-SDK agent loop (capped at 8 steps) with
four in-memory tools: `read_file`, `list_files`, `search_content`, `compute`.

**Request:**

```json
{
  "messages": [{"role": "user", "content": "list the files"}],
  "files": {"a.txt": "hello world", "b.md": "# title"}
}
```

**Response (200):**

```json
{
  "response": "Found 2 files: a.txt and b.md.",
  "tool_calls": [
    {"tool": "list_files", "args": {}, "result": {"files": ["a.txt", "b.md"]}}
  ],
  "usage": {"input_tokens": 123, "output_tokens": 45}
}
```

**Error (500):** `{"error": "<message>"}`

## Agent-task e2e

Tasks run through the `apo` CLI (the same command local dev, CI, and the
dashboard use — there's no separate runner here):

```bash
apo task run real-agent/documents/data-extraction --dir e2e/agent-task-demo
```

The demo tree lives under `e2e/agent-task-demo/`:

- `tasks/real-agent/` — 11 demo tasks across `engineering/`, `documents/`,
  `operations/`, `research/`, `security/`. These are the demo dataset for the
  agent-task evaluation feature and are seeded into the backend via
  `backend/seeds/seed_agent_task_runs.py`.
- `tasks/ai-sdk-agent/data-extraction/` — the data-extraction task wired to
  the AI SDK adapter (Vercel AI SDK + OTel-native tracing, pointed at
  OpenRouter/Gemini). Its `files/` directory is a symlink to
  `tasks/real-agent/documents/data-extraction/files/` (the single source of
  truth). Swap the provider in the adapter to use Anthropic instead.
- `tasks/claude-agent/data-extraction/` — the same data-extraction task wired
  to the Claude Agent SDK adapter (see below). Its `files/` directory is the
  same symlink as `ai-sdk-agent`'s.
- `*-adapter.ts` — five adapters (`echo`, `real-agent`, `ai-sdk`, `claude`,
  `service`) showing different ways to trace an agent run.

### The `claude` adapter — reference pattern for native-OTel agents

`claude-adapter.ts` is the recommended pattern for any agent SDK that emits
OpenTelemetry natively (the Claude Agent SDK, the Vercel AI SDK, the OpenAI
Agents SDK, etc.). It is deliberately **thin**: it owns only the apo lifecycle
wiring and the OTel environment. The actual agent code (the `query()` call,
prompt, tools) lives in `agent/claude-agent.ts` as plain user-owned code with
no knowledge of apo.

Tracing uses the SDK's own native OTel — no `registerApoTracing()`, no custom
wrapper. The adapter sets four env vars on the SDK's subprocess:

| Env var | Value |
|---------|-------|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `${AGENT_TASK_TRACE_ENDPOINT}/api/public/otel` |
| `OTEL_EXPORTER_OTLP_HEADERS` | `Authorization=Bearer ${APO_AUTH_TOKEN}` |
| `OTEL_SERVICE_NAME` | `apo-claude-agent` |
| `TRACEPARENT` | W3C traceparent from apo's active span (via `injectTraceparent()`) |

The `TRACEPARENT` links the subprocess's spans under the active `task.turn`
span, so the agent's generations and tool calls land in the same trace as the
apo run. Contrast this with `ai-sdk-adapter.ts` / `real-agent-adapter.ts`,
which embed the agent loop, tools, and system prompt inside the adapter — a
pattern that works but couples agent concerns to apo. The `claude` adapter
demonstrates the target separation.

> **Note:** the Claude Agent SDK spawns a Claude Code subprocess, so its
> platform binary must be available in the environment where `apo task run`
> runs (or in the Docker image).

The backend bundles this tree into its Docker image as `DEMO_TASK_ROOT`.

## Development

```bash
pnpm --filter @apo/example-service typecheck   # tsc --noEmit
pnpm --filter @apo/example-service test        # vitest
pnpm --filter @apo/example-service lint        # eslint
```
