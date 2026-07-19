# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""SPEC-129 Track 6 Phase 2: legacy ingestion as a canonical adapter.

The /api/v1/ingestion route must translate legacy events into canonical
OTLP spans (OtlpSpanDB as source of truth) and derive RunDB/LoggedCallDB via
the projector — NOT write to RunDB/LoggedCallDB directly. These tests prove
the translation is faithful and the canonical store owns the data.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from _pytest.monkeypatch import MonkeyPatch
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from apo import auth as auth_module
from apo.auth import middleware as auth_middleware
from apo.models.db import LoggedCallDB, OtlpSpanDB, RunDB


@pytest.fixture(autouse=True)
def _force_auth_secret(monkeypatch: MonkeyPatch) -> None:
    """Force open-dev mode so the ingestion route accepts without credentials."""
    monkeypatch.setattr(auth_module, "AUTH_SECRET", "")
    monkeypatch.setattr(auth_middleware, "AUTH_SECRET", "")


def _batch(*events: dict[str, object]) -> dict[str, object]:
    return {"batch": list(events)}


def _run_create(
    run_id: str = "adap-trace-001",
    project: str = "adapter-project",
    **extra: object,
) -> dict[str, object]:
    body: dict[str, object] = {
        "id": run_id,
        "project": project,
        "flow_name": "test-flow",
    }
    body.update(extra)
    return {"id": "evt-run", "timestamp": "2026-07-11T12:00:00Z", "type": "run-create", "body": body}


def _call_create(
    call_id: str = "adap-call-001",
    run_id: str = "adap-trace-001",
    project: str = "adapter-project",
    **extra: object,
) -> dict[str, object]:
    body: dict[str, object] = {
        "id": call_id,
        "run_id": run_id,
        "project": project,
        "model": "gpt-4o",
        "created_at": "2026-07-11T12:00:01Z",
        "observation_type": "GENERATION",
        "step_name": "chat gpt-4o",
    }
    body.update(extra)
    return {"id": "evt-call", "timestamp": "2026-07-11T12:00:01Z", "type": "call-create", "body": body}


def _call_update(
    call_id: str = "adap-call-001",
    project: str = "adapter-project",
    **extra: object,
) -> dict[str, object]:
    body: dict[str, object] = {
        "id": call_id,
        "project": project,
        "output": {"text": "hello"},
        "end_time": "2026-07-11T12:00:03Z",
        "prompt_tokens": 100,
        "completion_tokens": 50,
    }
    body.update(extra)
    return {"id": "evt-update", "timestamp": "2026-07-11T12:00:03Z", "type": "call-update", "body": body}


class TestIngestionWritesCanonicalStore:
    """The route must write to OtlpSpanDB (canonical), not just RunDB/LoggedCallDB."""

    def test_call_create_writes_canonical_span(self, client: TestClient, session: Session):
        """A call-create event produces an OtlpSpanDB row — the source of truth."""
        response = client.post(
            "/api/v1/ingestion",
            json=_batch(
                _run_create(),
                _call_create(),
            ),
        )
        assert response.status_code == 200, response.text

        session.expire_all()
        spans = list(session.exec(select(OtlpSpanDB)).all())
        # At least the call span must be in the canonical store.
        call_spans = [s for s in spans if s.span_id == "adap-call-001"]
        assert len(call_spans) == 1, f"expected 1 canonical call span, got {len(call_spans)}"
        # The canonical span carries the model attribute.
        attrs = call_spans[0].attributes or {}
        assert attrs.get("gen_ai.request.model") == "gpt-4o"

    def test_call_update_preserves_canonical_span(self, client: TestClient, session: Session):
        """A call-update merges into the existing canonical span + re-projects."""
        client.post(
            "/api/v1/ingestion",
            json=_batch(_run_create(), _call_create()),
        )
        response = client.post(
            "/api/v1/ingestion",
            json=_batch(_call_update()),
        )
        assert response.status_code == 200, response.text

        session.expire_all()
        spans = list(
            session.exec(
                select(OtlpSpanDB).where(OtlpSpanDB.span_id == "adap-call-001")
            )
        )
        assert len(spans) == 1, "update must not duplicate the canonical span"
        # The update carried end_time + tokens; they must be on the span.
        assert spans[0].end_time is not None
        attrs = spans[0].attributes or {}
        assert attrs.get("gen_ai.usage.input_tokens") == 100

    def test_projected_call_matches_legacy_fields(self, client: TestClient, session: Session):
        """The projected LoggedCallDB (via projector) has the same fields."""
        client.post(
            "/api/v1/ingestion",
            json=_batch(
                _run_create(),
                _call_create(),
                _call_update(),
            ),
        )

        session.expire_all()
        call = session.exec(select(LoggedCallDB).where(LoggedCallDB.id == "adap-call-001")).first()
        assert call is not None
        assert call.model == "gpt-4o"
        assert call.prompt_tokens == 100
        assert call.completion_tokens == 50
        assert call.total_tokens == 150
        assert call.end_time is not None
