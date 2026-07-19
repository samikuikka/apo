# example-service-py

A Python mirror of the TypeScript [`apps/example-service`](../example-service) — an agentic chat endpoint over in-memory files. LLM calls are auto-traced via OpenTelemetry: every `chat.completions.create` emits a `GENERATION` span (with the actual prompt + completion content) to the apo backend's OTLP endpoint, no manual span code required.

It exists to prove the Python side of the integration is real: standard OpenTelemetry auto-instrumentation, the OTLP/JSON wire protocol, the same auth, the same run model — no Node required.

## Stack

- **FastAPI + uvicorn** (mirrors `backend/`)
- **`openai` Python SDK** pointed at OpenRouter (same env vars and model default as the TS service)
- **`opentelemetry-instrumentation-openai-v2`** — auto-instruments every OpenAI SDK call
- **Custom OTLP/JSON exporter** (`app/otel.py`) — the official `OTLPSpanExporter` sends protobuf binary; apo's backend expects JSON, so we convert via `MessageToDict`

## Quick start

```bash
# from the repo root — installs Python deps into .venv
pnpm --filter example-service-py dev      # or: cd apps/example-service-py && uv sync && uv run uvicorn app.main:app --reload --port 3002
```

`pnpm dev` from the repo root starts it on **:3002** alongside dashboard (:3000), backend (:8000), and the TS example service (:3001).

### Set env vars

```bash
cp .env.example .env
# then set at least OPENROUTER_API_KEY and APO_PROJECT (project ID, not name)
```

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `OPENROUTER_API_KEY` | yes | — | OpenRouter API key |
| `OPENROUTER_MODEL` | no | `google/gemini-2.5-flash-lite` | Model to call |
| `OPENROUTER_BASE_URL` | no | `https://openrouter.ai/api/v1` | OpenAI-compatible endpoint |
| `APO_OTLP_ENDPOINT` | no | `http://localhost:8000/api/public/otel/v1/traces` | apo OTLP traces URL |
| `APO_PROJECT` | **yes** | — | **Project ID** (not the name) — find via `apo project list` |
| `APO_PUBLIC_KEY` / `APO_SECRET_KEY` | no | — | Auth key pair |
| `OTEL_SEMCONV_STABILITY_OPT_IN` | yes | — | Must be `gen_ai_latest_experimental` for content capture |
| `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT` | yes | — | Must be `span_only` to record prompt/completion text |

**Auth is required** whenever the backend has `AUTH_SECRET` set — which includes this repo's default dev config. Mint a key pair in the dashboard or directly in the backend DB, then set both `APO_PUBLIC_KEY` and `APO_SECRET_KEY`.

> ⚠️ **`APO_PROJECT` is the project ID, not the name.** Runs are keyed by project ID in the wire protocol; setting it to the human-readable name will silently orphan them. Use `apo project list` to find the ID.

## API

### `GET /`
Landing — confirms the service is up.
```json
{"status": "ok", "service": "example-service-py", "port": "3002"}
```

### `POST /api/agent/chat`
Runs the agentic loop. Same request/response shape as the TS service.

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

The agent has four in-memory tools (no filesystem access): `read_file`, `list_files`, `search_content` (case-insensitive regex), `compute` (sanitized arithmetic). The loop is capped at 8 steps.

## How tracing works

**LLM calls are auto-traced.** `opentelemetry-instrumentation-openai-v2` wraps `chat.completions.create` and emits a `GENERATION` span per call with `gen_ai.input.messages` (the prompt) and `gen_ai.output.messages` (the completion) as span attributes. The backend's OTLP mapper (`backend/apo/services/otel_mapper.py`) decodes these into the structured `input`/`output` fields the dashboard renders.

**Tool calls are manually traced.** The instrumentor only wraps the OpenAI SDK, not our `dispatch()` function. So `agent.py` opens a small `TOOL` span via the OTel API around each tool execution, setting `gen_ai.tool.name`, `gen_ai.tool.call.arguments`, and `gen_ai.tool.call.result` attributes. These nest under the parent LLM span automatically via OTel context propagation.

**Transport:** the custom `OtlpJsonSpanExporter` (`app/otel.py`) converts each span batch to OTLP/JSON via `MessageToDict` (the official exporter sends protobuf binary, which the backend doesn't parse) and POSTs to `/api/public/otel/v1/traces` with Basic auth.

Set `OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=span_only` to capture the actual prompt + completion text (not just token counts).

## Layout

```
app/
├── main.py             # FastAPI app: GET / + POST /api/agent/chat
├── agent.py            # 8-step agentic loop + manual TOOL spans via OTel API
├── tools.py            # read_file / list_files / search_content / compute + OpenAI schemas
└── otel.py             # OTLP/JSON exporter + OpenAI auto-instrumentation setup
tests/
├── test_tools.py       # pure unit tests on the 4 tools
└── test_agent.py       # shape test on handle_chat with a mocked OpenAI client
```

## Development

```bash
uv run pytest           # tests (no backend, no real LLM)
uv run basedpyright app # type check (0 errors; warnings tolerated like the backend)
```
