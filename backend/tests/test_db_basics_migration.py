# pyright: reportAny=false, reportAttributeAccessIssue=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Schema v71: the hot-query indexes and the planner's first statistics.

An index declared on a model reaches a fresh database through
``create_all``, and an existing one only through a migration rung, because
``create_all`` skips a table that already exists. A model-only declaration
therefore looks done on every fresh test database while no deployed
database ever gets the index (``ix_batch_runs_project_created`` sat in that
state). These tests pin both paths to the same result.
"""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import inspect
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool
from sqlmodel import Session, SQLModel, create_engine

import apo.db as apo_db
from apo.models.db import AgentTaskBatchRunDB, LoggedCallDB, OtlpIngestBatchDB, RunDB

NOW = datetime(2026, 11, 1, tzinfo=timezone.utc)
V71_TABLES = sorted({table for _, table, _ in apo_db._V71_INDEXES})
COVERING_INDEX = "ix_logged_calls_run_project_route_provider"


@pytest.fixture(name="basics_engine")
def basics_engine_fixture(tmp_path: Path, monkeypatch: MonkeyPatch) -> Iterator[Engine]:
    """A file database configured like the app's, installed as ``apo.db.engine``."""
    url = f"sqlite:///{tmp_path / 'basics.db'}"
    engine = create_engine(url, connect_args={"check_same_thread": False}, poolclass=NullPool)
    apo_db.attach_sqlite_pragmas(engine)
    monkeypatch.setattr(apo_db, "DATABASE_URL", url)
    monkeypatch.setattr(apo_db, "engine", engine)
    yield engine
    engine.dispose()


def test_upgrade_creates_every_index(basics_engine: Engine) -> None:
    _v69_database(basics_engine)
    for name, table, _ in apo_db._V71_INDEXES:
        assert name not in _indexes(basics_engine, table)

    apo_db.init_db()

    assert _schema_version(basics_engine) == apo_db.LATEST_SCHEMA_VERSION
    for name, table, columns in apo_db._V71_INDEXES:
        assert _indexes(basics_engine, table).get(name) == columns, name


def test_models_declare_the_indexes_the_rung_creates() -> None:
    """``create_all`` builds a fresh database from the models alone, so an index
    the rung creates but no model declares would be missing from every test
    schema and from any table a later rung rebuilds."""
    for name, table, columns in apo_db._V71_INDEXES:
        declared = {
            str(index.name): tuple(column.name for column in index.columns)
            for index in SQLModel.metadata.tables[table].indexes
        }
        assert declared.get(name) == columns, name


def test_fresh_install_carries_each_index_once(basics_engine: Engine) -> None:
    """A fresh database runs ``create_all`` and then the rung. If the two ever
    disagree on a name, it ends up with the same index twice."""
    apo_db.init_db()

    for name, table, columns in apo_db._V71_INDEXES:
        same_shape = sorted(
            built
            for built, built_columns in _indexes(basics_engine, table).items()
            if built_columns == columns
        )
        assert same_shape == [name]


def test_rung_runs_twice_without_complaint(basics_engine: Engine) -> None:
    _v69_database(basics_engine)

    apo_db._migrate_to_v71()
    first = {table: _indexes(basics_engine, table) for table in V71_TABLES}
    apo_db._migrate_to_v71()

    assert {table: _indexes(basics_engine, table) for table in V71_TABLES} == first
    for name, table, columns in apo_db._V71_INDEXES:
        assert first[table].get(name) == columns, name


def test_first_boot_gives_the_planner_statistics(basics_engine: Engine) -> None:
    """Before v71 nothing ever ran ANALYZE, so ``sqlite_stat1`` did not exist
    and the planner costed every index by guesswork."""
    _v69_database(basics_engine)
    _seed_rows(basics_engine)
    assert _analyzed_indexes(basics_engine) == set()

    apo_db.init_db()

    analyzed = _analyzed_indexes(basics_engine)
    for name, _, _ in apo_db._V71_INDEXES:
        assert name in analyzed, name


def test_missing_column_skips_its_index_and_still_boots(
    basics_engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    """A stamp can run ahead of the schema it claims: stamped v69, yet
    ``logged_calls.route`` never arrived. The column repair runs only after
    the ladder, so the rung must step around the gap instead of failing the
    boot on an index that exists purely for speed."""
    _v69_database(basics_engine)
    with basics_engine.begin() as conn:
        conn.exec_driver_sql("ALTER TABLE logged_calls DROP COLUMN route")

    with caplog.at_level("WARNING", logger="apo.db"):
        apo_db.init_db()

    assert _schema_version(basics_engine) == apo_db.LATEST_SCHEMA_VERSION
    logged_calls = _indexes(basics_engine, "logged_calls")
    assert COVERING_INDEX not in logged_calls
    assert f"skipped index {COVERING_INDEX}" in caplog.text
    # Every index whose columns were all present still got built.
    for name, table, columns in apo_db._V71_INDEXES:
        if name != COVERING_INDEX:
            assert _indexes(basics_engine, table).get(name) == columns, name
    with basics_engine.connect() as conn:
        repaired = {column["name"] for column in inspect(conn).get_columns("logged_calls")}
    assert "route" in repaired


def _v69_database(engine: Engine) -> None:
    """A database as version 69 left it: today's tables, none of v71's indexes."""
    SQLModel.metadata.create_all(engine)
    with engine.begin() as conn:
        for name, _, _ in apo_db._V71_INDEXES:
            conn.exec_driver_sql(f'DROP INDEX "{name}"')
        conn.exec_driver_sql("CREATE TABLE schema_migrations (version INTEGER NOT NULL)")
        for version in range(1, 70):
            conn.exec_driver_sql(f"INSERT INTO schema_migrations (version) VALUES ({version})")


def _seed_rows(engine: Engine) -> None:
    """One row in each table the rung indexes: ANALYZE records nothing for an
    empty table."""
    with Session(engine) as session:
        session.add(
            RunDB(id="trace-1", project="p1", created_at=NOW, duration_ms=1200.0, call_count=2)
        )
        for call_id, level, model in (("c1", "DEFAULT", "m-a"), ("c2", "ERROR", "m-b")):
            session.add(
                LoggedCallDB(
                    id=call_id,
                    project="p1",
                    task_id="t",
                    run_id="trace-1",
                    model=model,
                    level=level,
                    provider="openai",
                    route="direct",
                    created_at=NOW,
                    input={},
                    messages=[],
                    output={},
                )
            )
        session.add(
            AgentTaskBatchRunDB(
                id="batch-1",
                project="p1",
                selection_type="task",
                status="completed",
                created_at=NOW,
            )
        )
        session.add(OtlpIngestBatchDB(id="ingest-1", project_id="p1", payload="{}", status="queued"))
        session.commit()


def _indexes(engine: Engine, table: str) -> dict[str, tuple[str, ...]]:
    """Index name to column order, for every index on ``table``."""
    with engine.connect() as conn:
        return {
            str(index["name"]): tuple(str(column) for column in index["column_names"])
            for index in inspect(conn).get_indexes(table)
        }


def _analyzed_indexes(engine: Engine) -> set[str]:
    """The indexes ``sqlite_stat1`` holds statistics for."""
    with engine.connect() as conn:
        if not inspect(conn).has_table("sqlite_stat1"):
            return set()
        rows = conn.exec_driver_sql("SELECT idx FROM sqlite_stat1 WHERE idx IS NOT NULL")
        return {str(row[0]) for row in rows}


def _schema_version(engine: Engine) -> int:
    with engine.connect() as conn:
        return int(conn.exec_driver_sql("SELECT MAX(version) FROM schema_migrations").scalar_one())
