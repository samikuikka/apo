# pyright: reportUnusedImport=false, reportUnusedCallResult=false, reportAny=false, reportUnusedParameter=false, reportUnknownVariableType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedFunction=false

"""Tests for external execution mode (Issue #4).

``POST /v1/agent-task-batch-runs/external`` creates batch + task run rows and
mints a per-run scoped trace token, but does NOT spawn a subprocess. An
external executor (the CLI ``--local`` flag) runs the task on its own machine
and reports the result back via ``POST /v1/agent-task-runs/{id}/result``.

This split lets teams whose tasks need dev-machine credentials / VPC tunnels
(bindlegal/bind) run locally while still creating dashboard rows and linking
their traces via the existing SPEC-128/129 claim machinery.
"""

from datetime import datetime, timezone
from typing import cast

import pytest
from fastapi.testclient import TestClient
from _pytest.monkeypatch import MonkeyPatch
from sqlmodel import Session, select

from apo.auth import service_tokens
from apo.auth.service_tokens import decode_service_token
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    ProjectDB,
    ProjectTaskInventoryDB,
    ProjectTaskSourceDB,
)
from apo.models.trace_ingestion import TraceIngestionContext
from apo.services import agent_task_runner
from apo.services.otlp_receiver import OtlpReceiver


@pytest.fixture
def force_service_token_secret(monkeypatch: MonkeyPatch) -> str:
    """Set AUTH_SECRET on the service_tokens module so tokens are verifiable.

    The route tests rely on conftest's open-dev auth bypass (empty
    ``AUTH_SECRET`` on the middleware). Service tokens read their own module
    binding, so we set that in isolation and restore it afterwards.
    """
    monkeypatch.setattr(service_tokens, "AUTH_SECRET", "test-auth-secret")
    return "test-auth-secret"


@pytest.fixture(autouse=True)
def _stub_task_dir_resolution(monkeypatch: MonkeyPatch, tmp_path) -> None:
    """Avoid touching git during create_batch_run's happy path.

    ``resolve_inventory_task_dir`` normally clones/checks out the task source
    repo. In tests we point it at a synthetic directory so the batch-run
    service code path runs end-to-end without a network.
    """
    task_dir = tmp_path / _TASK_ID
    task_dir.mkdir(parents=True, exist_ok=True)

    def _fake_resolve(
        _session: Session,
        _source: ProjectTaskSourceDB,
        _task_path: str,
        *,
        resolved_commit_sha: str | None = None,
    ) -> object:
        return task_dir

    monkeypatch.setattr(
        "apo.services.agent_task_runner.resolve_inventory_task_dir",
        _fake_resolve,
    )


_PROJECT = "proj-external"
_TASK_ID = "api-testing"


def _seed_project(session: Session, *, project: str = _PROJECT) -> None:
    """Create a project + ready task source + one task inventory row."""
    now = datetime.now(timezone.utc)
    session.add(
        ProjectDB(
            id=project,
            name="External Execution Project",
            created_by="user-ext",
            created_at=now,
            updated_at=now,
        )
    )
    source = ProjectTaskSourceDB(
        id=f"src-{project}",
        project=project,
        source_type="git",
        display_name="Tasks",
        repository_url="https://github.com/example/repo.git",
        git_ref="main",
        subpath="tasks",
        status="ready",
        last_synced_at=now,
        last_resolved_commit_sha="abc123",
        created_at=now,
        updated_at=now,
    )
    session.add(source)
    session.add(
        ProjectTaskInventoryDB(
            id=f"inv-{project}",
            project=project,
            task_source_id=source.id,
            task_id=_TASK_ID,
            display_name=_TASK_ID,
            adapter_name="demoAdapter",
            folder_path="",
            task_path=_TASK_ID,
            source_type="git",
            source_ref="main",
            source_commit_sha="abc123",
            source_subpath="tasks",
            discovered_at=now,
        )
    )
    session.commit()


def _create_external_body(project: str = _PROJECT, task_id: str = _TASK_ID) -> dict[str, object]:
    return {
        "project": project,
        "selection_type": "task",
        "task_paths": [task_id],
        "run_metadata": {"trigger": {"source": "cli-local"}},
    }


def _extract_run_id(batch_body: dict[str, object]) -> str:
    """Type-safe access to the first task run id in an external-create response."""
    task_runs = cast(list[dict[str, object]], batch_body["task_runs"])
    return cast(str, task_runs[0]["id"])


# ============================================================================
# Step 1: POST /v1/agent-task-batch-runs/external
# ============================================================================


class TestCreateExternalBatch:
    """The external-create endpoint records rows + mints tokens, no subprocess."""

    def test_external_create_does_not_spawn_subprocess(
        self, client: TestClient, session: Session, monkeypatch: MonkeyPatch
    ) -> None:
        _seed_project(session)
        # The legacy pool dispatcher must never run for external batches.
        submit_calls: list[str] = []
        monkeypatch.setattr(
            agent_task_runner,
            "_run_batch_in_background",
            lambda batch_id: submit_calls.append(batch_id),
        )

        resp = client.post("/v1/agent-task-batch-runs/external", json=_create_external_body())

        assert resp.status_code == 201, resp.text
        assert submit_calls == []  # executor never invoked

    def test_external_create_returns_task_run_with_scoped_token(
        self, client: TestClient, session: Session, force_service_token_secret: str
    ) -> None:
        _seed_project(session)

        resp = client.post("/v1/agent-task-batch-runs/external", json=_create_external_body())

        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["project"] == _PROJECT
        assert len(body["task_runs"]) == 1

        run = body["task_runs"][0]
        assert run["task_id"] == _TASK_ID
        assert "trace_token" in run
        assert run["trace_token"]  # non-empty JWT

        # Token is scoped to exactly this task run.
        claims = decode_service_token(run["trace_token"])
        assert claims is not None
        assert claims["sub"] == run["id"]
        assert claims["project"] == _PROJECT
        assert claims["typ"] == "agent_task_trace"
        permissions = cast(list[str], claims["permissions"])
        assert "trace:ingest" in permissions
        assert "trace:complete" in permissions

    def test_external_create_sets_running_status_immediately(
        self, client: TestClient, session: Session
    ) -> None:
        """External runs are visible as 'running' so the dashboard tracks them live."""
        _seed_project(session)

        resp = client.post("/v1/agent-task-batch-runs/external", json=_create_external_body())

        body = resp.json()
        assert body["status"] == "running"
        assert all(r["status"] == "running" for r in body["task_runs"])
        assert all(r["started_at"] for r in body["task_runs"])

    def test_external_create_persists_rows(
        self, client: TestClient, session: Session
    ) -> None:
        _seed_project(session)

        resp = client.post("/v1/agent-task-batch-runs/external", json=_create_external_body())
        batch_id = resp.json()["id"]

        # Re-open a session to prove it committed.
        with Session(session.get_bind()) as fresh:
            batch = fresh.get(AgentTaskBatchRunDB, batch_id)
            assert batch is not None
            assert batch.status == "running"
            runs = fresh.exec(
                select(AgentTaskRunDB).where(AgentTaskRunDB.batch_run_id == batch_id)
            ).all()
            assert len(runs) == 1
            assert runs[0].status == "running"


# ============================================================================
# Step 2: POST /v1/agent-task-runs/{task_run_id}/result
# ============================================================================


def _create_external_batch(client: TestClient, session: Session) -> dict[str, object]:
    """Helper: seed project + create an external batch, return the response body."""
    _seed_project(session)
    resp = client.post("/v1/agent-task-batch-runs/external", json=_create_external_body())
    assert resp.status_code == 201, resp.text
    return cast(dict[str, object], resp.json())


def _external_batch_ids(client: TestClient, session: Session) -> tuple[str, str]:
    """Helper: create an external batch and return (batch_id, task_run_id)."""
    body = _create_external_batch(client, session)
    return cast(str, body["id"]), _extract_run_id(body)


def _external_run_with_token(client: TestClient, session: Session) -> tuple[str, str]:
    """Helper: create an external batch and return (task_run_id, trace_token)."""
    body = _create_external_batch(client, session)
    task_runs = cast(list[dict[str, object]], body["task_runs"])
    run = task_runs[0]
    return cast(str, run["id"]), cast(str, run["trace_token"])


class TestReportResult:
    """The result-report endpoint finalizes the task run from an external executor."""

    def test_report_result_finalizes_task_run(
        self, client: TestClient, session: Session
    ) -> None:
        _batch_id, task_run_id = _external_batch_ids(client, session)

        result = {
            "pass_result": True,
            "adapter_name": "demoAdapter",
            "checks": [{"id": "c1", "pass": True}],
            "transcript": {"events": []},
            "deliverables": {"summary": "ok"},
        }
        resp = client.post(f"/v1/agent-task-runs/{task_run_id}/result", json=result)

        assert resp.status_code == 200, resp.text
        detail = resp.json()
        assert detail["status"] == "passed"
        assert detail["pass_result"] is True
        assert detail["adapter_name"] == "demoAdapter"
        assert detail["checks_json"] == [{"id": "c1", "pass": True}]
        assert detail["transcript_json"] == {"events": []}
        assert detail["deliverables_json"] == {"summary": "ok"}
        assert detail["completed_at"] is not None

    def test_report_result_rolls_up_batch_status(
        self, client: TestClient, session: Session
    ) -> None:
        batch_id, task_run_id = _external_batch_ids(client, session)

        client.post(
            f"/v1/agent-task-runs/{task_run_id}/result",
            json={"pass_result": False, "checks": [{"id": "c1", "pass": False}]},
        )

        batch = session.get(AgentTaskBatchRunDB, batch_id)
        assert batch is not None
        assert batch.status == "completed"
        assert batch.passed_tasks == 0
        assert batch.failed_tasks == 1
        assert batch.total_checks == 1
        assert batch.passed_checks == 0

    def test_report_result_rejects_double_report(
        self, client: TestClient, session: Session
    ) -> None:
        """Report-once contract: a terminal run cannot be reported again."""
        _batch_id, task_run_id = _external_batch_ids(client, session)

        first = client.post(
            f"/v1/agent-task-runs/{task_run_id}/result", json={"pass_result": True}
        )
        assert first.status_code == 200

        second = client.post(
            f"/v1/agent-task-runs/{task_run_id}/result", json={"pass_result": False}
        )
        assert second.status_code == 409

    def test_report_result_returns_404_for_missing_run(
        self, client: TestClient, session: Session
    ) -> None:
        resp = client.post(
            "/v1/agent-task-runs/nonexistent/result", json={"pass_result": True}
        )
        assert resp.status_code == 404

    def test_report_result_records_failure_status(
        self, client: TestClient, session: Session
    ) -> None:
        _batch_id, task_run_id = _external_batch_ids(client, session)

        resp = client.post(
            f"/v1/agent-task-runs/{task_run_id}/result",
            json={
                "pass_result": False,
                "checks": [{"id": "c1", "pass": False}, {"id": "c2", "pass": True}],
                "error_message": "checks failed",
            },
        )

        assert resp.status_code == 200, resp.text
        detail = resp.json()
        assert detail["status"] == "failed"
        assert detail["pass_result"] is False
        assert detail["total_checks"] == 2
        assert detail["passed_checks"] == 1
        # Issue #8: an externally-reported error_message must be persisted, not
        # silently dropped. Previously finalize_task_run_with_result always
        # overwrote it to None.
        assert detail["error_message"] == "checks failed"

    def test_zero_checks_failed_run_records_no_tests_notice(
        self, client: TestClient, session: Session
    ) -> None:
        """Issue #8: a failed run with zero checks explains itself on the row.

        The dashboard and `apo runs show` read error_message to show *why* a
        run failed. A bare status=failed with error_message=None made a silent
        registration bug (e.g. double-import wiping the check registry) look
        like a real check failure.
        """
        _batch_id, task_run_id = _external_batch_ids(client, session)

        resp = client.post(
            f"/v1/agent-task-runs/{task_run_id}/result",
            json={"pass_result": False, "checks": []},
        )

        assert resp.status_code == 200, resp.text
        detail = resp.json()
        assert detail["status"] == "failed"
        assert detail["pass_result"] is False
        assert detail["total_checks"] == 0
        assert detail["error_message"] is not None
        assert "no tests were registered" in detail["error_message"].lower()
        assert "test()" in detail["error_message"]

    def test_zero_checks_passing_run_clears_error_message(
        self, client: TestClient, session: Session
    ) -> None:
        """A passing run never sets a no-tests notice.

        Guards against the naive implementation that fires the notice whenever
        checks is empty — it must be scoped to the failed case only. (A passing
        run with zero checks shouldn't normally happen, but if it does we don't
        want to fabricate a misleading error.)
        """
        _batch_id, task_run_id = _external_batch_ids(client, session)

        resp = client.post(
            f"/v1/agent-task-runs/{task_run_id}/result",
            json={"pass_result": True, "checks": []},
        )

        assert resp.status_code == 200, resp.text
        detail = resp.json()
        assert detail["status"] == "passed"
        assert detail["pass_result"] is True
        assert detail["error_message"] is None


# ============================================================================
# Step 3: end-to-end — the minted token authorizes the trace claim
# ============================================================================


class TestExternalClaimIntegration:
    """The token minted at external-create must work with the SPEC-128/129 claim path.

    This is the integration test that proves the whole chain: CLI-local
    execution sends a trace (carrying ``apo.task.run.id``) authenticated with
    the minted service token, and the existing receiver links it back to the
    task run row. Without this, local runs would be dashboard-blind (Issue #4).
    """

    def test_minted_token_claims_trace_for_task_run(
        self, client: TestClient, session: Session, force_service_token_secret: str
    ) -> None:
        task_run_id, token = _external_run_with_token(client, session)

        # Build an OTLP payload whose root span carries the task-run id.
        trace_id = "fedcba9876543210fedcba9876543210"
        payload = _make_otlp_trace(trace_id, task_run_id=task_run_id)

        # Decode the minted token into the ingestion context — this is what
        # the auth middleware would do on a real ingest request.
        claims = decode_service_token(token)
        assert claims is not None
        context = TraceIngestionContext(
            project_id=_PROJECT,
            auth_method="service_token",
            service_task_run_id=cast(str, claims["sub"]),
        )

        result = OtlpReceiver().ingest(
            payload=payload,
            content_type="application/json",
            project_id=_PROJECT,
            session=session,
            context=context,
        )
        assert result.accepted == 1
        assert result.errors == []

        # The existing claim machinery linked the trace to the task run.
        task_run = session.get(AgentTaskRunDB, task_run_id)
        assert task_run is not None
        assert task_run.trace_run_id == trace_id

    def test_report_result_accepts_claimed_trace_run_id(
        self, client: TestClient, session: Session, force_service_token_secret: str
    ) -> None:
        """After the trace claims the run, reporting its id succeeds (no mismatch)."""
        task_run_id, _token = _external_run_with_token(client, session)

        trace_id = "1234567890abcdef1234567890abcdef"
        OtlpReceiver().ingest(
            payload=_make_otlp_trace(trace_id, task_run_id=task_run_id),
            content_type="application/json",
            project_id=_PROJECT,
            session=session,
            context=TraceIngestionContext(
                project_id=_PROJECT,
                auth_method="service_token",
                service_task_run_id=task_run_id,
            ),
        )

        # CLI reports back the trace it produced — reconcile_trace_id accepts
        # the match (RuntimeError on mismatch).
        resp = client.post(
            f"/v1/agent-task-runs/{task_run_id}/result",
            json={"pass_result": True, "trace_run_id": trace_id},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["trace_run_id"] == trace_id

    def test_report_result_rejects_mismatched_trace_run_id(
        self, client: TestClient, session: Session, force_service_token_secret: str
    ) -> None:
        """If the claimed trace differs from what the CLI reports, refuse to clobber it."""
        task_run_id, _token = _external_run_with_token(client, session)

        claimed_trace = "aaa111222333444aaa111222333444aa"
        OtlpReceiver().ingest(
            payload=_make_otlp_trace(claimed_trace, task_run_id=task_run_id),
            content_type="application/json",
            project_id=_PROJECT,
            session=session,
            context=TraceIngestionContext(
                project_id=_PROJECT,
                auth_method="service_token",
                service_task_run_id=task_run_id,
            ),
        )

        different_trace = "bbb999888777666bbb999888777666bb"
        resp = client.post(
            f"/v1/agent-task-runs/{task_run_id}/result",
            json={"pass_result": True, "trace_run_id": different_trace},
        )
        # reconcile_trace_id raised RuntimeError (conflict with the claimed
        # trace) -> route maps to 409 Conflict.
        assert resp.status_code == 409
        # The claimed trace must be preserved (not clobbered by the report).
        task_run = session.get(AgentTaskRunDB, task_run_id)
        assert task_run is not None
        assert task_run.trace_run_id == claimed_trace


def _make_otlp_trace(trace_id: str, *, task_run_id: str) -> bytes:
    """Build a minimal OTLP/JSON root span carrying apo.task.run.id."""
    from datetime import datetime, timedelta, timezone
    import json

    now = datetime.now(timezone.utc)
    span_id = trace_id[:16].rjust(16, "0")
    return json.dumps({
        "resourceSpans": [{
            "scopeSpans": [{
                "spans": [{
                    "traceId": trace_id,
                    "spanId": span_id,
                    "name": "apo.task.run",
                    "startTime": now.isoformat(),
                    "endTime": (now + timedelta(seconds=5)).isoformat(),
                    "attributes": [
                        {"key": "apo.observation.type", "value": {"stringValue": "AGENT"}},
                        {"key": "apo.task.run.id", "value": {"stringValue": task_run_id}},
                    ],
                }],
            }],
        }],
    }).encode()

