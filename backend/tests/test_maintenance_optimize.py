# pyright: reportAny=false, reportAttributeAccessIssue=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""The daily maintenance pass keeps the query planner's statistics fresh.

SQLite's planner statistics come from ANALYZE and nothing refreshes them on
its own. The engine hands every caller a brand-new connection (NullPool),
and a plain ``PRAGMA optimize`` only looks at tables its own connection
queried, so on the maintenance connection it would look at nothing. These
tests run the refresh the way production does, on fresh connections, and
read the statistics back through another one.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from sqlalchemy.engine import Connection, Engine
from sqlalchemy.pool import NullPool
from sqlmodel import Session, SQLModel, create_engine

import apo.db as apo_db
from apo.models.db import OtlpIngestBatchDB
from apo.services import retention

STALE_ROWS = 10
GROWN_ROWS = 5000


@pytest.fixture(name="stats_engine")
def stats_engine_fixture(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Engine]:
    """A file database on one-connection-per-use, installed as the pass's engine."""
    engine = create_engine(
        f"sqlite:///{tmp_path / 'stats.db'}",
        connect_args={"check_same_thread": False},
        poolclass=NullPool,
    )
    apo_db.attach_sqlite_pragmas(engine)
    monkeypatch.setattr(retention, "engine", engine)
    yield engine
    engine.dispose()


@pytest.fixture(name="refresh_path", params=["this-sqlite", "older-sqlite"])
def refresh_path_fixture(request: pytest.FixtureRequest, monkeypatch: pytest.MonkeyPatch) -> str:
    """Run a scenario on the path this SQLite takes, and again on the path a
    release before 3.46 takes. There the pragma cannot be told to consider
    every table, so the pass runs a bounded ANALYZE instead."""
    if request.param == "older-sqlite":
        monkeypatch.setattr(retention, "_optimize_considers_every_table", lambda: False)
    return str(request.param)


def test_an_index_without_statistics_gets_them(stats_engine: Engine, refresh_path: str) -> None:
    _items_table(stats_engine, rows=500)
    assert _row_estimate(stats_engine, "ix_items_kind") is None

    assert retention.optimize_sqlite() is True

    assert _row_estimate(stats_engine, "ix_items_kind") == 500


def test_a_table_that_outgrew_its_statistics_is_reanalyzed(
    stats_engine: Engine, refresh_path: str
) -> None:
    """The case a plain ``PRAGMA optimize`` misses on a fresh connection: every
    index already has statistics, they are just five hundred times too small."""
    _items_table(stats_engine, rows=STALE_ROWS)
    with stats_engine.begin() as conn:
        conn.exec_driver_sql("ANALYZE")
    _add_items(stats_engine, GROWN_ROWS - STALE_ROWS)
    assert _row_estimate(stats_engine, "ix_items_kind") == STALE_ROWS

    assert retention.optimize_sqlite() is True

    # A bounded ANALYZE estimates the row count, so the claim is the order of
    # magnitude, not the exact figure.
    refreshed = _row_estimate(stats_engine, "ix_items_kind")
    assert refreshed is not None and refreshed > STALE_ROWS * 10


def test_a_failed_refresh_is_reported_not_raised(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Stale statistics cost speed, not correctness: they must not fail the
    pass that also trims payloads and reaps tokens."""
    unreachable = create_engine(f"sqlite:///{tmp_path / 'no-such-dir' / 'gone.db'}")
    monkeypatch.setattr(retention, "engine", unreachable)

    with caplog.at_level("ERROR", logger="apo.services.retention"):
        assert retention.optimize_sqlite() is False

    assert "Planner statistics refresh failed" in caplog.text


def test_other_databases_are_left_alone(monkeypatch: pytest.MonkeyPatch) -> None:
    """PostgreSQL's autovacuum daemon keeps its own statistics current."""

    class ExplodingEngine:
        def connect(self) -> None:
            raise AssertionError("the refresh must not touch a non-SQLite database")

    monkeypatch.setattr(retention, "is_sqlite", lambda: False)
    monkeypatch.setattr(retention, "engine", ExplodingEngine())

    assert retention.optimize_sqlite() is False


def test_the_maintenance_pass_refreshes_statistics(
    stats_engine: Engine, refresh_path: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Wiring: the whole pass, on a database nothing ever analyzed."""
    monkeypatch.setenv("APO_ARTIFACT_DIR", str(tmp_path / "artifacts"))
    monkeypatch.setattr(retention, "RETENTION_DAYS", 0)
    SQLModel.metadata.create_all(stats_engine)
    with Session(stats_engine) as session:
        session.add(
            OtlpIngestBatchDB(id="ingest-1", project_id="p1", payload="{}", status="queued")
        )
        session.commit()
    assert _analyzed_tables(stats_engine) == set()

    summary = retention.run_maintenance_cleanup()

    assert summary["optimized"] == 1
    assert "otlp_ingest_batches" in _analyzed_tables(stats_engine)


def _items_table(engine: Engine, *, rows: int) -> None:
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE items (id INTEGER PRIMARY KEY, kind TEXT)")
        conn.exec_driver_sql("CREATE INDEX ix_items_kind ON items(kind)")
    _add_items(engine, rows)


def _add_items(engine: Engine, rows: int) -> None:
    with engine.begin() as conn:
        conn.exec_driver_sql(
            "INSERT INTO items (kind) VALUES (?)", [(f"kind-{n % 5}",) for n in range(rows)]
        )


def _row_estimate(engine: Engine, index: str) -> int | None:
    """The row count the planner believes ``index`` has, or None with no statistics."""
    with engine.connect() as conn:
        if not _has_statistics_table(conn):
            return None
        stat = conn.exec_driver_sql(
            "SELECT stat FROM sqlite_stat1 WHERE idx = ?", (index,)
        ).scalar()
    return int(str(stat).split()[0]) if stat is not None else None


def _analyzed_tables(engine: Engine) -> set[str]:
    with engine.connect() as conn:
        if not _has_statistics_table(conn):
            return set()
        return {str(row[0]) for row in conn.exec_driver_sql("SELECT DISTINCT tbl FROM sqlite_stat1")}


def _has_statistics_table(conn: Connection) -> bool:
    found = conn.exec_driver_sql(
        "SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_stat1'"
    ).scalar()
    return bool(found)
