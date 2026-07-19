"""
Tests for annotation queue management (SPEC-019).

Test cases:
1. Annotation queue creation
2. Complete annotation creates score
"""

from datetime import datetime, timezone

from fastapi.testclient import TestClient
from sqlmodel import Session

from apo.models.db import LoggedCallDB, RunDB, ScoreConfigDB


def _create_run(session: Session, run_id: str = "test-run-1") -> None:
    run = RunDB(id=run_id, project="test-project")
    session.add(run)
    session.commit()


def _create_call(
    session: Session, call_id: str = "test-call-1", run_id: str = "test-run-1"
) -> None:
    call = LoggedCallDB(
        id=call_id,
        project="test-project",
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


def _create_score_config(session: Session) -> int:
    config = ScoreConfigDB(
        project="test-project",
        name="relevance",
        data_type="NUMERIC",
        min_value=0.0,
        max_value=1.0,
    )
    session.add(config)
    session.commit()
    session.refresh(config)
    return config.id or 0


class TestAnnotationQueue:
    def test_create_annotation_queue(self, client: TestClient):
        response = client.post(
            "/api/v1/annotations/queues",
            json={
                "project": "test-project",
                "name": "Human Relevance Review",
                "target_type": "TRACE",
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["name"] == "Human Relevance Review"
        assert data["target_type"] == "TRACE"
        assert data["is_active"] is True
        assert data["total_items"] == 0
        assert data["completed_items"] == 0

    def test_create_queue_with_score_config(
        self, client: TestClient, session: Session
    ):
        config_id = _create_score_config(session)

        response = client.post(
            "/api/v1/annotations/queues",
            json={
                "project": "test-project",
                "name": "Configured Review",
                "target_type": "TRACE",
                "score_config_id": config_id,
            },
        )

        assert response.status_code == 200
        data = response.json()
        assert data["score_config_id"] == config_id

    def test_create_queue_invalid_target_type(self, client: TestClient):
        response = client.post(
            "/api/v1/annotations/queues",
            json={
                "project": "test-project",
                "name": "Bad Queue",
                "target_type": "INVALID",
            },
        )

        assert response.status_code == 400

    def test_list_queues(self, client: TestClient):
        client.post(
            "/api/v1/annotations/queues",
            json={
                "project": "test-project",
                "name": "Queue A",
                "target_type": "TRACE",
            },
        )
        client.post(
            "/api/v1/annotations/queues",
            json={
                "project": "other-project",
                "name": "Queue B",
                "target_type": "OBSERVATION",
            },
        )

        response = client.get(
            "/api/v1/annotations/queues", params={"project": "test-project"}
        )
        assert response.status_code == 200
        data = response.json()
        assert len(data) == 1
        assert data[0]["name"] == "Queue A"


class TestCompleteAnnotation:
    def test_complete_annotation_creates_trace_score(
        self, client: TestClient, session: Session
    ):
        _create_run(session)

        queue_response = client.post(
            "/api/v1/annotations/queues",
            json={
                "project": "test-project",
                "name": "Relevance Review",
                "target_type": "TRACE",
            },
        )
        queue_id = queue_response.json()["id"]

        complete_response = client.post(
            f"/api/v1/annotations/queues/{queue_id}/complete",
            params={"trace_id": "test-run-1"},
            json={
                "score_value": 0.9,
                "comment": "Very relevant",
            },
        )

        assert complete_response.status_code == 200
        assert complete_response.json()["status"] == "success"

    def test_complete_annotation_creates_observation_score(
        self, client: TestClient, session: Session
    ):
        _create_run(session)
        _create_call(session)

        queue_response = client.post(
            "/api/v1/annotations/queues",
            json={
                "project": "test-project",
                "name": "Observation Review",
                "target_type": "OBSERVATION",
            },
        )
        queue_id = queue_response.json()["id"]

        complete_response = client.post(
            f"/api/v1/annotations/queues/{queue_id}/complete",
            params={"observation_id": "test-call-1"},
            json={
                "score_value": 0.7,
                "comment": "Decent retrieval",
            },
        )

        assert complete_response.status_code == 200
