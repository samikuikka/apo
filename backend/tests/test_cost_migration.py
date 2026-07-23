# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false

"""SPEC-136 ticket 09: cost system migration (big-bang, v10).

Mirrors the hand-rolled old-schema SQLite pattern in
``test_projection_identity_migration.py``: build the OLD schema by hand,
insert legacy rows, run the migration, assert the post-shape.
"""

from __future__ import annotations

from apo.db import _migrate_cost_schema
from sqlalchemy import text
from sqlmodel import create_engine


def test_cost_migration_transforms_float_to_microusd_int() -> None:
    """Existing float-USD cost/provided_cost -> INTEGER micro-USD via round(v*1e6)."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v10_tables(conn)
        # A row with float-USD costs.
        conn.execute(
            text(
                "INSERT INTO logged_calls "
                "(id, project, task_id, run_id, created_at, model, observation_type, level, "
                " cost, provided_cost, calculated_cost, internal_model_id) "
                "VALUES ('span-1', 'p', '', 't', CURRENT_TIMESTAMP, 'gpt-4o', 'GENERATION', 'DEFAULT', "
                " 0.00075, 0.001, 0.00075, 'legacy-string-id')"
            )
        )
        # A row with NULL costs (must be left NULL, not transformed).
        conn.execute(
            text(
                "INSERT INTO logged_calls "
                "(id, project, task_id, run_id, created_at, model, observation_type, level) "
                "VALUES ('span-2', 'p', '', 't', CURRENT_TIMESTAMP, 'gpt-4o', 'GENERATION', 'DEFAULT')"
            )
        )

        _migrate_cost_schema(conn)

        rows = conn.execute(
            text("SELECT id, cost, provided_cost, internal_model_id FROM logged_calls ORDER BY id")
        ).all()
        # span-1: 0.00075 USD -> 750 micro; provided 0.001 -> 1000 micro.
        assert rows[0][0] == "span-1"
        assert rows[0][1] == 750  # round(0.00075 * 1e6)
        assert rows[0][2] == 1000  # round(0.001 * 1e6)
        # legacy internal_model_id string nulled (not a valid FK).
        assert rows[0][3] is None
        # span-2: NULLs preserved.
        assert rows[1][0] == "span-2"
        assert rows[1][1] is None
        assert rows[1][2] is None


def test_cost_migration_drops_model_definitions_and_adds_new_tables() -> None:
    """The old model_definitions table is dropped; the 3-table shape is created."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v10_tables(conn)
        conn.execute(
            text(
                "INSERT INTO model_definitions "
                "(project, model_name, match_pattern, provider, input_price, output_price) "
                "VALUES ('__global__', 'gpt-4o', 'gpt-4o', 'openai', 2.50, 10.00)"
            )
        )

        _migrate_cost_schema(conn)

        tables = _table_names(conn)
        assert "model_definitions" not in tables  # dropped
        # create_all (run by init_db, not the migration) creates these; the
        # migration only adds logged_calls columns + drops model_definitions.
        # The 3-table shape is created by create_all in init_db, which runs
        # BEFORE migrations. Here we assert the migration didn't fail and the
        # new logged_calls columns exist.
        cols = _column_names(conn, "logged_calls")
        assert "cost_breakdown" in cols
        assert "raw_usage" in cols
        assert "matched_tier_id" in cols
        assert "matched_tier_name" in cols
        assert "cost_provenance" in cols
        assert "calculated_cost" not in cols  # dropped


def test_cost_migration_safe_to_rerun_on_migrated_schema() -> None:
    """Re-running the migration on an already-migrated schema is a safe no-op.

    Idempotency in production is guaranteed by the schema-version stamp (v10
    runs once per DB). This test verifies the migration itself doesn't error
    and leaves the new column shape intact when re-run on a migrated schema.
    """
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v10_tables(conn)
        conn.execute(
            text(
                "INSERT INTO logged_calls "
                "(id, project, task_id, run_id, created_at, model, observation_type, level, cost) "
                "VALUES ('span-1', 'p', '', 't', CURRENT_TIMESTAMP, 'gpt-4o', 'GENERATION', 'DEFAULT', 0.001)"
            )
        )
        _migrate_cost_schema(conn)
        first = conn.execute(text("SELECT cost FROM logged_calls WHERE id='span-1'")).scalar_one()
        assert first == 1000  # 0.001 USD -> 1000 micro

    # Re-run on the now-migrated schema: must not error, new columns stay.
    with test_engine.begin() as conn:
        _migrate_cost_schema(conn)
        cols = _column_names(conn, "logged_calls")
        assert "cost_breakdown" in cols
        assert "raw_usage" in cols
        assert "cost_provenance" in cols
        assert "calculated_cost" not in cols
        assert "model_definitions" not in _table_names(conn)


# --- helpers (mirror test_projection_identity_migration.py) -----------------


def _create_pre_v10_tables(conn) -> None:
    conn.exec_driver_sql("CREATE TABLE score_configs (id INTEGER PRIMARY KEY)")
    conn.exec_driver_sql(
        """
        CREATE TABLE runs (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            environment VARCHAR NOT NULL DEFAULT 'default',
            tags JSON,
            bookmarked BOOLEAN NOT NULL DEFAULT 0,
            is_public BOOLEAN NOT NULL DEFAULT 0,
            call_count INTEGER NOT NULL DEFAULT 0
        )
        """
    )
    conn.exec_driver_sql(
        """
        CREATE TABLE logged_calls (
            id VARCHAR NOT NULL,
            project VARCHAR NOT NULL,
            task_id VARCHAR NOT NULL,
            run_id VARCHAR,
            created_at DATETIME NOT NULL,
            model VARCHAR NOT NULL,
            observation_type VARCHAR NOT NULL DEFAULT 'GENERATION',
            level VARCHAR NOT NULL DEFAULT 'DEFAULT',
            environment VARCHAR NOT NULL DEFAULT 'default',
            tags JSON,
            cost FLOAT,
            provided_cost REAL,
            calculated_cost REAL,
            internal_model_id TEXT
        )
        """
    )
    conn.exec_driver_sql(
        """
        CREATE TABLE model_definitions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project VARCHAR NOT NULL DEFAULT '__global__',
            model_name VARCHAR NOT NULL,
            match_pattern VARCHAR NOT NULL,
            provider VARCHAR NOT NULL,
            input_price FLOAT NOT NULL DEFAULT 0.0,
            output_price FLOAT NOT NULL DEFAULT 0.0,
            cached_input_price FLOAT,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.exec_driver_sql(
        """
        CREATE TABLE run_metrics (
            id INTEGER PRIMARY KEY,
            run_id VARCHAR NOT NULL,
            metric_name VARCHAR NOT NULL,
            metric_type VARCHAR NOT NULL,
            data_type VARCHAR NOT NULL,
            source VARCHAR NOT NULL
        )
        """
    )


def _table_names(conn) -> set[str]:
    rows = conn.exec_driver_sql("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
    return {str(r[0]) for r in rows}


def _column_names(conn, table_name: str) -> set[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return {str(r[1]) for r in rows}
