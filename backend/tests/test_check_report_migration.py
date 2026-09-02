# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""v20 migration: move check evidence off the hot run row.

Builds a pre-v20 schema by hand, runs the migration, and asserts the post-shape:
scalar verdict columns populated, ``agent_task_check_reports`` created and
filled, legacy ``checks_json`` nulled — all in one atomic pass. Also covers
idempotency and the retention purge of report rows.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from apo.db import LATEST_SCHEMA_VERSION, _SCHEMA_MIGRATIONS, _migrate_check_report_schema
from apo.models.db import AgentTaskBatchRunDB, AgentTaskCheckReportDB, AgentTaskRunDB
from apo.services.retention import _delete_old_batch_runs


def _create_pre_v20_runs(conn) -> None:
    conn.exec_driver_sql(
        """
        CREATE TABLE agent_task_runs (
            id TEXT PRIMARY KEY,
            batch_run_id TEXT NOT NULL,
            task_id TEXT NOT NULL,
            task_path TEXT NOT NULL,
            status TEXT NOT NULL,
            checks_json JSON
        )
        """
    )


def _table_names(conn) -> set[str]:
    rows = conn.exec_driver_sql(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    return {str(r[0]) for r in rows}


def _column_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return {str(r[1]) for r in rows}


def _run_counts(conn, run_id: str):
    return conn.execute(
        text(
            "SELECT total_checks, passed_checks, failed_checks, checks_json "
            "FROM agent_task_runs WHERE id = :id"
        ),
        {"id": run_id},
    ).one()


def _report_value(conn, run_id: str):
    row = conn.execute(
        text("SELECT value_json FROM agent_task_check_reports WHERE run_id = :id"),
        {"id": run_id},
    ).one_or_none()
    if row is None:
        return None
    raw = row[0]
    return json.loads(raw) if isinstance(raw, str) else raw


def test_v20_remains_registered() -> None:
    assert 20 in _SCHEMA_MIGRATIONS
    assert LATEST_SCHEMA_VERSION == 39


def test_migration_backfills_counts_and_evidence_and_nulls_legacy() -> None:
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        _create_pre_v20_runs(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_runs "
                "(id, batch_run_id, task_id, task_path, status, checks_json) VALUES "
                "('r1','b','t','/t','failed', :c1), "
                "('r2','b','t','/t','passed', :c2), "
                "('r3','b','t','/t','error', NULL)"
            ),
            {
                "c1": json.dumps(
                    [{"id": "a", "pass": True}, {"id": "b", "pass": False}]
                ),
                "c2": json.dumps([{"id": "c", "pass": True}]),
            },
        )

        _migrate_check_report_schema(conn)

        # Columns + table present.
        cols = _column_names(conn, "agent_task_runs")
        assert {"total_checks", "passed_checks", "failed_checks"} <= cols
        assert "agent_task_check_reports" in _table_names(conn)

        # r1: 2 checks, 1 passed, legacy column nulled, evidence copied whole.
        total, passed, failed, legacy = _run_counts(conn, "r1")
        assert (total, passed, failed) == (2, 1, 1)
        assert legacy is None
        assert _report_value(conn, "r1") == [
            {"id": "a", "pass": True},
            {"id": "b", "pass": False},
        ]

        # r2: 1 check, 1 passed.
        total, passed, failed, _ = _run_counts(conn, "r2")
        assert (total, passed, failed) == (1, 1, 0)
        assert _report_value(conn, "r2") == [{"id": "c", "pass": True}]

        # r3: no checks_json → skipped, stays 0, no report row.
        total, passed, failed, _ = _run_counts(conn, "r3")
        assert (total, passed, failed) == (0, 0, 0)
        assert _report_value(conn, "r3") is None


def test_migration_keeps_full_reasoning_no_total_cap() -> None:
    """A many-check payload that would have blown the retired 1 MiB cap is
    migrated whole — reasoning survives."""
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        _create_pre_v20_runs(conn)
        checks = [
            {"id": f"c-{i}", "pass": i % 2 == 0, "reasoning": "x" * (64 * 1024)}
            for i in range(80)
        ]
        conn.execute(
            text(
                "INSERT INTO agent_task_runs "
                "(id, batch_run_id, task_id, task_path, status, checks_json) "
                "VALUES ('r1','b','t','/t','failed', :c)"
            ),
            {"c": json.dumps(checks)},
        )

        _migrate_check_report_schema(conn)

        total, passed, _, legacy = _run_counts(conn, "r1")
        assert total == 80
        assert passed == 40
        assert legacy is None
        body = _report_value(conn, "r1")
        assert body is not None
        assert len(body) == 80
        assert all(entry["reasoning"] == "x" * (64 * 1024) for entry in body)


def test_migration_is_idempotent() -> None:
    engine = create_engine("sqlite://")
    with engine.begin() as conn:
        _create_pre_v20_runs(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_runs "
                "(id, batch_run_id, task_id, task_path, status, checks_json) "
                "VALUES ('r1','b','t','/t','failed', :c)"
            ),
            {"c": json.dumps([{"id": "a", "pass": True}])},
        )
        _migrate_check_report_schema(conn)

    # Re-run on the already-migrated schema: no duplicate report rows, no change.
    with engine.begin() as conn:
        _migrate_check_report_schema(conn)
        total, passed, failed, legacy = _run_counts(conn, "r1")
        assert (total, passed, failed) == (1, 1, 0)
        assert legacy is None
        n = conn.exec_driver_sql(
            "SELECT COUNT(*) FROM agent_task_check_reports WHERE run_id = 'r1'"
        ).scalar()
        assert n == 1


def test_migration_is_a_noop_on_fresh_schema() -> None:
    """create_all already made the columns + table; the migration backfills
    zero rows and changes nothing."""
    engine = create_engine("sqlite://")
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        _migrate_check_report_schema(conn)
        assert "agent_task_check_reports" in _table_names(conn)
        n = conn.exec_driver_sql(
            "SELECT COUNT(*) FROM agent_task_check_reports"
        ).scalar()
        assert n == 0


# ── retention purge ─────────────────────────────────────────────────────────


@pytest.fixture
def session() -> Iterator[Session]:
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        yield s


def test_retention_purge_removes_check_reports(session: Session) -> None:
    old = datetime.now(timezone.utc) - timedelta(days=30)
    now = datetime.now(timezone.utc)

    session.add(
        AgentTaskBatchRunDB(
            id="batch-old",
            project="p",
            selection_type="all",
            status="completed",
            created_at=old,
        )
    )
    session.add(
        AgentTaskRunDB(
            id="run-old",
            batch_run_id="batch-old",
            task_id="t",
            task_path="/t",
            status="failed",
        )
    )
    session.commit()
    session.add(
        AgentTaskCheckReportDB(
            run_id="run-old",
            value_json=[{"id": "a", "pass": False}],
            created_at=old,
        )
    )
    session.commit()

    deleted = _delete_old_batch_runs(session, now)

    assert deleted >= 1
    # The run row is gone...
    assert session.get(AgentTaskRunDB, "run-old") is None
    # ...and so is its check report (no FK violation, no orphan).
    assert session.get(AgentTaskCheckReportDB, "run-old") is None
