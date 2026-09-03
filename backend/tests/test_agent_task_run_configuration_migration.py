# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false, reportArgumentType=false, reportReturnType=false, reportCallIssue=false

"""Task Run Configuration schema migration (v15).

Mirrors the hand-rolled old-schema SQLite pattern in
``test_agent_task_deliverable_migration.py`` and ``test_cost_migration.py``:
build the OLD schema by hand, run the migration, assert the post-shape. The
migration must be idempotent, perform no backfill, and do no external I/O.
"""

from __future__ import annotations

from apo.db import LATEST_SCHEMA_VERSION, _migrate_run_configuration_schema
from sqlalchemy import text
from sqlmodel import create_engine


def test_latest_schema_version_bumped_to_v15() -> None:
    """The latest schema version is registered (v41).

    The test name preserves its v15 origin; the assertion is the guard that
    reminds the next schema bump to add migration coverage.
    """
    assert LATEST_SCHEMA_VERSION == 42


def test_migration_adds_configuration_columns_on_pre_v15_schema() -> None:
    """The v15 migration adds configured_model / configured_effort columns."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v15_tables(conn)

        _migrate_run_configuration_schema(conn)

        cols = _column_names(conn, "agent_task_runs")
        assert "configured_model" in cols
        assert "configured_effort" in cols


def test_migration_creates_composite_configuration_index() -> None:
    """The filtering/comparison index covers (model, effort, batch_run_id)."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v15_tables(conn)

        _migrate_run_configuration_schema(conn)

        assert _has_index_covering(
            conn, "agent_task_runs", ["configured_model", "configured_effort", "batch_run_id"]
        )


def test_migration_preserves_legacy_rows_without_backfill() -> None:
    """Pre-migration task runs stay readable; configuration columns are NULL."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v15_tables(conn)
        conn.execute(
            text(
                "INSERT INTO agent_task_runs "
                "(id, batch_run_id, task_id, task_path, status, adapter_name) "
                "VALUES ('run-1', 'batch-1', 't', 'p', 'completed', 'bind-chat')"
            )
        )

        _migrate_run_configuration_schema(conn)

        row = conn.execute(
            text(
                "SELECT id, adapter_name, configured_model, configured_effort "
                "FROM agent_task_runs WHERE id = 'run-1'"
            )
        ).one()
        assert row[0] == "run-1"
        assert row[1] == "bind-chat"
        assert row[2] is None
        assert row[3] is None


def test_migration_is_idempotent() -> None:
    """Re-running the migration on an already-migrated schema is a safe no-op."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v15_tables(conn)
        _migrate_run_configuration_schema(conn)

    with test_engine.begin() as conn:
        _migrate_run_configuration_schema(conn)
        assert "configured_model" in _column_names(conn, "agent_task_runs")
        assert "configured_effort" in _column_names(conn, "agent_task_runs")
        assert _has_index_covering(
            conn, "agent_task_runs", ["configured_model", "configured_effort", "batch_run_id"]
        )


def test_migration_adds_no_columns_to_batch_runs() -> None:
    """No Batch Run columns; configuration is owned by Task Runs only."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v15_tables(conn)

        _migrate_run_configuration_schema(conn)

        batch_cols = _column_names(conn, "agent_task_batch_runs")
        assert "configured_model" not in batch_cols
        assert "configured_effort" not in batch_cols
        assert "run_configuration" not in batch_cols


def test_fresh_create_all_has_configuration_columns() -> None:
    """SQLModel fresh create_all includes the new columns (model is the source)."""
    from sqlmodel import SQLModel

    import apo.models.db as models_db  # noqa: F401 - registers models

    assert models_db is not None

    fresh_engine = create_engine("sqlite://")
    with fresh_engine.begin() as conn:
        SQLModel.metadata.create_all(conn)
        fresh_cols = _column_names(conn, "agent_task_runs")

    assert "configured_model" in fresh_cols
    assert "configured_effort" in fresh_cols


# --- helpers (mirror test_agent_task_deliverable_migration.py) ----------------


def _create_pre_v15_tables(conn) -> None:
    conn.exec_driver_sql(
        """
        CREATE TABLE agent_task_batch_runs (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            selection_type VARCHAR NOT NULL,
            environment VARCHAR NOT NULL DEFAULT 'default',
            status VARCHAR NOT NULL,
            total_tasks INTEGER NOT NULL DEFAULT 0,
            passed_tasks INTEGER NOT NULL DEFAULT 0,
            failed_tasks INTEGER NOT NULL DEFAULT 0,
            errored_tasks INTEGER NOT NULL DEFAULT 0,
            total_checks INTEGER NOT NULL DEFAULT 0,
            passed_checks INTEGER NOT NULL DEFAULT 0,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.exec_driver_sql(
        """
        CREATE TABLE agent_task_runs (
            id VARCHAR PRIMARY KEY,
            batch_run_id VARCHAR NOT NULL,
            task_id VARCHAR NOT NULL,
            task_path VARCHAR NOT NULL,
            status VARCHAR NOT NULL,
            adapter_name VARCHAR,
            checks_json JSON,
            transcript_json JSON,
            deliverables_json JSON
        )
        """
    )


def _column_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return {str(r[1]) for r in rows}


def _index_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA index_list('{table_name}')").fetchall()
    return {str(r[1]) for r in rows}


def _has_index_covering(conn, table_name: str, columns: list[str]) -> bool:
    """True when any index on the table covers the given columns (in order)."""
    wanted = columns
    for name in _index_names(conn, table_name):
        cols = conn.exec_driver_sql(f"PRAGMA index_info('{name}')").fetchall()
        ordered = [str(c[2]) for c in sorted(cols, key=lambda row: row[0])]
        if ordered == wanted:
            return True
    return False
