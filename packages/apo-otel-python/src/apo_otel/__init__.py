"""Provider-safe OpenTelemetry setup for apo's standard OTLP endpoint.

Host applications should attach :func:`create_apo_span_processor` to the
``TracerProvider`` they already own. Small standalone applications can opt in
to provider ownership through :func:`configure_apo_telemetry`.
"""

from __future__ import annotations

import base64
import logging
import os
from dataclasses import dataclass
from importlib import import_module
from threading import Lock
from typing import Protocol, cast, final

from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import (
    BatchSpanProcessor,
    SpanExporter,
)
from opentelemetry.trace import ProxyTracerProvider
from opentelemetry.util.types import AttributeValue

logger = logging.getLogger("apo_otel")

__all__ = [
    "ApoTelemetryHandle",
    "configure_apo_telemetry",
    "create_apo_span_exporter",
    "create_apo_span_processor",
]

_DEFAULT_ENDPOINT = "http://localhost:8000/api/public/otel/v1/traces"
_bootstrap_lock = Lock()
_standalone_handle: ApoTelemetryHandle | None = None


class _Instrumentor(Protocol):
    def instrument(self) -> object: ...


class _InstrumentorFactory(Protocol):
    def __call__(self) -> _Instrumentor: ...


@dataclass(frozen=True)
class _StandaloneConfiguration:
    endpoint: str
    service_name: str
    project: str
    public_key: str | None
    secret_key: str | None
    auth_token: str | None
    environment: str | None
    capture_content: str


@final
class ApoTelemetryHandle:
    """An explicitly owned standalone tracer provider.

    The handle only exists for providers created by
    :func:`configure_apo_telemetry`. Its shutdown operation is idempotent and
    never replaces or disables OpenTelemetry global components.
    """

    def __init__(
        self,
        provider: TracerProvider,
        configuration: _StandaloneConfiguration,
    ) -> None:
        self._provider = provider
        self._configuration = configuration
        self._shutdown = False
        self._shutdown_lock = Lock()

    @property
    def provider(self) -> TracerProvider:
        return self._provider

    @property
    def tracer(self) -> trace.Tracer:
        return self._provider.get_tracer("apo-sdk")

    @property
    def is_shutdown(self) -> bool:
        return self._shutdown

    def uses_configuration(
        self,
        configuration: _StandaloneConfiguration,
    ) -> bool:
        return self._configuration == configuration

    def instrument_openai(self) -> None:
        """Auto-instrument the OpenAI SDK using the installed provider."""
        try:
            module = import_module("opentelemetry.instrumentation.openai_v2")
            factory = cast(_InstrumentorFactory, module.OpenAIInstrumentor)
            _ = factory().instrument()
            logger.info("OpenAI SDK instrumented")
        except ImportError:
            logger.warning(
                "opentelemetry-instrumentation-openai-v2 not installed. Install "
                + "with: pip install apo-otel[openai]"
            )

    def force_flush(self, timeout_millis: int = 30_000) -> bool:
        """Export pending spans without transferring provider ownership."""
        if self._shutdown:
            return False
        return self._provider.force_flush(timeout_millis=timeout_millis)

    def shutdown(self) -> None:
        """Shut down this owned provider once, without mutating OTel globals."""
        with self._shutdown_lock:
            if self._shutdown:
                return
            self._provider.shutdown()
            self._shutdown = True


def create_apo_span_exporter(
    *,
    endpoint: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    auth_token: str | None = None,
    timeout: float | None = None,
) -> OTLPSpanExporter:
    """Create the official OTLP HTTP/protobuf exporter configured for apo.

    This factory does not read, install, replace, flush, or shut down a global
    tracer provider. The caller owns the exporter through its span processor.
    """
    resolved_endpoint = endpoint or os.getenv("APO_OTLP_ENDPOINT", _DEFAULT_ENDPOINT)
    headers = _build_auth_headers(
        public_key or os.getenv("APO_PUBLIC_KEY"),
        secret_key or os.getenv("APO_SECRET_KEY"),
        auth_token or os.getenv("APO_AUTH_TOKEN"),
    )
    return OTLPSpanExporter(
        endpoint=resolved_endpoint,
        headers=headers or None,
        timeout=timeout,
    )


def create_apo_span_processor(
    *,
    exporter: SpanExporter | None = None,
    endpoint: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    auth_token: str | None = None,
    timeout: float | None = None,
    max_queue_size: int | None = None,
    schedule_delay_millis: float | None = None,
    max_export_batch_size: int | None = None,
    export_timeout_millis: float | None = None,
) -> BatchSpanProcessor:
    """Create a batch processor for a host-owned ``TracerProvider``.

    Supplying ``exporter`` is useful for custom transport policy and tests. If
    omitted, :func:`create_apo_span_exporter` creates the official OTLP
    HTTP/protobuf exporter.
    """
    span_exporter = exporter or create_apo_span_exporter(
        endpoint=endpoint,
        public_key=public_key,
        secret_key=secret_key,
        auth_token=auth_token,
        timeout=timeout,
    )
    return BatchSpanProcessor(
        span_exporter,
        max_queue_size=max_queue_size,
        schedule_delay_millis=schedule_delay_millis,
        max_export_batch_size=max_export_batch_size,
        export_timeout_millis=export_timeout_millis,
    )


def configure_apo_telemetry(
    *,
    take_ownership: bool,
    endpoint: str | None = None,
    service_name: str = "apo-agent",
    project: str | None = None,
    public_key: str | None = None,
    secret_key: str | None = None,
    auth_token: str | None = None,
    environment: str | None = None,
    capture_content: str = "full",
) -> ApoTelemetryHandle:
    """Create and globally install a standalone apo tracer provider.

    ``take_ownership=True`` is required because this function owns the global
    provider lifecycle. Applications that already configure OpenTelemetry must
    instead add :func:`create_apo_span_processor` to their provider.

    Repeating an identical call returns the active handle. Conflicting calls,
    calls after shutdown, and attempts to replace a host provider fail rather
    than silently changing global telemetry.
    """
    if take_ownership is not True:
        raise ValueError("standalone bootstrap requires take_ownership=True")
    configuration = _resolve_standalone_configuration(
        endpoint=endpoint,
        service_name=service_name,
        project=project,
        public_key=public_key,
        secret_key=secret_key,
        auth_token=auth_token,
        environment=environment,
        capture_content=capture_content,
    )

    with _bootstrap_lock:
        global _standalone_handle
        if _standalone_handle is not None:
            return _reuse_standalone_handle(_standalone_handle, configuration)

        current_provider = trace.get_tracer_provider()
        if not isinstance(current_provider, ProxyTracerProvider):
            raise RuntimeError(
                "A global tracer provider is already installed. Add "
                + "create_apo_span_processor() to the host-owned provider instead."
            )

        _configure_instrumentation_environment(configuration.capture_content)
        provider = _create_standalone_provider(configuration)
        trace.set_tracer_provider(provider)
        if trace.get_tracer_provider() is not provider:
            provider.shutdown()
            raise RuntimeError(
                "The global tracer provider changed during apo bootstrap; "
                + "the apo provider was not installed."
            )

        _standalone_handle = ApoTelemetryHandle(provider, configuration)
        logger.info(
            "OTel standalone provider configured at %s (auth=%s)",
            configuration.endpoint,
            bool(
                configuration.auth_token
                or (configuration.public_key and configuration.secret_key)
            ),
        )
        return _standalone_handle


def _resolve_standalone_configuration(
    *,
    endpoint: str | None,
    service_name: str,
    project: str | None,
    public_key: str | None,
    secret_key: str | None,
    auth_token: str | None,
    environment: str | None,
    capture_content: str,
) -> _StandaloneConfiguration:
    return _StandaloneConfiguration(
        endpoint=endpoint or os.getenv("APO_OTLP_ENDPOINT", _DEFAULT_ENDPOINT),
        service_name=service_name,
        project=project or os.getenv("APO_PROJECT", service_name),
        public_key=public_key or os.getenv("APO_PUBLIC_KEY"),
        secret_key=secret_key or os.getenv("APO_SECRET_KEY"),
        auth_token=auth_token or os.getenv("APO_AUTH_TOKEN"),
        environment=environment,
        capture_content=capture_content,
    )


def _reuse_standalone_handle(
    handle: ApoTelemetryHandle,
    configuration: _StandaloneConfiguration,
) -> ApoTelemetryHandle:
    if handle.is_shutdown:
        raise RuntimeError(
            "The standalone apo tracer provider has been shut down and cannot "
            + "be replaced. Configure telemetry once at process startup."
        )
    if not handle.uses_configuration(configuration):
        raise RuntimeError(
            "apo telemetry is already configured with different standalone settings."
        )
    return handle


def _configure_instrumentation_environment(capture_content: str) -> None:
    _ = os.environ.setdefault(
        "OTEL_SEMCONV_STABILITY_OPT_IN", "gen_ai_latest_experimental"
    )
    if capture_content == "full":
        _ = os.environ.setdefault(
            "OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT", "span_only"
        )


def _create_standalone_provider(
    configuration: _StandaloneConfiguration,
) -> TracerProvider:
    resource_attrs: dict[str, AttributeValue] = {
        "service.name": configuration.service_name,
        "service.namespace": configuration.project,
    }
    if configuration.environment:
        resource_attrs["deployment.environment"] = configuration.environment

    provider = TracerProvider(resource=Resource.create(resource_attrs))
    provider.add_span_processor(
        create_apo_span_processor(
            endpoint=configuration.endpoint,
            public_key=configuration.public_key,
            secret_key=configuration.secret_key,
            auth_token=configuration.auth_token,
        )
    )
    return provider


def _build_auth_headers(
    public_key: str | None,
    secret_key: str | None,
    auth_token: str | None,
) -> dict[str, str]:
    if public_key and secret_key:
        token = base64.b64encode(f"{public_key}:{secret_key}".encode()).decode()
        return {"Authorization": f"Basic {token}"}
    if auth_token:
        return {"Authorization": f"Bearer {auth_token}"}
    return {}
