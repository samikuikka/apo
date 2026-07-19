---
title: Reference
description: "Exact signatures, field types, and options for every public apo import — organized by import path."
---

This section is the exact API surface: every import, its signature, its fields, its options. No tutorials here — those live in [Guides](/guides/define-a-task/). Jump to the page for the import path you're using.

## Two packages

apo ships two import paths. Most work happens in the first.

### `@apo/sdk/agent-task` — define and run tasks

The package you import when writing `.eval.ts` files, adapters, and assertions.

```typescript
import {
  task, test, turn, defineAdapter,
  createApoTracer, createApoOpenAI, createApoAnthropic, registerApoTracing,
  runTask, loadTask, discoverAgentTaskDirs,
  includes, equals, matches, satisfies, similarity,
} from "@apo/sdk/agent-task";
```

| Page | What it covers |
|---|---|
| [Task API](/reference/task/) | `task()`, `turn()`, `test()` — the three calls in a `.eval.ts` file |
| [Adapter API](/reference/adapter/) | `defineAdapter()` — the lifecycle contract (`initialize`, `startSession`, `collectDeliverables`, `cleanup`) |
| [Assertions API](/reference/assertions/) | the `t.*` methods and the matcher helpers |
| [Tracing integrations](/reference/tracing-integrations/) | `createApoTracer`, `createApoOpenAI`, `createApoAnthropic`, and the OTel-native `registerApoTracing` path |
| [Running tasks](/reference/running/) | `runTask`, `loadTask`, `discoverAgentTaskDirs`, `runTaskDir` |
| [Flow normalizers](/reference/flow-normalizers/) | `fromOpenAIMessages`, `fromAnthropicMessages`, `fromAISDK` — inspect a recorded log with `FlowView` (deprecated; prefer OTel) |

### `@apo/sdk/otel` — standalone OTel tracing

Send OpenTelemetry traces to apo from any application — not just tasks. The lower-level tracing layer, using standard OTLP and semantic conventions.

```typescript
import { configureApoTelemetry, withApoTrace } from "@apo/sdk/otel";
```

See [Standalone OTel tracing](/reference/tracing/).

## HTTP and operator references

| Page | What it covers |
|---|---|
| [Schedule API](/reference/schedule-schema/) | Fields for creating and updating schedules via the backend API |
| [Configuration](/reference/configuration/) | Every environment variable across backend, CLI, SDK, and the task runner |

## Where to start

- **New to apo?** Start with [Tasks](/concepts/tasks/), then [Define a Task](/guides/define-a-task/) — this reference is the lookup layer, not the entry point.
- **Looking up a signature?** Use the right-side contents to jump to a specific export.
- **Self-hosting?** See the [Configuration](/reference/configuration/) page and the [Self-Hosting](/self-hosting/topology/) section.
