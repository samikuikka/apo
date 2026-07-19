# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false

"""Existing v7 databases migrate to Project-scoped projection identities."""

from sqlalchemy import create_engine, text

from apo.db import _migrate_projection_identity_sqlite


def test_sqlite_projection_identity_migration_preserves_existing_rows() -> None:
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=ON")
        _create_v7_projection_tables(conn)
        conn.execute(text(
            "INSERT INTO runs "
            "(id, project, environment, tags, bookmarked, is_public, call_count) "
            "VALUES ('trace-1', 'project-a', 'default', '[]', 0, 0, 1)"
        ))
        conn.execute(text(
            "INSERT INTO logged_calls "
            "(id, project, task_id, run_id, created_at, model, observation_type, level, environment, tags) "
            "VALUES ('span-1', 'project-a', '', 'trace-1', CURRENT_TIMESTAMP, '', 'SPAN', 'DEFAULT', 'default', '[]')"
        ))
        conn.execute(text(
            "INSERT INTO run_metrics (run_id, metric_name, metric_type, data_type, source) "
            "VALUES ('trace-1', 'latency', 'aggregate', 'NUMERIC', 'API')"
        ))
        conn.execute(text(
            "INSERT INTO call_metrics (call_id, metric_name, metric_type, data_type, source) "
            "VALUES ('span-1', 'quality', 'quality', 'NUMERIC', 'API')"
        ))

        _migrate_projection_identity_sqlite(conn)

        assert _primary_key(conn, "runs") == ["row_id"]
        assert _primary_key(conn, "logged_calls") == ["row_id"]
        assert conn.execute(text("SELECT id, project FROM runs")).all() == [
            ("trace-1", "project-a")
        ]
        assert conn.execute(text("SELECT id, project FROM logged_calls")).all() == [
            ("span-1", "project-a")
        ]
        assert conn.execute(text("SELECT run_id FROM run_metrics")).scalar_one() == "trace-1"
        assert conn.execute(text("SELECT call_id FROM call_metrics")).scalar_one() == "span-1"

        conn.execute(text(
            "INSERT INTO runs "
            "(id, project, environment, tags, bookmarked, is_public, call_count) "
            "VALUES ('trace-1', 'project-b', 'default', '[]', 0, 0, 0)"
        ))
        conn.execute(text(
            "INSERT INTO logged_calls "
            "(id, project, task_id, run_id, created_at, model, observation_type, level, environment, tags) "
            "VALUES ('span-1', 'project-b', '', 'trace-1', CURRENT_TIMESTAMP, '', 'SPAN', 'DEFAULT', 'default', '[]')"
        ))
        assert conn.execute(text("SELECT count(*) FROM runs WHERE id='trace-1'")).scalar_one() == 2
        assert conn.execute(text("SELECT count(*) FROM logged_calls WHERE id='span-1'")).scalar_one() == 2


def _create_v7_projection_tables(conn) -> None:
    conn.exec_driver_sql("CREATE TABLE score_configs (id INTEGER PRIMARY KEY)")
    conn.exec_driver_sql("""
        CREATE TABLE runs (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            environment VARCHAR NOT NULL DEFAULT 'default',
            tags JSON,
            bookmarked BOOLEAN NOT NULL DEFAULT 0,
            is_public BOOLEAN NOT NULL DEFAULT 0,
            call_count INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.exec_driver_sql("""
        CREATE TABLE logged_calls (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            task_id VARCHAR NOT NULL,
            run_id VARCHAR,
            created_at DATETIME NOT NULL,
            model VARCHAR NOT NULL,
            observation_type VARCHAR NOT NULL DEFAULT 'GENERATION',
            level VARCHAR NOT NULL DEFAULT 'DEFAULT',
            environment VARCHAR NOT NULL DEFAULT 'default',
            tags JSON
        )
    """)
    conn.exec_driver_sql("""
        CREATE TABLE run_metrics (
            id INTEGER PRIMARY KEY,
            run_id VARCHAR NOT NULL REFERENCES runs(id),
            metric_name VARCHAR NOT NULL,
            metric_type VARCHAR NOT NULL,
            data_type VARCHAR NOT NULL,
            source VARCHAR NOT NULL
        )
    """)
    conn.exec_driver_sql("""
        CREATE TABLE call_metrics (
            id INTEGER PRIMARY KEY,
            call_id VARCHAR NOT NULL REFERENCES logged_calls(id),
            metric_name VARCHAR NOT NULL,
            metric_type VARCHAR NOT NULL,
            data_type VARCHAR NOT NULL,
            source VARCHAR NOT NULL
        )
    """)


def _primary_key(conn, table_name: str) -> list[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return [str(row[1]) for row in sorted(rows, key=lambda row: row[5]) if row[5]]
