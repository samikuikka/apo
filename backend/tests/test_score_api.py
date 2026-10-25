# pyright: reportAny=false, reportDeprecated=false, reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedImport=false

"""Tests for the Score domain API.

Scores are domain records, not synthetic spans. This tests the native
``POST /api/v1/traces/{trace_id}/scores`` and
``POST /api/v1/observations/{span_id}/scores`` endpoints that create scores
directly via an API call, not by encoding them as fake spans.
"""

import pytest
from datetime import datetime, timezone
from fastapi.testclient import TestClient
from sqlmodel import Session, text

from apo.db import engine, init_db
from apo.models.db import RunDB

_NOW = datetime.now(timezone.utc)


@pytest.fixture
def app_client():
    """Create a test client with auth bypass."""
    init_db()
    from apo.api import app
    from apo.db import get_session
    from unittest.mock import patch

    def get_session_override():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = get_session_override

    # Bypass auth by setting OPTIMIZER_DEV
    with patch.dict("os.environ", {"AUTH_SECRET": ""}):
        client = TestClient(app)
        yield client

    app.dependency_overrides.clear()


@pytest.fixture(autouse=True)
def clean_db():
    init_db()
    yield
    with Session(engine) as session:
        session.execute(text("DELETE FROM call_metrics"))
        session.execute(text("DELETE FROM run_metrics"))
        session.execute(text("DELETE FROM logged_calls"))
        session.execute(text("DELETE FROM runs"))
        session.commit()


class TestTraceScoreAPI:
    """POST /api/v1/traces/{trace_id}/scores.

    NUMERIC and CATEGORICAL variants (response shape, validation) are
    covered in test_scores.py; the BOOLEAN variant is pinned here with a
    persistence check."""

    def test_create_boolean_score_persists(self, app_client: TestClient):
        with Session(engine) as s:
            s.add(RunDB(id="bool-test-trace", project="default", environment="default", created_at=_NOW))
            s.commit()

        response = app_client.post(
            "/api/v1/traces/bool-test-trace/scores",
            json={
                "name": "passed",
                "value": True,
                "data_type": "BOOLEAN",
                "source": "EVAL",
            },
        )

        assert response.status_code == 200
        # The API normalizes BOOLEAN to its numeric JSON form.
        assert response.json()["value"] == 1
        with Session(engine) as s:
            rows = list(
                s.exec(  # pyright: ignore[reportCallIssue]
                    text("SELECT score, data_type FROM run_metrics WHERE run_id = 'bool-test-trace' AND metric_name = 'passed'")  # pyright: ignore[reportArgumentType]
                )
            )
            assert rows == [(1.0, "BOOLEAN")]
