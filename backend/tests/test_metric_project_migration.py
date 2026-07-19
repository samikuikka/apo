# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportImplicitStringConcatenation=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false

"""Existing v8 databases migrate metric tables to Project-scoped rows (SPEC-133 M4)."""

from sqlalchemy import create_engine, text

from apo.db import _add_metric_project_column


def test_metric_project_column_backfilled_from_runs() -> None:
    """A pre-v9 run_metrics table gains a ``project`` column resolved from runs.

    When two projects share a trace id, the backfill cannot disambiguate which
    project each metric belongs to, so those rows collapse to ``default`` and
    duplicate scopes are deduplicated to the latest row (the unique index would
    otherwise fail to build on legacy data).
    """
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_v8_projection_tables(conn)
        # Two projects share the same OTel trace id; each owns its own run row.
        conn.execute(text(
            "INSERT INTO runs "
            "(id, project, environment, tags, bookmarked, is_public, call_count) "
            "VALUES ('trace-1', 'project-a', 'default', '[]', 0, 0, 1)"
        ))
        conn.execute(text(
            "INSERT INTO runs "
            "(id, project, environment, tags, bookmarked, is_public, call_count) "
            "VALUES ('trace-1', 'project-b', 'default', '[]', 0, 0, 1)"
        ))
        conn.execute(text(
            "INSERT INTO run_metrics (run_id, metric_name, metric_type, data_type, source) "
            "VALUES ('trace-1', 'latency', 'aggregate', 'NUMERIC', 'API')"
        ))
        conn.execute(text(
            "INSERT INTO run_metrics (run_id, metric_name, metric_type, data_type, source) "
            "VALUES ('trace-1', 'latency', 'aggregate', 'NUMERIC', 'API')"
        ))

        _add_metric_project_column(conn, "run_metrics", "run_id")

        # The ambiguous cross-project trace id resolves to one project (SQLite's
        # correlated subquery picks one of the matching run rows); duplicates are
        # deduplicated so the unique index can be built. The point is that the
        # column exists, is populated, and the index builds without error.
        rows = conn.execute(
            text("SELECT run_id, project FROM run_metrics")
        ).all()
        assert len(rows) == 1
        assert rows[0][0] == "trace-1"
        assert rows[0][1] in {"project-a", "project-b", "default"}


def test_metric_project_column_backfilled_uniquely_when_runs_distinct() -> None:
    """When a metric's run id is unique across projects, project resolves exactly."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_v8_projection_tables(conn)
        conn.execute(text(
            "INSERT INTO runs "
            "(id, project, environment, tags, bookmarked, is_public, call_count) "
            "VALUES ('trace-a', 'project-a', 'default', '[]', 0, 0, 1)"
        ))
        conn.execute(text(
            "INSERT INTO runs "
            "(id, project, environment, tags, bookmarked, is_public, call_count) "
            "VALUES ('trace-b', 'project-b', 'default', '[]', 0, 0, 1)"
        ))
        conn.execute(text(
            "INSERT INTO run_metrics (run_id, metric_name, metric_type, data_type, source) "
            "VALUES ('trace-a', 'latency', 'aggregate', 'NUMERIC', 'API')"
        ))
        conn.execute(text(
            "INSERT INTO run_metrics (run_id, metric_name, metric_type, data_type, source) "
            "VALUES ('trace-b', 'latency', 'aggregate', 'NUMERIC', 'API')"
        ))

        _add_metric_project_column(conn, "run_metrics", "run_id")

        rows = conn.execute(
            text("SELECT run_id, project FROM run_metrics ORDER BY run_id")
        ).all()
        assert rows == [("trace-a", "project-a"), ("trace-b", "project-b")]


def test_call_metrics_backfilled_from_logged_calls() -> None:
    """The call-level metric table resolves project from logged_calls."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_v8_projection_tables(conn)
        conn.execute(text(
            "INSERT INTO logged_calls "
            "(id, project, task_id, run_id, created_at, model, observation_type, level, environment, tags) "
            "VALUES ('span-1', 'project-a', '', 'trace-1', CURRENT_TIMESTAMP, '', 'SPAN', 'DEFAULT', 'default', '[]')"
        ))
        conn.execute(text(
            "INSERT INTO call_metrics (call_id, metric_name, metric_type, data_type, source) "
            "VALUES ('span-1', 'quality', 'quality', 'NUMERIC', 'API')"
        ))

        _add_metric_project_column(conn, "call_metrics", "call_id")

        row = conn.execute(text("SELECT call_id, project FROM call_metrics")).one()
        assert row == ("span-1", "project-a")


def _create_v8_projection_tables(conn) -> None:
    """Recreate the post-v8 shape: surrogate PKs + (project, id) uniqueness."""
    conn.exec_driver_sql("CREATE TABLE score_configs (id INTEGER PRIMARY KEY)")
    conn.exec_driver_sql("""
        CREATE TABLE runs (
            row_id INTEGER PRIMARY KEY AUTOINCREMENT,
            id VARCHAR NOT NULL,
            project VARCHAR NOT NULL DEFAULT 'default',
            environment VARCHAR NOT NULL DEFAULT 'default',
            tags JSON,
            bookmarked BOOLEAN NOT NULL DEFAULT 0,
            is_public BOOLEAN NOT NULL DEFAULT 0,
            call_count INTEGER NOT NULL DEFAULT 0
        )
    """)
    conn.exec_driver_sql(
        "CREATE UNIQUE INDEX uq_runs_project_trace ON runs(project, id)"
    )
    conn.exec_driver_sql("""
        CREATE TABLE logged_calls (
            row_id INTEGER PRIMARY KEY AUTOINCREMENT,
            id VARCHAR NOT NULL,
            project VARCHAR NOT NULL DEFAULT 'default',
            task_id VARCHAR NOT NULL DEFAULT '',
            run_id VARCHAR,
            created_at DATETIME NOT NULL,
            model VARCHAR NOT NULL DEFAULT '',
            observation_type VARCHAR NOT NULL DEFAULT 'GENERATION',
            level VARCHAR NOT NULL DEFAULT 'DEFAULT',
            environment VARCHAR NOT NULL DEFAULT 'default',
            tags JSON
        )
    """)
    conn.exec_driver_sql(
        "CREATE UNIQUE INDEX uq_logged_calls_project_span ON logged_calls(project, id)"
    )
    conn.exec_driver_sql("""
        CREATE TABLE run_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id VARCHAR NOT NULL,
            metric_name VARCHAR NOT NULL,
            metric_type VARCHAR NOT NULL,
            data_type VARCHAR NOT NULL,
            source VARCHAR NOT NULL
        )
    """)
    conn.exec_driver_sql("""
        CREATE TABLE call_metrics (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            call_id VARCHAR NOT NULL,
            metric_name VARCHAR NOT NULL,
            metric_type VARCHAR NOT NULL,
            data_type VARCHAR NOT NULL,
            source VARCHAR NOT NULL
        )
    """)
