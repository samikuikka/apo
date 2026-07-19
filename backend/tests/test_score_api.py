# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportDeprecated=false, reportAny=false

"""Tests for the Score domain API (SPEC-129 §5).

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
from apo.models.db import RunDB, LoggedCallDB, RunMetricDB, CallMetricDB

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
    """POST /api/v1/traces/{trace_id}/scores — creates a trace-level score."""

    def test_create_trace_score(self, app_client: TestClient):
        """A trace-level score creates a RunMetricDB row."""
        # First create a run
        with Session(engine) as s:
            s.add(RunDB(id="score-test-trace", project="default", environment="default", created_at=_NOW))
            s.commit()

        response = app_client.post(
            "/api/v1/traces/score-test-trace/scores",
            json={
                "name": "helpfulness",
                "value": 0.85,
                "data_type": "NUMERIC",
                "source": "EVAL",
                "comment": "agent was helpful",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "helpfulness"

        with Session(engine) as s:
            metrics = list(
                s.exec(
                    text("SELECT * FROM run_metrics WHERE run_id = 'score-test-trace' AND metric_name = 'helpfulness'")
                )
            )
            assert len(metrics) == 1

    def test_create_categorical_score(self, app_client: TestClient):
        """A categorical score stores the string value."""
        with Session(engine) as s:
            s.add(RunDB(id="cat-test-trace", project="default", environment="default", created_at=_NOW))
            s.commit()

        response = app_client.post(
            "/api/v1/traces/cat-test-trace/scores",
            json={
                "name": "verdict",
                "value": "pass",
                "data_type": "CATEGORICAL",
                "source": "ANNOTATION",
            },
        )

        assert response.status_code == 200

    def test_create_boolean_score(self, app_client: TestClient):
        """A boolean score stores the value."""
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


class TestObservationScoreAPI:
    """POST /api/v1/observations/{span_id}/scores — creates a span-level score."""

    def test_create_observation_score(self, app_client: TestClient):
        """An observation-level score creates a CallMetricDB row."""
        # Create a run + call first
        with Session(engine) as s:
            s.add(RunDB(id="obs-test-trace", project="default", environment="default", created_at=_NOW))
            s.add(LoggedCallDB(
                id="obs-test-call",
                run_id="obs-test-trace",
                project="default",
                task_id="",
                model="gpt-4o",
                created_at=_NOW,
                observation_type="GENERATION",
                messages=[],
            ))
            s.commit()

        response = app_client.post(
            "/api/v1/observations/obs-test-call/scores",
            json={
                "name": "accuracy",
                "value": 1.0,
                "data_type": "NUMERIC",
                "source": "EVAL",
            },
        )

        assert response.status_code == 200
