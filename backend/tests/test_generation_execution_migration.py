# pyright: reportAny=false, reportImplicitStringConcatenation=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Version 29 migration for Generation Execution Summaries."""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlmodel import create_engine

from apo.db import (
    LATEST_SCHEMA_VERSION,
    _SCHEMA_MIGRATIONS,
    _migrate_generation_execution_schema,
)


def test_v29_is_registered() -> None:
    assert LATEST_SCHEMA_VERSION == 40
    assert _SCHEMA_MIGRATIONS[29].__name__ == "_migrate_to_v29"


def test_v29_adds_nullable_summary_without_inventing_legacy_evidence() -> None:
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE agent_task_runs (id VARCHAR PRIMARY KEY)"
        )
        connection.execute(
            text("INSERT INTO agent_task_runs (id) VALUES ('legacy-run')")
        )

        _migrate_generation_execution_schema(connection)
        _migrate_generation_execution_schema(connection)

        columns = {
            column["name"]
            for column in inspect(connection).get_columns("agent_task_runs")
        }
        assert "generation_execution_json" in columns
        value = connection.execute(
            text(
                "SELECT generation_execution_json FROM agent_task_runs "
                "WHERE id = 'legacy-run'"
            )
        ).scalar_one()
        assert value is None
