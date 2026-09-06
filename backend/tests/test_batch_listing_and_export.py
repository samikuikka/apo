# pyright: reportAny=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportAttributeAccessIssue=false

"""Direct unit tests for batch-run listing and bulk-run export.

Exercises filtering, model facets, pagination, and export serialization
without going through FastAPI/HTTP — the reason the services were
extracted from their route handlers.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlmodel import Session

from apo.models.db import AgentTaskBatchRunDB, AgentTaskRunDB, RunDB, RunMetricDB, LoggedCallDB
from apo.routes.runs.bulk_export import collect_runs_for_export
from apo.services.agent_task_batch_listing import (
    BatchRunListFilters,
    BatchRunListPagination,
    list_batch_run_summaries,
)

_NOW = datetime.now(timezone.utc)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _batch(
    bid: str,
    *,
    project: str = "p",
    status: str = "completed",
    created_at: datetime | None = None,
    grep: str | None = None,
    environment: str = "default",
) -> AgentTaskBatchRunDB:
    return AgentTaskBatchRunDB(
        id=bid,
        project=project,
        selection_type="catalog",
        status=status,
        total_tasks=1,
        created_at=created_at or _NOW,
        environment=environment,
        grep=grep,
        execution_target_json={},
    )


def _task_run(
    trid: str,
    bid: str,
    *,
    model: str | None = None,
    effort: str | None = None,
    project: str = "p",
    cost: float = 0.0,
    tokens: int = 0,
    unpriced: int = 0,
    status: str = "success",
) -> AgentTaskRunDB:
    return AgentTaskRunDB(
        id=trid,
        batch_run_id=bid,
        task_id="t1",
        task_path="/t1",
        adapter_name="claude",
        status=status,
        project=project,  # pyright: ignore[reportCallIssue]
        configured_model=model,
        configured_effort=effort,
        total_cost=cost,
        total_tokens=tokens,
        unpriced_call_count=unpriced,
    )


def _query_batches(
    session: Session, filters: BatchRunListFilters | None = None
) -> tuple[list[str], int, list[str]]:
    """Returns (batch_ids, total_count, model_names_from_facets)."""
    page = list_batch_run_summaries(
        session,
        filters or BatchRunListFilters(),
        BatchRunListPagination(page=0, page_size=50),
    )
    return (
        [b.id for b in page.data],
        page.total_count,
        [f.model for f in page.model_facets],
    )


# ---------------------------------------------------------------------------
# Batch listing: filtering
# ---------------------------------------------------------------------------


def test_batch_list_project_filter(session: Session):
    session.add(_batch("b1", project="proj-a"))
    session.add(_batch("b2", project="proj-b"))
    session.commit()

    ids, total, _ = _query_batches(
        session, BatchRunListFilters(project="proj-a")
    )
    assert ids == ["b1"]
    assert total == 1


def test_batch_list_status_filter(session: Session):
    session.add(_batch("b1", status="completed"))
    session.add(_batch("b2", status="running"))
    session.commit()

    ids, _, _ = _query_batches(
        session, BatchRunListFilters(statuses=["running"])
    )
    assert ids == ["b2"]


def test_batch_list_status_filter_ors_multiple_statuses(session: Session):
    session.add(_batch("b1", status="completed"))
    session.add(_batch("b2", status="running"))
    session.add(_batch("b3", status="failed"))
    session.commit()

    ids, _, _ = _query_batches(
        session, BatchRunListFilters(statuses=["completed", "failed"])
    )
    assert ids == ["b1", "b3"]


def test_batch_list_search_matches_id(session: Session):
    session.add(_batch("alpha-1"))
    session.add(_batch("beta-2"))
    session.commit()

    ids, _, _ = _query_batches(session, BatchRunListFilters(search="alpha"))
    assert ids == ["alpha-1"]


def test_batch_list_search_matches_environment(session: Session):
    session.add(_batch("b1", environment="staging"))
    session.add(_batch("b2", environment="prod"))
    session.commit()

    ids, _, _ = _query_batches(
        session, BatchRunListFilters(search="stag")
    )
    assert ids == ["b1"]


def test_batch_list_since_filter(session: Session):
    session.add(_batch("recent", created_at=_NOW - timedelta(hours=2)))
    session.add(_batch("old", created_at=_NOW - timedelta(days=9)))
    session.commit()

    ids, _, _ = _query_batches(session, BatchRunListFilters(since="7d"))
    assert ids == ["recent"]


def test_batch_list_since_accepts_any_hour_or_day_window(session: Session):
    """Every ``Nh``/``Nd`` window filters — not just the four the old
    preset table listed. The Tasks page offers windows like ``5d``, and a
    window it carries into this listing must narrow it rather than silently
    read as all-time."""
    session.add(_batch("recent", created_at=_NOW - timedelta(days=3)))
    session.add(_batch("old", created_at=_NOW - timedelta(days=8)))
    session.commit()

    ids, _, _ = _query_batches(session, BatchRunListFilters(since="5d"))
    assert ids == ["recent"]


def test_batch_list_since_unparseable_means_all_time(session: Session):
    session.add(_batch("b1", created_at=_NOW - timedelta(days=400)))
    session.commit()

    ids, _, _ = _query_batches(session, BatchRunListFilters(since="nonsense"))
    assert ids == ["b1"]


# ---------------------------------------------------------------------------
# Batch listing: model facets
# ---------------------------------------------------------------------------


def test_batch_list_model_facets(session: Session):
    session.add(_batch("b1"))
    session.add(_batch("b2"))
    session.add(_task_run("tr1", "b1", model="claude-sonnet", effort="high"))
    session.add(_task_run("tr2", "b2", model="claude-sonnet", effort="low"))
    session.add(_task_run("tr3", "b2", model="gpt-4o"))
    session.commit()

    _, _, models = _query_batches(session)
    assert "claude-sonnet" in models
    assert "gpt-4o" in models


def test_batch_list_model_facets_exclude_null_model(session: Session):
    session.add(_batch("b1"))
    session.add(_task_run("tr1", "b1", model=None))
    session.commit()

    _, _, models = _query_batches(session)
    assert models == []


# ---------------------------------------------------------------------------
# Batch listing: config filter (model/effort)
# ---------------------------------------------------------------------------


def test_batch_list_config_filter_by_model(session: Session):
    session.add(_batch("b1"))
    session.add(_batch("b2"))
    session.add(_task_run("tr1", "b1", model="claude-sonnet"))
    session.add(_task_run("tr2", "b2", model="gpt-4o"))
    session.commit()

    ids, _, _ = _query_batches(
        session, BatchRunListFilters(models=["gpt-4o"])
    )
    assert ids == ["b2"]


def test_batch_list_config_filter_and_semantics(session: Session):
    """A batch matches only when ONE child run satisfies ALL dimensions."""
    session.add(_batch("b1"))
    session.add(_task_run("tr1", "b1", model="claude", effort="high"))
    session.add(_task_run("tr2", "b1", model="gpt-4o", effort="low"))
    session.commit()

    # model=claude AND effort=low: no single run matches both
    ids, _, _ = _query_batches(
        session, BatchRunListFilters(models=["claude"], efforts=["low"])
    )
    assert ids == []

    # model=gpt-4o AND effort=low: tr2 matches
    ids, _, _ = _query_batches(
        session, BatchRunListFilters(models=["gpt-4o"], efforts=["low"])
    )
    assert ids == ["b1"]


# ---------------------------------------------------------------------------
# Batch listing: pagination
# ---------------------------------------------------------------------------


def test_batch_list_pagination(session: Session):
    for i in range(5):
        session.add(_batch(f"b{i}", created_at=_NOW - timedelta(minutes=4 - i)))
    session.commit()

    page1 = list_batch_run_summaries(
        session,
        BatchRunListFilters(),
        BatchRunListPagination(page=0, page_size=2),
    )
    page2 = list_batch_run_summaries(
        session,
        BatchRunListFilters(),
        BatchRunListPagination(page=1, page_size=2),
    )

    assert len(page1.data) == 2
    assert page1.total_pages == 3
    assert [b.id for b in page1.data] == ["b4", "b3"]
    assert [b.id for b in page2.data] == ["b2", "b1"]


# ---------------------------------------------------------------------------
# Batch listing: hydration (cost/tokens)
# ---------------------------------------------------------------------------


def test_batch_list_hydrates_cost_and_tokens(session: Session):
    session.add(_batch("b1"))
    session.add(_task_run("tr1", "b1", cost=1.50, tokens=500))
    session.add(_task_run("tr2", "b1", cost=2.00, tokens=300))
    session.commit()

    page = list_batch_run_summaries(
        session,
        BatchRunListFilters(),
        BatchRunListPagination(page=0, page_size=50),
    )
    assert len(page.data) == 1
    # cost and tokens are accumulated across child runs
    assert page.data[0].total_cost == 3.5
    assert page.data[0].total_tokens == 800


def test_batch_list_hydrates_unpriced_call_count(session: Session):
    # Issue #147: a partially-priced batch must be distinguishable from a
    # fully priced one in the list, or its partial total reads as a real
    # (implausibly cheap) cost.
    session.add(_batch("b-priced"))
    session.add(_task_run("tr-ok", "b-priced", cost=1.0))
    session.add(_batch("b-partial"))
    session.add(_task_run("tr-p1", "b-partial", cost=0.5, unpriced=3))
    session.add(_task_run("tr-p2", "b-partial", cost=0.25, unpriced=2))
    session.commit()

    page = list_batch_run_summaries(
        session,
        BatchRunListFilters(),
        BatchRunListPagination(page=0, page_size=50),
    )
    by_id = {b.id: b for b in page.data}
    assert by_id["b-priced"].unpriced_call_count == 0
    assert by_id["b-partial"].unpriced_call_count == 5


# ---------------------------------------------------------------------------
# Bulk export
# ---------------------------------------------------------------------------


def _seed_exportable_run(session: Session, run_id: str = "r1") -> None:
    now = datetime.now(timezone.utc)
    session.add(
        RunDB(id=run_id, project="p", task_id="t", created_at=now, call_count=1)
    )
    session.add(
        LoggedCallDB(
            id="c1",
            project="p",
            model="m",
            task_id="t",
            run_id=run_id,
            created_at=now,
            input={},
            messages=[],
            output={},
        )
    )
    session.commit()


def test_collect_runs_for_export_serializes_run_metrics_calls(session: Session):
    now = datetime.now(timezone.utc)
    session.add(
        RunDB(id="r1", project="p", task_id="t", created_at=now, call_count=1)
    )
    session.add(
        RunMetricDB(
            run_id="r1",
            project="p",
            metric_name="acc",
            score=0.9,
            metric_type="quality",
            data_type="NUMERIC",
        )
    )
    session.add(
        LoggedCallDB(
            id="c1",
            project="p",
            model="m",
            task_id="t",
            run_id="r1",
            created_at=now,
            input={},
            messages=[],
            output={},
        )
    )
    session.commit()

    data = collect_runs_for_export(session, ["r1"], "p")
    assert len(data) == 1
    assert data[0]["run"]["id"] == "r1"  # pyright: ignore[reportIndexIssue]
    assert len(data[0]["metrics"]) == 1  # pyright: ignore[reportArgumentType]
    assert len(data[0]["calls"]) == 1  # pyright: ignore[reportArgumentType]


def test_collect_runs_for_export_skips_unknown_ids(session: Session):
    session.add(RunDB(id="r1", project="p", task_id="t", created_at=_NOW, call_count=0))
    session.commit()

    data = collect_runs_for_export(session, ["r1", "nonexistent"], "p")
    assert len(data) == 1
    assert data[0]["run"]["id"] == "r1"  # pyright: ignore[reportIndexIssue]


def test_collect_runs_for_export_respects_project_scope(session: Session):
    session.add(RunDB(id="r1", project="proj-a", task_id="t", created_at=_NOW, call_count=0))
    session.add(RunDB(id="r2", project="proj-b", task_id="t", created_at=_NOW, call_count=0))
    session.commit()

    data = collect_runs_for_export(session, ["r1", "r2"], "proj-a")
    assert len(data) == 1
    assert data[0]["run"]["id"] == "r1"  # pyright: ignore[reportIndexIssue]


# ---------------------------------------------------------------------------
# Bulk export route (scene): bounded request, raw download responses
# ---------------------------------------------------------------------------


class TestBulkExportRoute:
    def test_rejects_more_than_max_run_ids(self, client):
        resp = client.post(
            "/v1/runs/bulk-export",
            params={"project": "p"},
            json={"run_ids": [f"r{i}" for i in range(201)], "format": "json"},
        )
        assert resp.status_code == 422

    def test_rejects_empty_run_ids(self, client):
        resp = client.post(
            "/v1/runs/bulk-export",
            params={"project": "p"},
            json={"run_ids": [], "format": "json"},
        )
        assert resp.status_code == 422

    def test_json_export_streams_raw_download(self, session: Session, client):
        import json as jsonlib

        _seed_exportable_run(session)
        resp = client.post(
            "/v1/runs/bulk-export",
            params={"project": "p"},
            json={"run_ids": ["r1"], "format": "json"},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/json")
        assert "runs_export_1_runs.json" in resp.headers["content-disposition"]
        data = jsonlib.loads(resp.content)
        assert data[0]["run"]["id"] == "r1"
        assert len(data[0]["calls"]) == 1

    def test_json_export_fails_past_byte_budget(
        self, session: Session, client, monkeypatch: pytest.MonkeyPatch
    ):
        import apo.routes.runs.bulk_export as bulk_export_module

        monkeypatch.setattr(bulk_export_module, "MAX_EXPORT_BYTES", 8)
        _seed_exportable_run(session)
        resp = client.post(
            "/v1/runs/bulk-export",
            params={"project": "p"},
            json={"run_ids": ["r1"], "format": "json"},
        )
        assert resp.status_code == 413
        assert "budget" in resp.json()["detail"]

    def test_csv_export_streams_raw_download(self, session: Session, client):
        _seed_exportable_run(session)
        resp = client.post(
            "/v1/runs/bulk-export",
            params={"project": "p"},
            json={"run_ids": ["r1"], "format": "csv"},
        )
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("text/csv")
        assert "runs_export_1_runs.csv" in resp.headers["content-disposition"]
        assert resp.text.startswith("Run ID,")


if __name__ == "__main__":
    import sys

    sys.exit(pytest.main(["-v", __file__]))
