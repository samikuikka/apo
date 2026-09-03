# pyright: reportAny=false, reportDeprecated=false, reportImplicitStringConcatenation=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Upgrade from a v39 database splits the paired preview source per slot."""

from __future__ import annotations

from sqlalchemy import create_engine, inspect, text


def test_v40_splits_preview_source_per_slot_and_drops_paired_column(
    monkeypatch,
) -> None:
    from apo.db import LATEST_SCHEMA_VERSION, _run_migrations
    from sqlmodel import SQLModel

    assert LATEST_SCHEMA_VERSION >= 40

    test_engine = create_engine("sqlite://")
    monkeypatch.setattr("apo.db.engine", test_engine)
    SQLModel.metadata.create_all(test_engine)

    with test_engine.begin() as conn:
        # Shape a v39 runs table: the paired source column present, the
        # per-slot ones absent (create_all built them from the new model).
        conn.exec_driver_sql("ALTER TABLE runs ADD COLUMN preview_call_row_id INTEGER")
        conn.exec_driver_sql("ALTER TABLE runs DROP COLUMN input_preview_call_row_id")
        conn.exec_driver_sql("ALTER TABLE runs DROP COLUMN output_preview_call_row_id")
        # Stamp as v39: only v40 and newer must apply.
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)"
        )
        for v in range(1, 40):
            conn.execute(text("INSERT INTO schema_migrations VALUES (:v)"), {"v": v})
        conn.exec_driver_sql(
            "INSERT INTO runs (id, project, environment, created_at, "
            "call_count, bookmarked, is_public, input_preview, "
            "output_preview, preview_call_row_id) "
            "VALUES ('r1', 'p1', 'default', '2026-01-01 00:00:00', 0, 0, "
            "0, 'in', 'out', 7)"
        )

    _run_migrations()

    columns = {c["name"] for c in inspect(test_engine).get_columns("runs")}
    assert "preview_call_row_id" not in columns
    assert "input_preview_call_row_id" in columns
    assert "output_preview_call_row_id" in columns
    # Stored previews survive the rewrite untouched.
    with test_engine.begin() as conn:
        row = conn.execute(
            text("SELECT input_preview, output_preview FROM runs WHERE id = 'r1'")
        ).one()
    assert row == ("in", "out")


def test_v40_is_noop_on_fresh_databases(monkeypatch) -> None:
    """create_all already builds the per-slot columns; v40's guarded ALTERs
    (and the v35 add of the paired column it then drops) must not fail."""
    from apo.db import LATEST_SCHEMA_VERSION, _run_migrations
    from sqlmodel import SQLModel

    assert LATEST_SCHEMA_VERSION >= 40

    test_engine = create_engine("sqlite://")
    monkeypatch.setattr("apo.db.engine", test_engine)
    SQLModel.metadata.create_all(test_engine)

    _run_migrations()

    columns = {c["name"] for c in inspect(test_engine).get_columns("runs")}
    assert "preview_call_row_id" not in columns
    assert "input_preview_call_row_id" in columns
    assert "output_preview_call_row_id" in columns
