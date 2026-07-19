# SDK Examples

Ready-to-run examples for the apo SDK.

## Prerequisites

1. Backend running on port 8000:
   ```bash
   cd backend && uv run uvicorn apo.api:app --reload --port 8000
   ```
2. Node.js 20+
3. An OpenAI API key (calls still trace even with a placeholder key)

## Setup

```bash
cd backend/examples
npm install
```

## Simple example — trace one LLM call

```bash
npm run simple
```

Creates a tracing client, wraps a single `openai.chat.completions.create`
call in a `traceRun` step, and sends the run to apo. See
[`simple-sdk-example.ts`](./simple-sdk-example.ts).

## What gets traced

Every span inside a `traceRun` records: input/output, model, latency,
tokens, and parent/child relationships. See the
[SDK README](../../packages/sdk/README.md) for the full tracing and
agent-task API.

## Viewing your data

- Dashboard: the Runs/Traces views
- API: `GET http://localhost:8000/v1/runs`
- Health: `GET http://localhost:8000/health` → `{"status":"ok"}`
