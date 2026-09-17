# pyright: reportAny=false, reportImplicitStringConcatenation=false, reportPrivateUsage=false, reportUnusedCallResult=false

"""Version 46 migration for Generation Usage Summaries (issue #309)."""

from __future__ import annotations

from sqlalchemy import inspect, text
from sqlmodel import create_engine

from apo.db import (
    LATEST_SCHEMA_VERSION,
    _SCHEMA_MIGRATIONS,
    _migrate_generation_usage_schema,
)


def test_v46_is_registered() -> None:
    assert LATEST_SCHEMA_VERSION == 47
    assert _SCHEMA_MIGRATIONS[46].__name__ == "_migrate_to_v46"


def test_v46_adds_nullable_summary_leaving_existing_runs_unknown() -> None:
    engine = create_engine("sqlite://")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE agent_task_runs (id VARCHAR PRIMARY KEY)"
        )
        connection.execute(
            text("INSERT INTO agent_task_runs (id) VALUES ('existing-run')")
        )

        _migrate_generation_usage_schema(connection)
        _migrate_generation_usage_schema(connection)

        columns = {
            column["name"]
            for column in inspect(connection).get_columns("agent_task_runs")
        }
        assert "generation_usage_json" in columns
        value = connection.execute(
            text(
                "SELECT generation_usage_json FROM agent_task_runs "
                "WHERE id = 'existing-run'"
            )
        ).scalar_one()
        assert value is None
