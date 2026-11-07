# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportMissingTypeArgument=false

"""Boot-time column reconcile: repair model columns a drifted stamp skipped past.

A schema_migrations stamp can run ahead of the DDL that earned it (WAL or
file-copy drift), and create_all never adds columns to existing tables, so
without the reconcile pass a drifted database dies on its first full-row
ORM load. These tests drive the reconcile worker on private engines and pin
the boot ordering init_db uses: create_all first, then reconcile.
"""

from __future__ import annotations

from pathlib import Path

from sqlalchemy import Engine
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

# Register the model tables exactly like init_db does (db + pricing), so
# create_all and the reconcile walk the same complete metadata.
import apo.models.db as _models_db  # noqa: F401  # pyright: ignore[reportUnusedImport]
import apo.models.pricing as _models_pricing  # noqa: F401  # pyright: ignore[reportUnusedImport]
from apo.db import _reconcile_model_columns_on
from apo.models.db import AgentTaskRunDB

# Every NOT NULL, no-default column of agent_task_runs: the raw-SQL insert
# used to seed a pre-repair row must satisfy them all.
_BARE_RUN_VALUES = (
    "'r1', 'b1', 't', '/t', 0, 'failed', 'pending', 0, 0, 0, 0, 0"
)
_BARE_RUN_COLUMNS = (
    "id, batch_run_id, task_id, task_path, sequence_index, status, "
    "trace_persistence_status, total_checks, passed_checks, failed_checks, "
    "unpriced_call_count, corrected_tests"
)


def _private_engine(tmp_path: Path) -> Engine:
    return create_engine(
        f"sqlite:///{tmp_path / 'reconcile.db'}",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )


def _column_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return {str(r[1]) for r in rows}


def _table_names(conn) -> set[str]:
    rows = conn.exec_driver_sql(
        "SELECT name FROM sqlite_master WHERE type='table'"
    ).fetchall()
    return {str(r[0]) for r in rows}


def _insert_bare_run(conn) -> None:
    conn.exec_driver_sql(
        f"INSERT INTO agent_task_runs ({_BARE_RUN_COLUMNS}) "
        f"VALUES ({_BARE_RUN_VALUES})"
    )


def test_missing_column_is_added_at_reconcile(tmp_path: Path) -> None:
    engine = _private_engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_runs DROP COLUMN errored_checks"
        )
        _insert_bare_run(conn)
        _reconcile_model_columns_on(conn)
        assert "errored_checks" in _column_names(conn, "agent_task_runs")

    with Session(engine) as session:
        runs = session.exec(select(AgentTaskRunDB)).all()
    assert [run.id for run in runs] == ["r1"]


def test_server_default_is_carried_into_repair(tmp_path: Path) -> None:
    engine = _private_engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_runs DROP COLUMN errored_checks"
        )
        _insert_bare_run(conn)
        _reconcile_model_columns_on(conn)
        value = conn.exec_driver_sql(
            "SELECT errored_checks FROM agent_task_runs LIMIT 1"
        ).scalar()
    assert value == 0


def test_healthy_schema_is_untouched(tmp_path: Path) -> None:
    """Every column present means zero ALTERs: the sets stay identical."""
    engine = _private_engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        before = {
            table.name: _column_names(conn, table.name)
            for table in SQLModel.metadata.sorted_tables
        }
        _reconcile_model_columns_on(conn)
        after = {
            table.name: _column_names(conn, table.name)
            for table in SQLModel.metadata.sorted_tables
        }
    assert after == before


def test_missing_table_is_left_to_create_all(tmp_path: Path) -> None:
    engine = _private_engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE agent_task_judgments")
        _reconcile_model_columns_on(conn)
        names = _table_names(conn)
    assert "agent_task_judgments" not in names


def test_multiple_missing_columns_across_tables(tmp_path: Path) -> None:
    engine = _private_engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_runs DROP COLUMN no_verdict_reason"
        )
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_judgments DROP COLUMN errored_checks"
        )
        _reconcile_model_columns_on(conn)
        assert "no_verdict_reason" in _column_names(conn, "agent_task_runs")
        assert "errored_checks" in _column_names(conn, "agent_task_judgments")


def test_init_db_repairs_drifted_database(tmp_path: Path) -> None:
    """The boot sequence is create_all, then reconcile: create_all alone
    cannot repair an existing table, the reconcile pass after it can."""
    engine = _private_engine(tmp_path)
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_runs DROP COLUMN errored_checks"
        )
        conn.exec_driver_sql(
            "ALTER TABLE agent_task_runs DROP COLUMN no_verdict_reason"
        )

    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        columns = _column_names(conn, "agent_task_runs")
        assert "errored_checks" not in columns
        assert "no_verdict_reason" not in columns
        _reconcile_model_columns_on(conn)
        columns = _column_names(conn, "agent_task_runs")

    assert {"errored_checks", "no_verdict_reason"} <= columns
