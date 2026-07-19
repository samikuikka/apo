---
title: Ecosystem
description: "Bring your existing agent, run apo from CI, and learn from example adapters."
---

apo doesn't lock you into a framework. Three surfaces let you connect what you already have: adapters to drive your agent live (the primary path), flow normalizers to inspect a recorded log from an agent you can't re-run, and CI integration for automated runs.

## Adapters — the primary path

The intended way to connect an agent is an [adapter](/concepts/adapters/): apo drives your agent live through it, records a real trace, and runs your `t.*` assertions against the trace projection. Test the real implementation — that's the whole point.

## Flow normalizers — escape hatch for recordings you already have

If you *can't* re-run the agent — a production trace, an eval harness's stored output — the flow normalizers convert a recorded log into apo's `Flow` format so you can inspect it with `FlowView`.

:::caution[Deprecated — prefer an adapter]
Flow normalizers are **compatibility adapters**. The `t.*` assertions in a live run read the trace projection (`TraceView`), not a `Flow`; there is no public path to run a registered test suite against a converted `Flow`. Use these only to inspect a recording you already have. If your agent can run live, write an [adapter](/concepts/adapters/) instead.
:::

```typescript
import { fromOpenAIMessages, FlowView } from "@apo/sdk/agent-task";

// Convert a recorded OpenAI log, then inspect it directly.
const view = new FlowView(fromOpenAIMessages(yourRecordedMessages));

view.toolNamesInOrder;  // ["read_file", "search_content"]
view.failedActions;     // 0
```

| Normalizer | Input | Source |
|---|---|---|
| `fromOpenAIMessages` | OpenAI chat-completions message log | `@apo/sdk/agent-task` |
| `fromAnthropicMessages` | Anthropic messages API content blocks | `@apo/sdk/agent-task` |
| `fromAISDK` | Vercel AI SDK `generateText` / `streamText` result | `@apo/sdk/agent-task` |

See the [Flow normalizers](/reference/flow-normalizers/) for signatures.

## Example adapters

The repo ships two reference adapters, from minimal to full-featured. Read them to learn the pattern:

| Adapter | What it shows | Location |
|---|---|---|
| **service** | Wrapping an HTTP endpoint — the adapter calls your existing `/api/agent/chat` route. | `apps/example-service/e2e/agent-task-demo/service-adapter.ts` |
| **real-agent** | The full pattern — `initialize` loads inputs, `sendUserTurn` drives a Vercel AI SDK agent with tools (`read_file`, `search_content`, etc.), `collectDeliverables` shapes the output. | `apps/example-service/e2e/agent-task-demo/real-agent-adapter.ts` |

The **real-agent** adapter also ships ten ready-made tasks (`document-qa`, `code-review`, `data-extraction`, `bug-triage`, etc.) under `apps/example-service/e2e/agent-task-demo/tasks/real-agent/` — each a folder with a `.eval.ts` and `files/`. Run them with `apo task run <name>`.

## CI integration

apo's CLI has a `--ci` mode designed for automated runs. Strict exit codes (0=pass, 1=fail, 2=error) let you gate pipelines on the verdict:

```bash
# Run a task in CI — fails the pipeline if a test fails
apo task run extract-parties --ci
```

```yaml
- name: Run agent tasks
  run: apo task run extract-parties --ci
  env:
    APO_BACKEND_URL: ${{ secrets.APO_BACKEND_URL }}
    APO_API_KEY: ${{ secrets.APO_API_KEY }}
```

See [`apo task run`](/cli/task-run/) for the full `--ci` reference, and [Loop engineering](/guides/loop-engineering/) for how a coding agent uses the same CLI to close the loop.

## See also

- [Reference overview](/reference/overview/) — the API surfaces.
- [Flow normalizers](/reference/flow-normalizers/) — the normalizer signatures.
- [Adapter API](/reference/adapter/) — what an adapter implements.
- [CLI overview](/cli/) — every command, including `--ci` mode.
