from __future__ import annotations

from collections.abc import Sequence
from typing import final
from unittest.mock import Mock

import pytest
from opentelemetry import trace
from opentelemetry.sdk.trace import ReadableSpan, TracerProvider
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult
from opentelemetry.trace import ProxyTracerProvider

import apo_otel


@final
class RecordingExporter(SpanExporter):
    def __init__(self) -> None:
        self.spans: list[ReadableSpan] = []
        self.shutdown_calls = 0

    def export(  # pyright: ignore[reportImplicitOverride]
        self, spans: Sequence[ReadableSpan]
    ) -> SpanExportResult:
        self.spans.extend(spans)
        return SpanExportResult.SUCCESS

    def shutdown(self) -> None:  # pyright: ignore[reportImplicitOverride]
        self.shutdown_calls += 1


@pytest.fixture(autouse=True)
def reset_standalone_handle(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(apo_otel, "_standalone_handle", None)


def test_host_owned_processor_exports_without_global_takeover() -> None:
    global_provider = trace.get_tracer_provider()
    host_provider = TracerProvider()
    exporter = RecordingExporter()
    processor = apo_otel.create_apo_span_processor(
        exporter=exporter,
        schedule_delay_millis=60_000,
    )
    host_provider.add_span_processor(processor)

    with host_provider.get_tracer("host-app").start_as_current_span("agent.run"):
        pass

    assert host_provider.force_flush()
    assert [span.name for span in exporter.spans] == ["agent.run"]
    assert trace.get_tracer_provider() is global_provider

    host_provider.shutdown()
    assert exporter.shutdown_calls == 1


def test_standalone_bootstrap_refuses_host_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    host_provider = TracerProvider()
    set_provider = Mock()
    monkeypatch.setattr(trace, "get_tracer_provider", lambda: host_provider)
    monkeypatch.setattr(trace, "set_tracer_provider", set_provider)

    with pytest.raises(RuntimeError, match="already installed"):
        _ = apo_otel.configure_apo_telemetry(take_ownership=True)

    set_provider.assert_not_called()
    assert host_provider.force_flush()
    host_provider.shutdown()


def test_standalone_bootstrap_requires_explicit_ownership() -> None:
    with pytest.raises(ValueError, match="take_ownership=True"):
        _ = apo_otel.configure_apo_telemetry(take_ownership=False)


def test_repeated_standalone_configuration_reuses_owned_provider(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    global_provider: object = ProxyTracerProvider()
    provider = Mock(spec=TracerProvider)
    provider.force_flush.return_value = True
    create_provider = Mock(return_value=provider)

    def set_provider(value: TracerProvider) -> None:
        nonlocal global_provider
        global_provider = value

    monkeypatch.setattr(trace, "get_tracer_provider", lambda: global_provider)
    monkeypatch.setattr(trace, "set_tracer_provider", set_provider)
    monkeypatch.setattr(apo_otel, "_create_standalone_provider", create_provider)

    first = apo_otel.configure_apo_telemetry(
        take_ownership=True,
        endpoint="http://collector/v1/traces",
        service_name="test-agent",
    )
    second = apo_otel.configure_apo_telemetry(
        take_ownership=True,
        endpoint="http://collector/v1/traces",
        service_name="test-agent",
    )

    assert second is first
    assert first.provider is provider
    create_provider.assert_called_once()
    assert first.force_flush()

    with pytest.raises(RuntimeError, match="different standalone settings"):
        _ = apo_otel.configure_apo_telemetry(
            take_ownership=True,
            endpoint="http://other-collector/v1/traces",
            service_name="test-agent",
        )

    first.shutdown()
    first.shutdown()
    provider.shutdown.assert_called_once()

    with pytest.raises(RuntimeError, match="has been shut down"):
        _ = apo_otel.configure_apo_telemetry(
            take_ownership=True,
            endpoint="http://collector/v1/traces",
            service_name="test-agent",
        )


def test_exporter_factory_builds_standard_basic_auth(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    exporter_factory = Mock(return_value=object())
    monkeypatch.setattr(apo_otel, "OTLPSpanExporter", exporter_factory)

    exporter = apo_otel.create_apo_span_exporter(
        endpoint="http://collector/v1/traces",
        public_key="pk-test",
        secret_key="sk-test",
        timeout=5,
    )

    assert exporter is exporter_factory.return_value
    exporter_factory.assert_called_once_with(
        endpoint="http://collector/v1/traces",
        headers={"Authorization": "Basic cGstdGVzdDpzay10ZXN0"},
        timeout=5,
    )
