"""
Tests for observation-level scoring and evaluation (SPEC-019).

Test cases:
1. Create observation-level score via ingestion
2. Create trace-level score
3. Score validation against ScoreConfig (min/max)
4. Categorical score validation
5. Bulk score creation
6. Partial bulk failure
7. Annotation queue creation
8. Complete annotation creates score
"""

from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import LoggedCallDB, RunDB, ScoreConfigDB


def _create_run(session: Session, run_id: str = "test-run-1") -> None:
    run = RunDB(id=run_id, project="default")
    session.add(run)
    session.commit()


def _create_call(
    session: Session, call_id: str = "test-call-1", run_id: str = "test-run-1"
) -> None:
    call = LoggedCallDB(
        id=call_id,
        project="default",
        task_id="test-task",
        run_id=run_id,
        created_at=datetime.now(timezone.utc),
        model="test-model",
        input={},
        messages=[],
        output={},
    )
    session.add(call)
    session.commit()


def _create_score_config(
    session: Session,
    data_type: str = "NUMERIC",
    min_value: float | None = 0.0,
    max_value: float | None = 1.0,
    categories: dict[str, object] | None = None,
) -> int:
    config = ScoreConfigDB(
        project="default",
        name="relevance",
        data_type=data_type,
        min_value=min_value,
        max_value=max_value,
        categories=categories,
    )
    session.add(config)
    session.commit()
    session.refresh(config)
    return config.id or 0


class TestObservationScoreViaIngestion:
    def test_create_observation_score_via_ingestion(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        _create_call(session)

        response = client.post(
            "/api/v1/ingestion",
            json={
                "batch": [
                    {
                        "id": "score-123",
                        "timestamp": "2026-06-01T00:00:00Z",
                        "type": "score-create",
                        "body": {
                            "trace_id": "test-run-1",
                            "observation_id": "test-call-1",
                            "name": "relevance",
                            "value": 0.85,
                            "data_type": "NUMERIC",
                            "source": "EVAL",
                            "comment": "Good retrieval",
                        },
                    }
                ]
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["processed"] == 1
        assert len(data["errors"]) == 0


class TestTraceScore:
    def test_create_trace_level_score(self, client: TestClient, session: Session):
        _create_run(session)

        response = client.post(
            "/api/v1/traces/test-run-1/scores",
            json={
                "name": "quality",
                "value": 0.9,
                "data_type": "NUMERIC",
                "source": "API",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "quality"
        assert data["value"] == 0.9
        assert data["source"] == "API"

    def test_get_trace_scores(self, client: TestClient, session: Session):
        _create_run(session)

        client.post(
            "/api/v1/traces/test-run-1/scores",
            json={"name": "quality", "value": 0.9},
        )
        client.post(
            "/api/v1/traces/test-run-1/scores",
            json={"name": "faithfulness", "value": 0.7},
        )

        response = client.get("/api/v1/traces/test-run-1/scores")
        assert response.status_code == 200
        data = response.json()
        assert len(data) >= 2


class TestScoreValidation:
    def test_numeric_score_validation_within_range(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        config_id = _create_score_config(session, min_value=0.0, max_value=1.0)

        response = client.post(
            "/api/v1/traces/test-run-1/scores",
            json={
                "name": "relevance",
                "value": 0.5,
                "data_type": "NUMERIC",
                "config_id": config_id,
            },
        )
        assert response.status_code == 200

    def test_numeric_score_validation_below_min(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        config_id = _create_score_config(session, min_value=0.0, max_value=1.0)

        response = client.post(
            "/api/v1/traces/test-run-1/scores",
            json={
                "name": "relevance",
                "value": -0.5,
                "data_type": "NUMERIC",
                "config_id": config_id,
            },
        )
        assert response.status_code == 400
        assert "below minimum" in str(response.json()["detail"])

    def test_numeric_score_validation_above_max(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        config_id = _create_score_config(session, min_value=0.0, max_value=1.0)

        response = client.post(
            "/api/v1/traces/test-run-1/scores",
            json={
                "name": "relevance",
                "value": 1.5,
                "data_type": "NUMERIC",
                "config_id": config_id,
            },
        )
        assert response.status_code == 400
        assert "above maximum" in str(response.json()["detail"])

    def test_categorical_score_validation(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        config_id = _create_score_config(
            session,
            data_type="CATEGORICAL",
            min_value=None,
            max_value=None,
            categories={"correct": 1.0, "partially_correct": 0.5, "incorrect": 0.0},
        )

        response = client.post(
            "/api/v1/traces/test-run-1/scores",
            json={
                "name": "relevance",
                "value": "correct",
                "data_type": "CATEGORICAL",
                "config_id": config_id,
            },
        )
        assert response.status_code == 200

    def test_categorical_score_invalid_category(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        config_id = _create_score_config(
            session,
            data_type="CATEGORICAL",
            min_value=None,
            max_value=None,
            categories={"correct": 1.0, "incorrect": 0.0},
        )

        response = client.post(
            "/api/v1/traces/test-run-1/scores",
            json={
                "name": "relevance",
                "value": "unknown",
                "data_type": "CATEGORICAL",
                "config_id": config_id,
            },
        )
        assert response.status_code == 400


class TestBulkScoreCreation:
    def test_bulk_score_creation(self, client: TestClient, session: Session):
        _create_run(session)

        response = client.post(
            "/api/v1/scores/bulk",
            json={
                "trace_id": "test-run-1",
                "scores": [
                    {"name": "quality", "value": 0.9},
                    {"name": "faithfulness", "value": 0.7},
                    {"name": "relevance", "value": 0.8},
                ],
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 3
        assert len(data["errors"]) == 0

    def test_partial_bulk_failure(self, client: TestClient, session: Session):
        _create_run(session)
        config_id = _create_score_config(session, min_value=0.0, max_value=1.0)

        response = client.post(
            "/api/v1/scores/bulk",
            json={
                "trace_id": "test-run-1",
                "scores": [
                    {"name": "quality", "value": 0.9, "config_id": config_id},
                    {"name": "relevance", "value": 5.0, "config_id": config_id},
                ],
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["created"] == 1
        assert len(data["errors"]) == 1


class TestObservationScore:
    def test_create_observation_level_score(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        _create_call(session)

        response = client.post(
            "/api/v1/observations/test-call-1/scores",
            json={
                "name": "retrieval_quality",
                "value": 0.85,
                "data_type": "NUMERIC",
                "source": "EVAL",
                "comment": "Good retrieval",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "retrieval_quality"
        assert data["value"] == 0.85
        assert data["source"] == "EVAL"
        assert data["observation_id"] == "test-call-1"
