# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false

"""Version 21 migration for immutable Task Definition Revisions."""

from __future__ import annotations

from apo.db import (
    LATEST_SCHEMA_VERSION,
    _SCHEMA_MIGRATIONS,
    _migrate_task_definition_revisions,
)
from sqlalchemy import inspect, text
from sqlmodel import create_engine


def test_latest_schema_version_is_v21() -> None:
    assert LATEST_SCHEMA_VERSION == 41
    assert _SCHEMA_MIGRATIONS[21].__name__ == "_migrate_to_v21"


def test_v21_migrates_an_existing_installation() -> None:
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v21_tables(conn)
        conn.execute(
            text(
                "INSERT INTO project_task_sources (id, project) "
                "VALUES ('source-1', 'project-1')"
            )
        )

        _migrate_task_definition_revisions(conn)

        tables = set(inspect(conn).get_table_names())
        assert "task_definition_revisions" in tables
        assert "task_definition_revision_id" in _column_names(conn, "agent_task_runs")
        assert "task_definition_revision_id" in _column_names(
            conn, "project_task_inventory"
        )
        assert "catalog_schema_version" in _column_names(
            conn, "project_task_sources"
        )
        schema_version = conn.execute(
            text(
                "SELECT catalog_schema_version FROM project_task_sources "
                "WHERE id = 'source-1'"
            )
        ).scalar_one()
        assert schema_version == 1


def test_v21_migration_is_idempotent() -> None:
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v21_tables(conn)
        _migrate_task_definition_revisions(conn)
        _migrate_task_definition_revisions(conn)

        assert "task_definition_revisions" in inspect(conn).get_table_names()
        assert "catalog_schema_version" in _column_names(
            conn, "project_task_sources"
        )


def _create_pre_v21_tables(conn) -> None:
    conn.exec_driver_sql(
        "CREATE TABLE agent_task_runs (id VARCHAR PRIMARY KEY)"
    )
    conn.exec_driver_sql(
        "CREATE TABLE project_task_inventory (id VARCHAR PRIMARY KEY)"
    )
    conn.exec_driver_sql(
        "CREATE TABLE project_task_sources ("
        "id VARCHAR PRIMARY KEY, project VARCHAR NOT NULL)"
    )


def _column_names(conn, table_name: str) -> set[str]:
    return {column["name"] for column in inspect(conn).get_columns(table_name)}
