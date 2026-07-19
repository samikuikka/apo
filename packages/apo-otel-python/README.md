# apo-otel

Provider-safe OpenTelemetry setup for apo's standard OTLP HTTP/protobuf
endpoint. The package uses the official OpenTelemetry exporter and does not
define a proprietary tracing transport.

## Host-owned provider

Applications and agent frameworks that already own an OpenTelemetry
`TracerProvider` should attach apo's processor to that provider:

```python
from apo_otel import create_apo_span_processor
from opentelemetry.sdk.trace import TracerProvider

provider = TracerProvider()  # Usually created by your application's OTel setup.
provider.add_span_processor(
    create_apo_span_processor(
        endpoint="http://localhost:8000/api/public/otel/v1/traces",
        public_key="pk-apo-...",
        secret_key="sk-apo-...",
    )
)

tracer = provider.get_tracer("my-agent")
with tracer.start_as_current_span("agent.run"):
    # Call OpenAI, Anthropic, an agent framework, or your own tools here.
    pass

provider.force_flush()
```

`create_apo_span_processor()` and `create_apo_span_exporter()` never read or
change the global tracer provider. The application remains responsible for
provider registration, flush, and shutdown.

## Standalone bootstrap

Small applications without an existing OTel setup can explicitly grant apo
ownership of the process-global provider:

```python
from apo_otel import configure_apo_telemetry

handle = configure_apo_telemetry(
    take_ownership=True,
    endpoint="http://localhost:8000/api/public/otel/v1/traces",
    service_name="my-agent",
    public_key="pk-apo-...",
    secret_key="sk-apo-...",
)

handle.instrument_openai()  # Optional: install with apo-otel[openai].

with handle.tracer.start_as_current_span("agent.run"):
    pass

handle.force_flush()
handle.shutdown()  # Call during process shutdown only.
```

Standalone bootstrap refuses to replace an existing global provider. An
identical repeated call returns the same handle; conflicting reconfiguration
raises an error. `shutdown()` is idempotent and never replaces or disables
host-owned OpenTelemetry globals.

Configuration can also come from `APO_OTLP_ENDPOINT`, `APO_PUBLIC_KEY`,
`APO_SECRET_KEY`, `APO_AUTH_TOKEN`, and `APO_PROJECT`.
