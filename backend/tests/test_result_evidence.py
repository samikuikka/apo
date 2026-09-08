# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnknownLambdaType=false, reportMissingParameterType=false, reportUnknownParameterType=false, reportUnusedCallResult=false, reportUntypedFunctionDecorator=false, reportCallIssue=false, reportAttributeAccessIssue=false, reportReturnType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportUnusedParameter=false, reportIndexIssue=false

"""Result-evidence staging protocol (issue #251).

A document-heavy run whose legitimate transcript/deliverables overflow the
result envelope uploads them as attempt-scoped evidence parts before
finalization, then submits a small ``/result`` that references the parts by
id. These tests drive the full protocol through the real TestClient:
intent → streamed PUT → finalization with ``evidence_refs`` → permanent
stores populated → staging deleted.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from apo.models.db import (
    AgentTaskCheckReportDB,
    AgentTaskDeliverableDB,
    AgentTaskResultEvidenceDB,
    AgentTaskRunDB,
    TaskExecutionAttemptDB,
)
from apo.services import executor_auth
from sqlmodel import Session, select


def _seed_project(session: Session, project_id: str = "proj-evidence") -> None:
    from apo.models.db import ProjectDB

    session.add(ProjectDB(id=project_id, name=project_id, created_at=datetime.now(timezone.utc)))
    session.commit()


def _caller_body(project_id: str = "proj-evidence") -> dict[str, object]:
    return {
        "project": project_id,
        "task": {
            "task_id": "harvey-lab/extract-psa-key-terms",
            "task_path": "harvey-lab/extract-psa-key-terms",
            "display_name": "extract-psa-key-terms",
            "adapter_name": "real-agent",
            "has_checks": True,
        },
        "environment": "default",
        "run_metadata": {"trigger": {"source": "cli"}},
        "source_attestation": {
            "source_type": "caller_worktree",
            "repository_url": None,
            "base_commit_sha": None,
            "dirty": True,
            "content_sha256": "b" * 64,
            "task_root_label": "tasks",
            "file_count": 3,
            "uncompressed_size_bytes": 1024,
        },
        "caller_identity": {
            "client": "apo-cli",
            "client_version": "0.1.0",
            "os": "linux",
            "architecture": "x64",
        },
        "task_definition": {
            "schema_version": 1,
            "files": [
                {
                    "path": "extract.eval.ts",
                    "content": "task('extract-psa-key-terms');\n",
                }
            ],
        },
    }


@pytest.fixture
def auth_secret(monkeypatch: pytest.MonkeyPatch) -> str:
    monkeypatch.setattr(executor_auth, "AUTH_SECRET", "test-evidence-secret")
    return "test-evidence-secret"


class ClaimedAttempt:
    """A caller run claimed, started, and ready to upload evidence."""

    def __init__(self, client: Any, body: dict[str, object]) -> None:
        self.client = client
        self.task_run_id = body["task_run_id"]
        self.attempt_id = body["attempt_id"]
        self.headers = {"Authorization": f"Bearer {body['attempt_jwt']}"}

    def create_intent(self, payload: dict[str, object]) -> Any:
        return self.client.post(
            f"/v1/executor-protocol/v1/attempts/{self.attempt_id}/result-evidence",
            json=payload,
            headers=self.headers,
        )

    def put(self, evidence_id: str, data: bytes) -> Any:
        return self.client.put(
            f"/v1/executor-protocol/result-evidence/{evidence_id}",
            content=data,
            headers={**self.headers, "Content-Type": "application/octet-stream"},
        )

    def result(self, payload: dict[str, object]) -> Any:
        return self.client.post(
            f"/v1/executor-protocol/v1/attempts/{self.attempt_id}/result",
            json=payload,
            headers=self.headers,
        )


@pytest.fixture
def claimed(client: Any, session: Session, auth_secret: str) -> ClaimedAttempt:
    """Caller create-and-claim + /start, with evidence upload ready."""
    _seed_project(session)
    r = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body())
    assert r.status_code == 201, r.text
    body = r.json()
    claimed_attempt = ClaimedAttempt(client, body)
    r = client.post(
        f"/v1/executor-protocol/v1/attempts/{claimed_attempt.attempt_id}/start",
        json={"driver_kind": "caller", "runtime": {}},
        headers=claimed_attempt.headers,
    )
    assert r.status_code == 200, r.text
    return claimed_attempt


def _compact(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _upload(
    claimed: ClaimedAttempt,
    slot: str,
    value: object,
    *,
    deliverable_name: str | None = None,
) -> tuple[str, bytes]:
    """Intent + PUT one evidence part; returns (evidence_id, wire bytes)."""
    payload: dict[str, object] = {
        "slot": slot,
        "size_bytes": None,  # filled below
        "sha256": None,
    }
    data = _compact(value)
    payload["size_bytes"] = len(data)
    payload["sha256"] = _sha(data)
    if deliverable_name is not None:
        payload["deliverable_name"] = deliverable_name
    r = claimed.create_intent(payload)
    assert r.status_code == 201, r.text
    intent = r.json()
    r = claimed.put(intent["id"], data)
    assert r.status_code == 200, r.text
    return intent["id"], data


# ---------------------------------------------------------------------------
# Advertisement
# ---------------------------------------------------------------------------


def test_caller_create_advertises_evidence_support(
    client: Any, session: Session, auth_secret: str
) -> None:
    _seed_project(session)
    r = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body())
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["result_evidence_supported"] is True
    assert isinstance(body["result_evidence_max_item_bytes"], int)
    assert body["result_evidence_max_item_bytes"] > 10 * 1024 * 1024
    assert isinstance(body["result_evidence_max_total_bytes"], int)


# ---------------------------------------------------------------------------
# Intent + PUT
# ---------------------------------------------------------------------------


def test_intent_requires_running_attempt(client: Any, session: Session, auth_secret: str) -> None:
    _seed_project(session)
    r = client.post("/v1/agent-task-batch-runs/caller", json=_caller_body())
    assert r.status_code == 201, r.text
    c = ClaimedAttempt(client, r.json())
    # No /start yet: the attempt is still "leased", not "running".
    data = _compact({"messages": []})
    r = c.create_intent(
        {"slot": "transcript", "size_bytes": len(data), "sha256": _sha(data)}
    )
    assert r.status_code == 409, r.text
    assert "running" in r.text


def test_intent_idempotent_same_metadata_conflict_on_change(claimed: ClaimedAttempt) -> None:
    data = _compact({"messages": []})
    base = {"slot": "transcript", "size_bytes": len(data), "sha256": _sha(data)}
    r1 = claimed.create_intent(dict(base))
    assert r1.status_code == 201, r1.text
    r2 = claimed.create_intent(dict(base))
    assert r2.status_code == 201, r2.text
    assert r2.json()["id"] == r1.json()["id"]

    other = _compact({"messages": ["x"]})
    r3 = claimed.create_intent(
        {"slot": "transcript", "size_bytes": len(other), "sha256": _sha(other)}
    )
    assert r3.status_code == 409, r3.text


def test_intent_rejects_unknown_slot_and_missing_deliverable_name(claimed: ClaimedAttempt) -> None:
    data = _compact({"a": 1})
    r = claimed.create_intent(
        {"slot": "manifesto", "size_bytes": len(data), "sha256": _sha(data)}
    )
    assert r.status_code == 422, r.text

    r = claimed.create_intent(
        {"slot": "deliverable", "size_bytes": len(data), "sha256": _sha(data)}
    )
    assert r.status_code == 422, r.text

    r = claimed.create_intent(
        {
            "slot": "deliverable",
            "deliverable_name": "draftedDocument",
            "size_bytes": len(data),
            "sha256": _sha(data),
        }
    )
    assert r.status_code == 201, r.text


def test_put_verifies_digest_and_stays_pending_on_mismatch(claimed: ClaimedAttempt) -> None:
    data = _compact({"messages": ["hello"]})
    r = claimed.create_intent(
        {"slot": "transcript", "size_bytes": len(data), "sha256": _sha(data)}
    )
    assert r.status_code == 201, r.text
    evidence_id = r.json()["id"]

    wrong = b'{"messages":["goodbye"]}'
    r = claimed.put(evidence_id, wrong)
    assert r.status_code == 422, r.text

    r = claimed.put(evidence_id, data)
    assert r.status_code == 200, r.text
    # Idempotent re-PUT of the same bytes is a 200, not a conflict.
    r = claimed.put(evidence_id, data)
    assert r.status_code == 200, r.text


def test_put_rejects_foreign_attempt_token(
    client: Any, session: Session, auth_secret: str, claimed: ClaimedAttempt
) -> None:
    data = _compact({"messages": []})
    r = claimed.create_intent(
        {"slot": "transcript", "size_bytes": len(data), "sha256": _sha(data)}
    )
    evidence_id = r.json()["id"]

    # A second, unrelated attempt must not be able to PUT someone else's part.
    _seed_project(session, "proj-evidence-2")
    body2 = _caller_body("proj-evidence-2")
    body2["source_attestation"]["content_sha256"] = "c" * 64  # distinct revision
    r = client.post("/v1/agent-task-batch-runs/caller", json=body2)
    assert r.status_code == 201, r.text
    other = ClaimedAttempt(client, r.json())
    r = client.post(
        f"/v1/executor-protocol/v1/attempts/{other.attempt_id}/start",
        json={"driver_kind": "caller", "runtime": {}},
        headers=other.headers,
    )
    assert r.status_code == 200, r.text

    r = other.client.put(
        f"/v1/executor-protocol/result-evidence/{evidence_id}",
        content=data,
        headers={**other.headers, "Content-Type": "application/octet-stream"},
    )
    # Opaque denial, same posture as cross-run deliverable access: a foreign
    # attempt learns nothing about the part's existence.
    assert r.status_code == 404, r.text


# ---------------------------------------------------------------------------
# Finalization with evidence refs
# ---------------------------------------------------------------------------


def test_finalize_with_evidence_refs_records_full_run(
    client: Any, session: Session, claimed: ClaimedAttempt
) -> None:
    transcript = {"messages": [{"role": "user", "content": "draft the NDA"}]}
    doc = {"title": "NDA", "clauses": ["a", "b"]}
    checks = [{"name": "includes-term", "pass": True}]

    transcript_id, _ = _upload(claimed, "transcript", transcript)
    doc_id, _ = _upload(claimed, "deliverable", doc, deliverable_name="draftedDocument")
    checks_id, _ = _upload(claimed, "checks", checks)

    r = claimed.result(
        {
            "completion_id": "comp-ev-1",
            "pass_result": True,
            "adapter_name": "real-agent",
            "evidence_refs": [transcript_id, doc_id, checks_id],
        }
    )
    assert r.status_code == 200, r.text

    run = session.get(AgentTaskRunDB, claimed.task_run_id)
    assert run is not None and run.status == "passed"
    assert run.transcript_json == transcript
    reports = session.exec(
        select(AgentTaskCheckReportDB).where(AgentTaskCheckReportDB.run_id == claimed.task_run_id)
    ).all()
    assert len(reports) == 1
    assert reports[0].value_json and reports[0].value_json[0]["name"] == "includes-term"

    deliverables = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == claimed.task_run_id
        )
    ).all()
    assert len(deliverables) == 1
    assert deliverables[0].name == "draftedDocument"
    assert deliverables[0].kind == "json"
    assert deliverables[0].inline_value_json == {"value": doc}

    # Staging is gone: no rows survive a successful finalization.
    rows = session.exec(select(AgentTaskResultEvidenceDB)).all()
    assert rows == []


def test_finalize_rejects_pending_and_foreign_refs(claimed: ClaimedAttempt) -> None:
    data = _compact({"messages": []})
    r = claimed.create_intent(
        {"slot": "transcript", "size_bytes": len(data), "sha256": _sha(data)}
    )
    pending_id = r.json()["id"]  # intent created, bytes never uploaded

    r = claimed.result(
        {"completion_id": "comp-ev-2", "pass_result": True, "evidence_refs": [pending_id]}
    )
    assert r.status_code == 409, r.text

    r = claimed.result(
        {"completion_id": "comp-ev-2", "pass_result": True, "evidence_refs": ["rev_doesnotexist"]}
    )
    assert r.status_code == 409, r.text


def test_finalize_rejects_inline_plus_ref_conflict(claimed: ClaimedAttempt) -> None:
    transcript_id, _ = _upload(claimed, "transcript", {"messages": []})
    r = claimed.result(
        {
            "completion_id": "comp-ev-3",
            "pass_result": True,
            "transcript": {"messages": ["inline"]},
            "evidence_refs": [transcript_id],
        }
    )
    assert r.status_code == 409, r.text
    assert "transcript" in r.text


def test_finalize_replay_after_evidence_cleanup_is_idempotent(claimed: ClaimedAttempt) -> None:
    transcript_id, _ = _upload(claimed, "transcript", {"messages": []})
    body = {
        "completion_id": "comp-ev-4",
        "pass_result": True,
        "evidence_refs": [transcript_id],
    }
    r1 = claimed.result(dict(body))
    assert r1.status_code == 200, r1.text
    r2 = claimed.result(dict(body))
    assert r2.status_code == 200, r2.text
    assert r2.json().get("status") in ("replayed", "succeeded")


def test_failure_finalization_deletes_staging_evidence(
    session: Session, claimed: ClaimedAttempt
) -> None:
    from apo.models.db import AgentTaskResultEvidenceDB

    _upload(claimed, "transcript", {"messages": []})
    rows = session.exec(select(AgentTaskResultEvidenceDB)).all()
    assert len(rows) == 1

    r = claimed.client.post(
        f"/v1/executor-protocol/v1/attempts/{claimed.attempt_id}/failure",
        json={"completion_id": "comp-ev-f", "failure_kind": "task_runtime", "error_message": "boom"},
        headers=claimed.headers,
    )
    assert r.status_code == 200, r.text
    rows = session.exec(select(AgentTaskResultEvidenceDB)).all()
    assert rows == []


# ---------------------------------------------------------------------------
# Large payloads (the acceptance scenario)
# ---------------------------------------------------------------------------


def test_25mib_document_heavy_run_records_under_result_cap(
    client: Any, session: Session, claimed: ClaimedAttempt, tmp_path: Any
) -> None:
    """Combined logical evidence ≥ 25 MiB records with the default 10 MiB cap.

    Mirrors the dd-summary-memo shape: a transcript that dominates, a large
    JSON document deliverable, plus compacted checks — none of which could
    fit in the inline result envelope.
    """
    import random

    rng = random.Random(42)
    # Incompressible-looking JSON: long hex strings do not gzip down.
    def hex_blob(n: int) -> str:
        return rng.randbytes(n // 2 + 1).hex()[:n]

    transcript = {
        "messages": [
            {"role": "user" if i % 2 == 0 else "assistant", "content": hex_blob(400_000)}
            for i in range(60)
        ]
    }
    document = {"dataRoom": [hex_blob(400_000) for _ in range(8)]}
    checks = [{"name": f"c{i}", "pass": i % 3 != 0} for i in range(68)]

    transcript_id, transcript_bytes = _upload(claimed, "transcript", transcript)
    doc_id, doc_bytes = _upload(claimed, "deliverable", document, deliverable_name="memo")
    checks_id, checks_bytes = _upload(claimed, "checks", checks)

    total = len(transcript_bytes) + len(doc_bytes) + len(checks_bytes)
    assert total >= 25 * 1024 * 1024, f"scaled evidence too small: {total}"

    r = claimed.result(
        {
            "completion_id": "comp-ev-25mib",
            "pass_result": False,
            "adapter_name": "real-agent",
            "evidence_refs": [transcript_id, doc_id, checks_id],
        }
    )
    assert r.status_code == 200, r.text

    run = session.get(AgentTaskRunDB, claimed.task_run_id)
    assert run is not None and run.status == "failed"
    assert run.total_checks == 68 and run.passed_checks == 45
    assert run.transcript_json is not None
    assert len(run.transcript_json["messages"]) == 60

    deliverables = session.exec(
        select(AgentTaskDeliverableDB).where(
            AgentTaskDeliverableDB.task_run_id == claimed.task_run_id
        )
    ).all()
    assert len(deliverables) == 1
    assert deliverables[0].size_bytes == len(doc_bytes)
    assert deliverables[0].storage_key is not None  # large → object-backed


def test_unicode_payload_round_trips(claimed: ClaimedAttempt, session: Session) -> None:
    transcript = {"messages": [{"role": "user", "content": "契約書・条項の検討 📄 — ünïcødé"}]}
    transcript_id, _ = _upload(claimed, "transcript", transcript)
    r = claimed.result(
        {"completion_id": "comp-ev-uni", "pass_result": True, "evidence_refs": [transcript_id]}
    )
    assert r.status_code == 200, r.text
    run = session.get(AgentTaskRunDB, claimed.task_run_id)
    assert run is not None
    assert run.transcript_json == transcript


# ---------------------------------------------------------------------------
# Limits + cleanup
# ---------------------------------------------------------------------------


def test_intent_rejects_item_over_limit(
    claimed: ClaimedAttempt, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("APO_RESULT_EVIDENCE_MAX_ITEM_BYTES", "1024")
    data = _compact({"big": "x" * 5000})
    r = claimed.create_intent(
        {"slot": "transcript", "size_bytes": len(data), "sha256": _sha(data)}
    )
    assert r.status_code == 413, r.text


def test_maintenance_cleans_stale_evidence_rows(
    session: Session, claimed: ClaimedAttempt, monkeypatch: pytest.MonkeyPatch
) -> None:
    from apo.models.db import AgentTaskResultEvidenceDB
    from apo.services.result_evidence import cleanup_stale_result_evidence

    _upload(claimed, "transcript", {"messages": []})
    row = session.exec(select(AgentTaskResultEvidenceDB)).one()
    # Age the row past every plausible staging TTL.
    row.created_at = datetime.now(timezone.utc) - timedelta(days=3)
    session.add(row)
    session.commit()

    deleted = cleanup_stale_result_evidence(session)
    assert deleted >= 1
    rows = session.exec(select(AgentTaskResultEvidenceDB)).all()
    assert rows == []


def test_orphan_reaper_respects_evidence_objects(
    session: Session, claimed: ClaimedAttempt
) -> None:
    """Evidence storage keys must count as referenced while staging lives.

    The local-object orphan reaper deletes unreferenced store objects older
    than the grace window; without evidence keys in the referenced set it
    would eat live staging parts.
    """
    from apo.services.retention import reap_unreferenced_artifact_objects

    _upload(claimed, "transcript", {"messages": []})
    # Not deleted: the evidence row references its object.
    deleted = asyncio_run(reap_unreferenced_artifact_objects(session))
    assert deleted == 0


def asyncio_run(coro: Any) -> Any:
    import asyncio

    return asyncio.run(coro)


def test_run_deletion_removes_evidence_rows(
    session: Session, claimed: ClaimedAttempt
) -> None:
    from apo.models.db import AgentTaskResultEvidenceDB

    _upload(claimed, "transcript", {"messages": []})
    attempt = session.get(TaskExecutionAttemptDB, claimed.attempt_id)
    assert attempt is not None

    from apo.services.retention import delete_agent_task_rows

    delete_agent_task_rows(session, [claimed.task_run_id])
    rows = session.exec(
        select(AgentTaskResultEvidenceDB).where(
            AgentTaskResultEvidenceDB.task_run_id == claimed.task_run_id
        )
    ).all()
    assert rows == []
