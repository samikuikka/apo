# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Task Run status normalization migration (v30).

The dev-workspace seeder wrote the batch-level status ``completed`` onto Task
Run rows (status and trace_persistence_status). v30 maps drifted run statuses
by the recorded verdict and normalizes trace persistence to ``persisted``.
"""

from __future__ import annotations

from apo.db import LATEST_SCHEMA_VERSION, _normalize_run_and_trace_statuses
from sqlalchemy import text
from sqlmodel import create_engine


def test_latest_schema_version_bumped_to_v30() -> None:
    """v30 is registered — the guard that reminds the next bump to add coverage."""
    assert LATEST_SCHEMA_VERSION == 40


def test_migration_maps_drifted_completed_runs_by_verdict() -> None:
    """``completed`` runs become passed/failed per pass_result; traces persist."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_tables(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_runs (id, status, pass_result, trace_persistence_status) "
                "VALUES ('passed-run', 'completed', 1, 'completed'), "
                "       ('failed-run', 'completed', 0, 'completed')"
            )
        )

        _normalize_run_and_trace_statuses(conn)

        rows = conn.execute(
            text("SELECT id, status, trace_persistence_status FROM agent_task_runs ORDER BY id")
        ).all()
        assert rows[0] == ("failed-run", "failed", "persisted")
        assert rows[1] == ("passed-run", "passed", "persisted")


def test_migration_preserves_canonical_rows() -> None:
    """pending/running/error runs and pending traces are left untouched."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_tables(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_runs (id, status, pass_result, trace_persistence_status) "
                "VALUES ('queued', 'pending', NULL, 'pending'), "
                "       ('live', 'running', NULL, 'pending'), "
                "       ('crashed', 'error', NULL, 'failed')"
            )
        )

        _normalize_run_and_trace_statuses(conn)

        rows = conn.execute(text("SELECT id, status FROM agent_task_runs ORDER BY id")).all()
        assert rows == [("crashed", "error"), ("live", "running"), ("queued", "pending")]


def test_migration_normalizes_batch_trace_persistence() -> None:
    """Batch rows with drifted trace_persistence_status map to persisted."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_tables(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_batch_runs (id, trace_persistence_status) "
                "VALUES ('drifted', 'completed'), ('clean', 'pending')"
            )
        )

        _normalize_run_and_trace_statuses(conn)

        rows = conn.execute(
            text("SELECT id, trace_persistence_status FROM agent_task_batch_runs ORDER BY id")
        ).all()
        assert rows == [("clean", "pending"), ("drifted", "persisted")]


def test_migration_is_idempotent() -> None:
    """A second run rewrites nothing and changes no verdicts."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_tables(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_runs (id, status, pass_result, trace_persistence_status) "
                "VALUES ('passed-run', 'completed', 1, 'completed')"
            )
        )
        _normalize_run_and_trace_statuses(conn)
        _normalize_run_and_trace_statuses(conn)

        rows = conn.execute(
            text("SELECT status, trace_persistence_status FROM agent_task_runs")
        ).all()
        assert rows == [("passed", "persisted")]


def _create_tables(conn) -> None:
    conn.exec_driver_sql(
        """
        CREATE TABLE agent_task_runs (
            id VARCHAR PRIMARY KEY,
            status VARCHAR NOT NULL,
            pass_result BOOLEAN,
            trace_persistence_status VARCHAR NOT NULL DEFAULT 'pending'
        )
        """
    )
    conn.exec_driver_sql(
        """
        CREATE TABLE agent_task_batch_runs (
            id VARCHAR PRIMARY KEY,
            trace_persistence_status VARCHAR NOT NULL DEFAULT 'pending'
        )
        """
    )
