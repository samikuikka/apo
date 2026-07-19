# OTLP is the canonical trace contract

**Status: Proposed.** apo will accept OpenTelemetry Protocol trace exports as
its canonical external tracing input, preserve canonical spans before deriving
product-specific Trace Projections, and keep Langfuse and legacy apo event
formats only as compatibility adapters. This separates vendor instrumentation
from apo's product model, lets OpenAI, Anthropic, Vercel AI, LangChain, and
future agent stacks use their normal OpenTelemetry paths, and makes semantic
normalization replayable as conventions evolve.

## Considered Options

- Keep `TraceTracker` event batches as the primary format: rejected because it
  forces each agent stack through apo-specific wrappers and duplicates the OTel
  context, batching, and transport ecosystem.
- Copy Langfuse's complete S3, Redis, and ClickHouse pipeline: rejected because
  apo needs the same protocol boundary and normalization discipline, not its
  current operational footprint.
- Treat only `gen_ai.*` spans as data: rejected because generic OTel spans,
  links, events, errors, and resource metadata are essential for debugging real
  agent systems.

## Consequences

- `Run` remains reserved for Task Run and Batch Run in product language; a
  telemetry execution is a Trace.
- Existing `runs` and `logged_calls` storage can remain during migration, but
  becomes a Trace Projection behind a repository boundary rather than the raw
  OTLP source of truth.
- Scores remain a separate domain signal. The current `apo.score` sentinel-span
  convention is transitional and will be retired after a native score API path
  is available.
