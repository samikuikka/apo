# pyright: reportAny=false, reportAttributeAccessIssue=false, reportExplicitAny=false, reportMissingParameterType=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownLambdaType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUnusedCallResult=false

"""Span facet index migration (v39).

Covers the reshape from the pre-v39 narrow facet indexes to the covering
shape (``+ trace_id``), the new ``(project_id, start_time)`` window index,
and fresh ``create_all`` matching the model. Mirrors the hand-rolled
old-schema pattern in ``test_agent_task_run_configuration_migration.py``.
"""

from __future__ import annotations

import apo.models.db as mdb
from apo.db import _migrate_span_facet_indexes
from sqlalchemy import create_engine
from sqlmodel import SQLModel


def _index_columns(conn, index_name: str) -> list[str]:
    rows = conn.exec_driver_sql(
        f"PRAGMA index_info('{index_name}')"
    ).fetchall()
    return [str(row[2]) for row in sorted(rows, key=lambda r: r[0])]


def _create_pre_v39_spans_table(conn) -> None:
    """A minimal otlp_spans with the narrow pre-v39 facet indexes."""
    conn.exec_driver_sql(
        """
        CREATE TABLE otlp_spans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id VARCHAR NOT NULL,
            trace_id VARCHAR NOT NULL,
            span_id VARCHAR NOT NULL,
            start_time DATETIME,
            span_name VARCHAR NOT NULL DEFAULT '',
            service_name VARCHAR
        )
        """
    )
    conn.exec_driver_sql(
        "CREATE INDEX ix_otlp_spans_trace ON otlp_spans (project_id, trace_id)"
    )
    conn.exec_driver_sql(
        "CREATE INDEX ix_otlp_spans_service ON otlp_spans (project_id, service_name)"
    )
    conn.exec_driver_sql(
        "CREATE INDEX ix_otlp_spans_operation ON otlp_spans (project_id, span_name)"
    )


def test_v39_reshapes_narrow_facet_indexes_to_covering() -> None:
    """Existing installs get trace_id appended to both facet indexes."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v39_spans_table(conn)

        _migrate_span_facet_indexes(conn)

        assert _index_columns(conn, "ix_otlp_spans_service") == ["project_id", "service_name", "trace_id"]
        assert _index_columns(conn, "ix_otlp_spans_operation") == ["project_id", "span_name", "trace_id"]
        assert _index_columns(conn, "ix_otlp_spans_start") == ["project_id", "start_time"]


def test_v39_is_idempotent() -> None:
    """Re-running the reshape on an already-migrated schema is a no-op."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        _create_pre_v39_spans_table(conn)

    with test_engine.begin() as conn:
        _migrate_span_facet_indexes(conn)
        _migrate_span_facet_indexes(conn)
        assert _index_columns(conn, "ix_otlp_spans_service") == ["project_id", "service_name", "trace_id"]


def test_fresh_create_all_has_covering_facet_indexes() -> None:
    """SQLModel fresh create_all builds the new shape (model is the source)."""
    test_engine = create_engine("sqlite://")
    with test_engine.begin() as conn:
        SQLModel.metadata.create_all(
            conn, tables=[mdb.OtlpSpanDB.__table__]
        )
        assert _index_columns(conn, "ix_otlp_spans_service") == ["project_id", "service_name", "trace_id"]
        assert _index_columns(conn, "ix_otlp_spans_operation") == ["project_id", "span_name", "trace_id"]
        assert _index_columns(conn, "ix_otlp_spans_start") == ["project_id", "start_time"]
