# pyright: reportAny=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportPrivateUsage=false, reportUnusedCallResult=false, reportUnknownArgumentType=false, reportAttributeAccessIssue=false, reportArgumentType=false, reportUnknownParameterType=false, reportMissingParameterType=false, reportCallIssue=false

"""The whole migration ladder, end to end, on SQLite and PostgreSQL.

Per-rung tests hand-roll one old table on SQLite; they cannot catch a rung
that only breaks on PostgreSQL (``PRAGMA``, ``pragma_table_info``,
``BOOLEAN DEFAULT 0``, ``DATETIME``, ``:name`` placeholders through driver
SQL). These tests boot ``init_db`` exactly as the app does:

- a fresh install reaches ``LATEST_SCHEMA_VERSION`` with the model's columns;
- a pre-framework database (no ``schema_migrations``) whose columns are
  rewound to before the rungs that add them, seeded with rows each
  data-touching rung must rewrite, climbs to the latest version with the
  rewrites applied;
- a second ``init_db`` is a no-op.

The PostgreSQL case runs against a throwaway database on
``APO_TEST_POSTGRES_URL`` and is skipped when that is unset, like the other
PostgreSQL gates.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import event, inspect, text
from sqlalchemy.engine import Connection, Engine, make_url
from sqlalchemy.pool import NullPool
from sqlmodel import Session, SQLModel, create_engine, select

import apo.db as apo_db
from apo.models.db import (
    AgentTaskBatchRunDB,
    AgentTaskResultEvidenceDB,
    AutomationDB,
    AgentTaskJudgmentDB,
    AgentTaskRunDB,
    ApiKeyDB,
    ExecutorPoolDB,
    LoggedCallDB,
    OtlpIngestBatchDB,
    OtlpSpanDB,
    ProjectDB,
    RunDB,
    TaskExecutionAttemptDB,
    TaskRevisionDB,
    UserDB,
)
from apo.services.check_report_storage import (
    compose_no_verdict_error_message,
    judge_no_verdict_message,
)

NOW = datetime(2026, 8, 1, tzinfo=timezone.utc)
ERRORED_CHECK: dict[str, object] = {
    "id": "blacked-out",
    "pass": False,
    "outcome": "error",
    "reasoning": "judge failed: gateway timeout",
    "assertions": [{"id": "judge", "pass": False, "outcome": "error"}],
}


def _sqlite_engine(tmp_path: Path, monkeypatch: MonkeyPatch) -> Engine:
    """A file database configured like the app's (WAL, FK enforcement, NullPool)."""
    url = f"sqlite:///{tmp_path / 'ladder.db'}"
    engine = create_engine(url, connect_args={"check_same_thread": False}, poolclass=NullPool)
    apo_db.attach_sqlite_pragmas(engine)
    monkeypatch.setattr(apo_db, "DATABASE_URL", url)
    monkeypatch.setattr(apo_db, "engine", engine)
    return engine


@pytest.fixture(name="sqlite_engine")
def sqlite_engine_fixture(tmp_path: Path, monkeypatch: MonkeyPatch) -> Iterator[Engine]:
    engine = _sqlite_engine(tmp_path, monkeypatch)
    yield engine
    engine.dispose()


@pytest.fixture(
    name="ladder_engine", params=["sqlite", "postgresql", "postgresql-own-schema"]
)
def ladder_engine_fixture(
    request: pytest.FixtureRequest, tmp_path: Path, monkeypatch: MonkeyPatch
) -> Iterator[Engine]:
    if request.param == "sqlite":
        engine = _sqlite_engine(tmp_path, monkeypatch)
        yield engine
        engine.dispose()
        return

    database_url = os.environ.get("APO_TEST_POSTGRES_URL")
    if database_url is None:
        pytest.skip("set APO_TEST_POSTGRES_URL to run the PostgreSQL ladder gate")
    name = f"apo_ladder_{uuid4().hex}"
    admin_engine = create_engine(database_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text(f'CREATE DATABASE "{name}"'))
    url = make_url(database_url).set(database=name).render_as_string(hide_password=False)
    if request.param == "postgresql-own-schema":
        # A deployment outside ``public``: the ladder must introspect the
        # connection's search_path, not a hard-coded schema.
        setup_engine = create_engine(url)
        with setup_engine.begin() as conn:
            conn.execute(text("CREATE SCHEMA apo"))
        setup_engine.dispose()
        engine = create_engine(url, connect_args={"options": "-csearch_path=apo"})
    else:
        engine = create_engine(url)
    try:
        # The migration helpers pick their dialect from the module URL.
        monkeypatch.setattr(apo_db, "DATABASE_URL", url)
        monkeypatch.setattr(apo_db, "engine", engine)
        yield engine
    finally:
        engine.dispose()
        with admin_engine.connect() as conn:
            conn.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
        admin_engine.dispose()


def _schema_versions(engine: Engine) -> list[int]:
    with engine.connect() as conn:
        return [
            row[0]
            for row in conn.execute(text("SELECT version FROM schema_migrations ORDER BY version"))
        ]


def _assert_model_columns(engine: Engine) -> None:
    """Every model table carries exactly the model's columns — no legacy column
    left behind, none missing."""
    with engine.connect() as conn:
        inspector = inspect(conn)
        mismatched = {
            name: (
                sorted(set(table.columns.keys()) - {c["name"] for c in inspector.get_columns(name)}),
                sorted({c["name"] for c in inspector.get_columns(name)} - set(table.columns.keys())),
            )
            for name, table in SQLModel.metadata.tables.items()
        }
    assert {k: v for k, v in mismatched.items() if v != ([], [])} == {}


def _assert_postgres_types(engine: Engine) -> None:
    """Columns a climbing database gains carry the type ``create_all`` emits."""
    if engine.dialect.name != "postgresql":
        return
    with engine.connect() as conn:
        types = {
            (row[0], row[1]): row[2]
            for row in conn.execute(
                text(
                    "SELECT table_name, column_name, data_type FROM information_schema.columns"
                    " WHERE table_schema = current_schema()"
                )
            )
        }
    expected = {
        ("runs", "bookmarked"): "boolean",
        ("runs", "is_public"): "boolean",
        ("users", "is_active"): "boolean",
        ("api_keys", "ingest_paused"): "boolean",
        ("executor_pools", "system_managed"): "boolean",
        ("automations", "was_breached"): "boolean",
        ("automations", "last_evaluated_at"): "timestamp without time zone",
        ("logged_calls", "raw_usage"): "json",
        ("logged_calls", "cost_breakdown"): "json",
        ("otlp_ingest_batches", "processing_started_at"): "timestamp with time zone",
        ("project_task_sources", "published_at"): "timestamp with time zone",
        ("agent_task_deliverables", "created_at"): "timestamp without time zone",
        ("agent_task_deliverables", "ready_at"): "timestamp without time zone",
    }
    assert {key: types.get(key) for key in expected} == expected


def test_fresh_install_reaches_latest(ladder_engine: Engine) -> None:
    apo_db.init_db()
    assert _schema_versions(ladder_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
    _assert_model_columns(ladder_engine)
    _assert_postgres_types(ladder_engine)

    statements: list[str] = []

    def record(_conn, _cursor, statement: str, *_args: object) -> None:
        statements.append(statement)

    event.listen(ladder_engine, "before_cursor_execute", record)
    try:
        apo_db.init_db()
    finally:
        event.remove(ladder_engine, "before_cursor_execute", record)
    assert _schema_versions(ladder_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
    # A booted schema takes no table locks: on Postgres even ``ADD COLUMN IF
    # NOT EXISTS`` waits for ACCESS EXCLUSIVE behind every open transaction.
    assert [s for s in statements if s.lstrip().upper().startswith("ALTER")] == []


def _seed(engine: Engine) -> None:
    """Rows in today's shape; ``_rewind`` then removes what later rungs add."""
    SQLModel.metadata.create_all(engine)
    with Session(engine) as session:
        session.add(UserDB(id="u1", email="u1@example.com", name="U", password_hash="x"))
        session.flush()
        session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
        # v1's owner backfill skips the demo project.
        session.add(ProjectDB(id="demo", name="Demo", created_by="u1"))
        session.flush()
        session.add(
            ApiKeyDB(
                id="key-1",
                name="k",
                prefix="apo_pk",
                project="p1",
                created_by="u1",
            )
        )
        session.add(ExecutorPoolDB(id="pool-1", project="p1", name="Pool", slug="pool", kind="bundled"))
        session.add(OtlpIngestBatchDB(id="ingest-1", project_id="p1", payload="{}"))
        session.add(
            AutomationDB(
                id="auto-1",
                project_id="p1",
                name="A",
                event_type="run.failed",
                action_type="webhook",
                action_config={},
            )
        )
        for batch_id in ("batch-v4", "batch-nv"):
            session.add(
                AgentTaskBatchRunDB(
                    id=batch_id,
                    project="p1",
                    selection_type="task",
                    status="completed",
                    created_at=NOW,
                )
            )
        session.flush()
        for run_id, batch_id, status, pass_result, message in (
            # v4 + v20: check counts come from the legacy checks_json.
            ("run-v4-a", "batch-v4", "passed", True, None),
            ("run-v4-b", "batch-v4", "failed", False, None),
            # v20 -> v48 -> v49 -> v50: a judge outage counted as a failure.
            ("run-judge", "batch-nv", "failed", False, None),
            # v30: the seeder's batch-level status on a run row.
            ("run-completed", "batch-nv", "completed", True, None),
            # v50: an executor failure keeps its message, gains its reason.
            ("run-crash", "batch-nv", "error", None, "adapter crashed"),
        ):
            session.add(
                AgentTaskRunDB(
                    id=run_id,
                    batch_run_id=batch_id,
                    task_id=run_id,
                    task_path="/t",
                    status=status,
                    pass_result=pass_result,
                    started_at=NOW,
                    completed_at=NOW,
                    error_message=message,
                )
            )
        session.flush()
        session.add(
            AgentTaskJudgmentDB(
                id="jdg-1",
                task_run_id="run-judge",
                project="p1",
                trigger="rejudge",
                samples=1,
                pass_result=False,
                total_checks=2,
                passed_checks=1,
                failed_checks=1,
                checks_json=[{"id": "ok", "pass": True}, ERRORED_CHECK],
                created_at=NOW,
            )
        )
        session.add(
            TaskRevisionDB(
                id="rev-1",
                project="p1",
                batch_run_id="batch-nv",
                materialization="attested",
                source_type="filesystem",
                content_sha256="0" * 64,
                file_count=1,
                uncompressed_size_bytes=1,
                manifest_summary_json={},
            )
        )
        session.flush()
        session.add(
            TaskExecutionAttemptDB(
                id="attempt-1",
                project="p1",
                batch_run_id="batch-nv",
                task_run_id="run-judge",
                task_revision_id="rev-1",
                sequence_index=0,
                target_kind="caller",
                queue_expires_at=NOW + timedelta(days=1),
            )
        )
        # The trace of run-judge (v1 primary model, v38 service, v47 rollups)
        # and a second run row claiming the same task run (v1/v3).
        session.add(RunDB(id="trace-1", project="p1", task_run_id="run-judge"))
        session.add(RunDB(id="trace-stale", project="p1"))
        for call_id, model, latency, offset, provided in (
            ("g1", "m-first", 1000.0, 0, 3),
            # v10: $5000 is past a Postgres INTEGER in micro-USD.
            ("g2", "m-second", 4000.0, 1, 5000),
        ):
            session.add(
                LoggedCallDB(
                    id=call_id,
                    project="p1",
                    task_id="run-judge",
                    run_id="trace-1",
                    model=model,
                    observation_type="GENERATION",
                    created_at=NOW + timedelta(seconds=offset),
                    latency_ms=latency,
                    cost=2,
                    provided_cost=provided,
                    internal_model_id=7,
                )
            )
        session.add(
            OtlpSpanDB(
                project_id="p1",
                trace_id="trace-1",
                span_id="g1",
                span_name="gen",
                status_code=1,
                attributes={},
                resource={"attributes": {"service.name": "svc-a"}},
                start_time=NOW,
                end_time=NOW,
            )
        )
        session.commit()


def _drop_column(conn: Connection, table: str, column: str) -> None:
    if conn.dialect.name == "sqlite":
        inspector = inspect(conn)
        constrained = [
            *(fk["constrained_columns"] for fk in inspector.get_foreign_keys(table)),
            *(uq["column_names"] for uq in inspector.get_unique_constraints(table)),
        ]
        if any(column in columns for columns in constrained):
            # SQLite cannot drop a column inside a FOREIGN KEY or UNIQUE
            # constraint; that rung's SQLite path has its own test.
            return
        # Nor an indexed one; Postgres drops the index with the column.
        for index in inspector.get_indexes(table):
            if column in index["column_names"]:
                conn.exec_driver_sql(f'DROP INDEX "{index["name"]}"')
    conn.exec_driver_sql(f'ALTER TABLE {table} DROP COLUMN "{column}"')


# Columns each rung adds, removed so the rung has to add them back. Rungs
# whose tables ``create_all`` recreates on boot need no rewind.
_DROPPED_COLUMNS: list[tuple[str, str]] = [
    # v1 baseline
    ("runs", "primary_model"),
    ("runs", "bookmarked"),
    ("runs", "is_public"),
    ("users", "is_active"),
    # v4
    ("agent_task_batch_runs", "total_checks"),
    ("agent_task_batch_runs", "passed_checks"),
    # v5 / v6 / v7 / v8
    ("otlp_ingest_batches", "verified_task_run_id"),
    ("otlp_ingest_batches", "processing_started_at"),
    ("otlp_ingest_batches", "content_policy"),
    ("projects", "trace_content_policy"),
    ("otlp_spans", "content_policy"),
    # v10
    ("logged_calls", "cost_breakdown"),
    ("logged_calls", "raw_usage"),
    ("logged_calls", "matched_tier_id"),
    ("logged_calls", "matched_tier_name"),
    ("logged_calls", "cost_provenance"),
    # v11
    ("agent_task_deliverables", "created_at"),
    ("agent_task_deliverables", "ready_at"),
    # v13 / v14 / v15
    ("agent_task_runs", "sequence_index"),
    ("agent_task_batch_runs", "cancelled_tasks"),
    ("projects", "default_executor_pool_id"),
    ("agent_task_schedules", "executor_pool_id"),
    ("agent_task_schedules", "queue_ttl_seconds"),
    ("agent_task_schedules", "disabled_reason"),
    ("agent_task_runs", "configured_model"),
    ("agent_task_runs", "configured_effort"),
    # v16 / v17 / v18
    ("executor_pools", "system_managed"),
    ("task_execution_attempts", "assignment_kind"),
    ("executors", "reported_catalog_digest"),
    ("executors", "reported_available_slots"),
    ("agent_task_schedules", "execution_kind"),
    ("agent_task_schedules", "execution_owner_user_id"),
    ("agent_task_schedules", "active_batch_run_id"),
    # v20
    ("agent_task_runs", "total_checks"),
    ("agent_task_runs", "passed_checks"),
    ("agent_task_runs", "failed_checks"),
    # v21 / v23 / v29 / v32 / v33
    ("project_task_sources", "catalog_schema_version"),
    ("agent_task_runs", "unpriced_call_count"),
    ("agent_task_runs", "generation_execution_json"),
    ("agent_task_runs", "corrected_tests"),
    ("projects", "evidence_retention_days"),
    # v35 / v40 / v36 / v37 / v38
    ("runs", "input_preview"),
    ("runs", "output_preview"),
    ("runs", "input_preview_call_row_id"),
    ("runs", "output_preview_call_row_id"),
    ("otlp_spans", "service_name"),
    ("api_keys", "daily_span_quota"),
    ("api_keys", "ingest_paused"),
    ("otlp_ingest_batches", "api_key_id"),
    ("otlp_ingest_batches", "payload_bytes"),
    ("runs", "service_name"),
    # init_db's task-catalog columns (outside the versioned ladder)
    ("project_task_sources", "catalog_digest"),
    ("project_task_sources", "published_at"),
    # v45 / v46 / v47
    ("automations", "slack_webhook_url_encrypted"),
    ("agent_task_runs", "generation_usage_json"),
    ("agent_task_runs", "total_reasoning_tokens"),
    ("agent_task_runs", "max_call_reasoning_tokens"),
    ("agent_task_runs", "max_call_reasoning_call_id"),
    ("agent_task_runs", "max_call_latency_ms"),
    ("agent_task_runs", "max_call_latency_call_id"),
    ("agent_task_runs", "total_model_time_ms"),
    # v48 / v50
    ("agent_task_runs", "errored_checks"),
    ("agent_task_judgments", "errored_checks"),
    ("agent_task_runs", "no_verdict_reason"),
    # v51
    ("automations", "trigger_kind"),
    ("automations", "window_metric"),
    ("automations", "window_operator"),
    ("automations", "window_threshold"),
    ("automations", "evaluation_window"),
    ("automations", "was_breached"),
    ("automations", "last_evaluated_at"),
    ("automations", "last_evaluated_value"),
    # Constrained columns: dropped on Postgres only (see ``_drop_column``).
    ("run_metrics", "project"),  # v9
    ("agent_task_batch_runs", "requested_by_user_id"),  # v16
    ("task_execution_attempts", "target_user_id"),  # v16
    ("executors", "enrolled_by_user_id"),  # v16
    ("agent_task_runs", "task_definition_revision_id"),  # v21
    ("project_task_inventory", "task_definition_revision_id"),  # v21
]

# Columns old databases had and rungs drop.
_LEGACY_COLUMNS: list[tuple[str, str, str]] = [
    ("agent_task_runs", "criteria_json", "JSON"),  # v2
    ("project_task_inventory", "has_criterion_evaluator", "BOOLEAN"),  # v2
    ("agent_task_runs", "checks_json", "JSON"),  # v4 / v20, dropped by v28
    ("logged_calls", "calculated_cost", "REAL"),  # v10
    ("project_task_inventory", "has_user_simulator", "BOOLEAN"),  # v22
    ("agent_task_runs", "deliverables_json", "JSON"),  # v26, dropped by v28
    ("otlp_spans", "raw_span", "TEXT"),  # v34
]


def _sqlite_make_revision_not_null(conn: Connection, *, column_before: str = "") -> None:
    """v19's pre-state on SQLite, which has no ``ALTER COLUMN``: rebuild the
    attempts table from its own DDL with the revision ``NOT NULL`` (create,
    copy, drop, rename — the order that leaves other tables' FKs intact).
    ``column_before`` is extra column DDL placed just ahead of the revision."""
    ddl = conn.exec_driver_sql(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'task_execution_attempts'"
    ).scalar_one()
    rebuilt = ddl.replace(
        "task_revision_id VARCHAR,", f"{column_before}task_revision_id VARCHAR NOT NULL,", 1
    )
    assert rebuilt != ddl, ddl
    columns = ", ".join(
        f'"{row[1]}"'
        for row in conn.exec_driver_sql("PRAGMA table_info('task_execution_attempts')")
    )
    rebuilt = rebuilt.replace("task_execution_attempts", "_attempts_rewind", 1)
    indexes = [
        row[0]
        for row in conn.exec_driver_sql(
            "SELECT sql FROM sqlite_master WHERE type = 'index'"
            " AND tbl_name = 'task_execution_attempts' AND sql IS NOT NULL"
        )
    ]
    conn.exec_driver_sql(rebuilt)
    conn.exec_driver_sql(
        f"INSERT INTO _attempts_rewind ({columns}) SELECT {columns} FROM task_execution_attempts"
    )
    conn.exec_driver_sql("DROP TABLE task_execution_attempts")
    conn.exec_driver_sql("ALTER TABLE _attempts_rewind RENAME TO task_execution_attempts")
    for statement in indexes:
        conn.exec_driver_sql(statement)


def _assert_attempts_rebuilt(engine: Engine) -> None:
    """v19 left the revision nullable, and the evidence table's foreign key
    still names the attempts table (SQLite's rebuild renames it)."""
    with engine.connect() as conn:
        inspector = inspect(conn)
        revision = next(
            column
            for column in inspector.get_columns("task_execution_attempts")
            if column["name"] == "task_revision_id"
        )
        evidence_targets = {
            fk["referred_table"]
            for fk in inspector.get_foreign_keys("agent_task_result_evidence")
            if fk["constrained_columns"] == ["attempt_id"]
        }
        unique_names = {
            *(index["name"] for index in inspector.get_indexes("task_execution_attempts") if index["unique"]),
            *(uq["name"] for uq in inspector.get_unique_constraints("task_execution_attempts")),
        }
        index_names = {index["name"] for index in inspector.get_indexes("task_execution_attempts")}
    assert revision["nullable"]
    assert evidence_targets == {"task_execution_attempts"}
    # The rebuild keeps one attempt per task run and the ladder's claim indexes.
    assert "uq_task_execution_attempt_run" in unique_names
    assert {
        "ix_task_attempt_claim",
        "ix_task_attempt_lease",
        "ix_task_attempt_assignment_kind",
        "ix_task_attempt_source_owned_claim",
    } <= index_names


def _rewind(engine: Engine) -> None:
    postgres = engine.dialect.name == "postgresql"
    with engine.begin() as conn:
        # v1/v3 enforce one trace per task run: the unique index goes back to
        # the pre-v3 non-unique shape so a stale second link can exist.
        conn.exec_driver_sql("DROP INDEX ix_runs_task_run_id")
        conn.exec_driver_sql("UPDATE runs SET task_run_id = 'run-judge' WHERE id = 'trace-stale'")
        conn.exec_driver_sql("DROP INDEX ix_agent_task_runs_started_at")  # v42
        for table, column in _DROPPED_COLUMNS:
            _drop_column(conn, table, column)
        for table, column, column_type in _LEGACY_COLUMNS:
            conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {column_type}")
        if postgres:
            # v8: projection tables keyed by their public id, as before.
            for table in ("runs", "logged_calls"):
                conn.exec_driver_sql(f"ALTER TABLE {table} DROP COLUMN row_id")
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD PRIMARY KEY (id)")
            # v9: unscoped metric rows, duplicates included.
            for _ in range(2):
                conn.execute(
                    text(
                        "INSERT INTO run_metrics (run_id, metric_name, metric_type, data_type,"
                        " source, created_at) VALUES ('trace-1', 'quality', 'score', 'NUMERIC',"
                        " 'API', :now)"
                    ),
                    {"now": NOW},
                )
            # v19: the attempt's revision was NOT NULL.
            conn.exec_driver_sql(
                "ALTER TABLE task_execution_attempts ALTER COLUMN task_revision_id SET NOT NULL"
            )
        else:
            _sqlite_make_revision_not_null(conn)
        conn.exec_driver_sql(
            "CREATE TABLE model_definitions (id INTEGER PRIMARY KEY, model_name VARCHAR)"
        )  # v10
        conn.exec_driver_sql("CREATE TABLE annotation_queues (id VARCHAR PRIMARY KEY)")  # v41
        for run_id, checks in (
            ("run-v4-a", [{"id": "a", "pass": True}, {"id": "b", "pass": True}]),
            ("run-v4-b", [{"id": "a", "pass": True}, {"id": "b", "pass": False}]),
            ("run-judge", [{"id": "ok", "pass": True}, ERRORED_CHECK]),
        ):
            conn.execute(
                text("UPDATE agent_task_runs SET checks_json = :checks WHERE id = :id"),
                {"checks": json.dumps(checks), "id": run_id},
            )
        conn.execute(
            text("UPDATE agent_task_runs SET deliverables_json = :d WHERE id = 'run-v4-a'"),
            {"d": json.dumps({"summary": {"ok": True}})},
        )
        conn.exec_driver_sql(
            "UPDATE agent_task_runs SET trace_run_id = 'trace-1' WHERE id = 'run-judge'"
        )
        conn.exec_driver_sql(
            "UPDATE agent_task_runs SET trace_persistence_status = 'completed'"
            " WHERE id = 'run-completed'"
        )


def _climbed_state(engine: Engine) -> dict[str, object]:
    with engine.connect() as conn:

        def rows(sql: str) -> list[tuple[object, ...]]:
            return [tuple(row) for row in conn.execute(text(sql))]

        return {
            "runs": rows(
                "SELECT id, task_run_id, primary_model, service_name, bookmarked, is_public"
                " FROM runs ORDER BY id"
            ),
            "task_runs": rows(
                "SELECT id, status, pass_result, total_checks, passed_checks, failed_checks,"
                " errored_checks, no_verdict_reason, error_message, trace_persistence_status,"
                " max_call_latency_ms, max_call_latency_call_id"
                " FROM agent_task_runs ORDER BY id"
            ),
            "batches": rows(
                "SELECT id, total_checks, passed_checks, total_tasks, passed_tasks,"
                " failed_tasks, errored_tasks FROM agent_task_batch_runs ORDER BY id"
            ),
            "reports": rows("SELECT run_id FROM agent_task_check_reports ORDER BY run_id"),
            "judgments": rows(
                "SELECT id, pass_result, failed_checks, errored_checks FROM agent_task_judgments"
            ),
            "calls": rows(
                "SELECT id, cost, provided_cost, internal_model_id FROM logged_calls ORDER BY id"
            ),
            "spans": rows("SELECT span_id, service_name FROM otlp_spans"),
            "metrics": rows("SELECT run_id, project FROM run_metrics"),
            "deliverables": rows(
                "SELECT task_run_id, name, kind, status FROM agent_task_deliverables"
            ),
            "attempts": rows(
                "SELECT id, assignment_kind, task_revision_id FROM task_execution_attempts"
            ),
            "pools": rows("SELECT id, system_managed FROM executor_pools"),
            "keys": rows("SELECT id, ingest_paused FROM api_keys"),
            "automations": rows(
                "SELECT id, trigger_kind, was_breached, last_evaluated_at FROM automations"
            ),
            "users": rows("SELECT id, is_active FROM users"),
            "memberships": rows(
                "SELECT project_id, user_id, role FROM project_memberships"
            ),
            "tables": sorted(
                set(inspect(conn).get_table_names()) & {"model_definitions", "annotation_queues"}
            ),
        }


def test_old_database_climbs_the_whole_ladder(ladder_engine: Engine) -> None:
    _seed(ladder_engine)
    _rewind(ladder_engine)

    apo_db.init_db()

    assert _schema_versions(ladder_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
    _assert_model_columns(ladder_engine)
    _assert_postgres_types(ladder_engine)

    state = _climbed_state(ladder_engine)
    rule = compose_no_verdict_error_message(
        judge_no_verdict_message(total_checks=2, failed_checks=0, errored_checks=1), None
    )
    assert state["runs"] == [
        # v1: primary model from the first call; v1/v3: the stale link is
        # cut; v38: the service from the trace's spans.
        ("trace-1", "run-judge", "m-first", "svc-a", False, False),
        ("trace-stale", None, None, None, False, False),
    ]
    assert state["task_runs"] == [
        ("run-completed", "passed", True, 0, 0, 0, 0, None, None, "persisted", None, None),
        ("run-crash", "error", None, 0, 0, 0, 0, "executor", "adapter crashed", "pending", None, None),
        # v20 counted the outage a failure, v48 moved it to errored, v49 took
        # the verdict, v50 named the reason; v47 rolled up the trace's calls.
        ("run-judge", "error", None, 2, 1, 0, 1, "judge", rule, "pending", 4000.0, "g2"),
        ("run-v4-a", "passed", True, 2, 2, 0, 0, None, None, "pending", None, None),
        ("run-v4-b", "failed", False, 2, 1, 1, 0, None, None, "pending", None, None),
    ]
    assert state["batches"] == [
        # Re-rolled by v49/v50 after run-judge lost its verdict.
        ("batch-nv", 2, 1, 3, 1, 0, 2),
        # v4's check totals from checks_json; the task totals were never set.
        ("batch-v4", 4, 3, 0, 0, 0, 0),
    ]
    assert state["reports"] == [("run-judge",), ("run-v4-a",), ("run-v4-b",)]
    assert state["judgments"] == [("jdg-1", None, 0, 1)]
    # v10: float USD to micro-USD, free-form model ids cleared; on Postgres a
    # cost too large for INTEGER micro-USD is nulled rather than wedging boot.
    oversized = 5_000_000_000 if ladder_engine.dialect.name == "sqlite" else None
    assert state["calls"] == [("g1", 2_000_000, 3_000_000, None), ("g2", 2_000_000, oversized, None)]
    assert state["spans"] == [("g1", "svc-a")]  # v36
    if ladder_engine.dialect.name == "postgresql":
        assert state["metrics"] == [("trace-1", "p1")]  # v9 deduplicated + scoped
    assert state["deliverables"] == [("run-v4-a", "summary", "json", "ready")]  # v26
    assert state["attempts"] == [("attempt-1", "caller", "rev-1")]  # v16
    assert state["pools"] == [("pool-1", False)]
    assert state["keys"] == [("key-1", False)]
    assert state["automations"] == [("auto-1", "event", False, None)]  # v51
    assert state["users"] == [("u1", True)]
    assert state["memberships"] == [("p1", "u1", "owner")]  # v1 owner backfill
    with ladder_engine.connect() as conn:
        membership_id = conn.exec_driver_sql("SELECT id FROM project_memberships").scalar_one()
    # SQLite keeps its historical 32-hex id; Postgres takes the model's 16-hex shape.
    assert len(membership_id) == (32 if ladder_engine.dialect.name == "sqlite" else 16)
    assert state["tables"] == []  # v10, v41
    _assert_attempts_rebuilt(ladder_engine)  # v19
    with ladder_engine.connect() as conn:
        automation_indexes = {index["name"] for index in inspect(conn).get_indexes("automations")}
    assert "ix_automations_trigger_kind" in automation_indexes  # v56

    apo_db.init_db()

    assert _schema_versions(ladder_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
    assert _climbed_state(ladder_engine) == state


def test_owner_backfill_yields_to_a_concurrent_boot(ladder_engine: Engine) -> None:
    """Two processes booting at once both see the owner missing; the one that
    inserts second must skip the row, not fail on ``uq_project_membership``."""
    if ladder_engine.dialect.name != "postgresql":
        pytest.skip("SQLite serializes writers; there is no race to lose")
    SQLModel.metadata.create_all(ladder_engine)
    with Session(ladder_engine) as session:
        session.add(UserDB(id="u1", email="u1@example.com", name="U", password_hash="x"))
        session.flush()
        session.add(ProjectDB(id="p1", name="P1", created_by="u1"))
        session.commit()

    outcome: dict[str, object] = {}

    def second_boot() -> None:
        try:
            with ladder_engine.begin() as conn:
                apo_db._backfill_owner_memberships(conn)
            outcome["ok"] = True
        except Exception as exc:  # noqa: BLE001 - reported by the assertion below
            outcome["error"] = exc

    with ladder_engine.connect() as first_boot:
        first_boot.exec_driver_sql(
            "INSERT INTO project_memberships (id, project_id, user_id, role)"
            " VALUES ('first-boot', 'p1', 'u1', 'owner')"
        )
        thread = threading.Thread(target=second_boot)
        thread.start()
        # The second insert waits on the first's uncommitted row.
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            # A fresh connection: pg_stat_activity is frozen per transaction.
            with ladder_engine.connect() as observer:
                waiting = observer.exec_driver_sql(
                    "SELECT count(*) FROM pg_stat_activity"
                    " WHERE datname = current_database() AND wait_event_type = 'Lock'"
                ).scalar()
            if waiting:
                break
            time.sleep(0.05)
        else:
            pytest.fail(f"the second boot never waited on the first's row: {outcome}")
        first_boot.commit()
        thread.join(timeout=10)

    assert outcome == {"ok": True}
    with ladder_engine.connect() as conn:
        assert [
            tuple(row) for row in conn.execute(text("SELECT id, role FROM project_memberships"))
        ] == [("first-boot", "owner")]


INITIAL_RELEASE_V7 = (
    Path(__file__).parent / "fixtures" / "migrations" / "postgres_initial_release_v7.sql"
)


def _logged_calls(engine: Engine) -> list[tuple[object, ...]]:
    with engine.connect() as conn:
        return [
            tuple(row)
            for row in conn.execute(
                text("SELECT id, cost, provided_cost, internal_model_id FROM logged_calls")
            )
        ]


def test_initial_release_postgres_database_climbs(ladder_engine: Engine) -> None:
    """A database the initial public release left on Postgres, as it really is.

    That release created ``logged_calls.cost``/``provided_cost`` as
    ``double precision`` and ``internal_model_id`` as ``varchar``. The climb
    must end on the model's INTEGER columns, or Postgres rejects
    ``internal_model_id = 5``. ``_rewind`` starts from today's types, so only
    this dump exercises the conversion.
    """
    if ladder_engine.dialect.name != "postgresql":
        pytest.skip("a Postgres dump; SQLite's declared types do not bind")
    raw = ladder_engine.raw_connection()
    try:
        # The DBAPI cursor: the dump holds many statements and no parameters.
        cursor = raw.cursor()
        cursor.execute(INITIAL_RELEASE_V7.read_text())
        cursor.close()
        raw.commit()
    finally:
        raw.close()
    assert _schema_versions(ladder_engine) == list(range(1, 8))
    with ladder_engine.begin() as conn:
        # ROUND(5000.25 * 1000000)::integer is out of INTEGER range.
        conn.exec_driver_sql("UPDATE logged_calls SET provided_cost = 5000.25 WHERE id = 'g1'")

    apo_db.init_db()

    assert _schema_versions(ladder_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
    _assert_model_columns(ladder_engine)
    with ladder_engine.connect() as conn:
        call_types = {
            column["name"]: type(column["type"]).__name__
            for column in inspect(conn).get_columns("logged_calls")
            if column["name"] in {"cost", "provided_cost", "internal_model_id"}
        }
    assert call_types == {
        "cost": "INTEGER",
        "provided_cost": "INTEGER",
        "internal_model_id": "INTEGER",
    }
    calls = _logged_calls(ladder_engine)
    assert calls == [("g1", 2500, None, None)]  # v10: USD to micro-USD; oversized nulled
    with Session(ladder_engine) as session:
        # The repricing lookup (apo/services/reprice.py).
        matched = session.exec(
            select(LoggedCallDB).where(LoggedCallDB.internal_model_id == 5)
        ).all()
    assert matched == []
    with ladder_engine.connect() as conn:
        memberships = [
            tuple(row)
            for row in conn.execute(text("SELECT id, project_id, user_id, role FROM project_memberships"))
        ]
        task_runs = [
            tuple(row)
            for row in conn.execute(
                text("SELECT id, total_checks, passed_checks, failed_checks FROM agent_task_runs")
            )
        ]
    assert memberships == [("m1", "p1", "u1", "owner")]
    assert task_runs == [("r1", 2, 1, 1)]  # v20 from the legacy checks_json
    _assert_attempts_rebuilt(ladder_engine)

    apo_db.init_db()

    assert _logged_calls(ladder_engine) == calls


# --- v19's SQLite rebuild and the v56 repair ---------------------------------

LEGACY_ATTEMPTS = "_task_execution_attempts_v18_legacy"
REBUILD_COPY = "INSERT INTO task_execution_attempts SELECT"


def _evidence(evidence_id: str, attempt_id: str) -> AgentTaskResultEvidenceDB:
    return AgentTaskResultEvidenceDB(
        id=evidence_id,
        project="p1",
        task_run_id="run-judge",
        attempt_id=attempt_id,
        slot="checks",
        deliverable_name=evidence_id,
        slot_key=evidence_id,
        status="ready",
        size_bytes=1,
        sha256="0" * 64,
        created_at=NOW,
    )


def _stamp(engine: Engine, through: int) -> None:
    with engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE schema_migrations (version INTEGER NOT NULL)")
        for version in range(1, through + 1):
            conn.exec_driver_sql(f"INSERT INTO schema_migrations (version) VALUES ({version})")


def _pre_v19_database(engine: Engine, *, column_before: str = "") -> None:
    """Today's schema and rows, with the revision NOT NULL as v13 made it and
    one evidence row on the attempt; stamped at v18."""
    _seed(engine)
    with engine.begin() as conn:
        _sqlite_make_revision_not_null(conn, column_before=column_before)
    with Session(engine) as session:
        session.add(_evidence("ev-1", "attempt-1"))
        session.commit()
    _stamp(engine, 18)


def _attempts_state(engine: Engine) -> dict[str, object]:
    with engine.connect() as conn:
        tables = set(inspect(conn).get_table_names())
        revision = next(
            column
            for column in inspect(conn).get_columns("task_execution_attempts")
            if column["name"] == "task_revision_id"
        )
        return {
            "attempts": [
                tuple(row)
                for row in conn.exec_driver_sql(
                    "SELECT id, task_revision_id, assignment_kind"
                    " FROM task_execution_attempts ORDER BY id"
                )
            ],
            "revision_nullable": revision["nullable"],
            "legacy_table": LEGACY_ATTEMPTS in tables,
            "evidence": [
                tuple(row)
                for row in conn.exec_driver_sql(
                    "SELECT id, attempt_id FROM agent_task_result_evidence ORDER BY id"
                )
            ],
            "evidence_fk": sorted(
                fk["referred_table"]
                for fk in inspect(conn).get_foreign_keys("agent_task_result_evidence")
            ),
            "fk_violations": conn.exec_driver_sql("PRAGMA foreign_key_check").fetchall(),
        }


def _attempt_indexes(engine: Engine, table: str = "task_execution_attempts") -> set[str]:
    with engine.connect() as conn:
        return {
            row[0]
            for row in conn.exec_driver_sql(
                f"SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = '{table}'"
            )
        }


UNTOUCHED = {
    "attempts": [("attempt-1", "rev-1", "bundled")],
    "revision_nullable": False,
    "legacy_table": False,
    "evidence": [("ev-1", "attempt-1")],
    "evidence_fk": ["agent_task_runs", "task_execution_attempts"],
    "fk_violations": [],
}


@pytest.mark.parametrize(
    "failing_statement",
    [REBUILD_COPY, f"DROP TABLE {LEGACY_ATTEMPTS}", "CREATE INDEX"],
)
def test_v19_rebuild_rolls_back_as_one(
    sqlite_engine: Engine, monkeypatch: MonkeyPatch, failing_statement: str
) -> None:
    """A failure part-way through the SQLite rebuild leaves the table as it
    was, so the next boot runs v19 again instead of stamping past rows left
    in the renamed table."""
    _pre_v19_database(sqlite_engine)
    indexes = _attempt_indexes(sqlite_engine)
    execute = Connection.exec_driver_sql

    def fail_at(self: Connection, statement: str, *args: object, **kwargs: object):
        if statement.lstrip().startswith(failing_statement):
            raise RuntimeError("injected")
        return execute(self, statement, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Connection, "exec_driver_sql", fail_at)
        with pytest.raises(RuntimeError, match="injected"):
            apo_db.init_db()

    assert _schema_versions(sqlite_engine) == list(range(1, 19))
    assert _attempts_state(sqlite_engine) == UNTOUCHED
    assert _attempt_indexes(sqlite_engine) == indexes

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
    assert _attempts_state(sqlite_engine) == {**UNTOUCHED, "revision_nullable": True}
    assert _attempt_indexes(sqlite_engine) == indexes


def test_v19_rebuild_survives_a_kill_at_the_copy(sqlite_engine: Engine) -> None:
    _pre_v19_database(sqlite_engine)
    indexes = _attempt_indexes(sqlite_engine)
    script = (
        "import os, sys\n"
        "from sqlalchemy.engine import Connection\n"
        "import apo.db as apo_db\n"
        "execute = Connection.exec_driver_sql\n"
        "def die_at(self, statement, *args, **kwargs):\n"
        f"    if statement.lstrip().startswith({REBUILD_COPY!r}):\n"
        "        os._exit(9)\n"
        "    return execute(self, statement, *args, **kwargs)\n"
        "Connection.exec_driver_sql = die_at\n"
        "apo_db.init_db()\n"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        cwd=Path(apo_db.__file__).parents[1],
        env={**os.environ, "DATABASE_URL": str(sqlite_engine.url)},
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 9, result.stderr

    assert _attempts_state(sqlite_engine) == UNTOUCHED
    assert _attempt_indexes(sqlite_engine) == indexes

    apo_db.init_db()

    assert _attempts_state(sqlite_engine) == {**UNTOUCHED, "revision_nullable": True}
    assert _attempt_indexes(sqlite_engine) == indexes


def test_v19_rebuild_restores_the_connection(sqlite_engine: Engine) -> None:
    """Foreign keys come back on and rename semantics back to modern on the
    rebuilding connection, and the rebuild refuses to run inside an open
    transaction, where ``foreign_keys=OFF`` would be ignored."""
    _pre_v19_database(sqlite_engine)
    with sqlite_engine.connect() as conn:
        conn.exec_driver_sql("UPDATE task_execution_attempts SET phase = phase")
        with pytest.raises(RuntimeError, match="transaction is already open"):
            apo_db._make_attempt_task_revision_nullable(conn)
        conn.rollback()

    with sqlite_engine.begin() as conn:
        apo_db._make_attempt_task_revision_nullable(conn)
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        assert conn.exec_driver_sql("PRAGMA legacy_alter_table").scalar() == 0
    assert _attempts_state(sqlite_engine) == {**UNTOUCHED, "revision_nullable": True}


def test_v19_rebuild_leaves_a_similarly_named_column_alone(sqlite_engine: Engine) -> None:
    _pre_v19_database(
        sqlite_engine, column_before="source_task_revision_id VARCHAR NOT NULL DEFAULT 'src', "
    )

    apo_db._migrate_to_v19()

    with sqlite_engine.connect() as conn:
        nullable = {
            column["name"]: column["nullable"]
            for column in inspect(conn).get_columns("task_execution_attempts")
            if column["name"].endswith("task_revision_id")
        }
    assert nullable == {"source_task_revision_id": False, "task_revision_id": True}


def _break_like_the_old_v19(engine: Engine) -> None:
    """What v19 did before it ran in one transaction, up to the failed copy:
    drop the attempts indexes, rename the table (with foreign keys on, which
    repoints the evidence FK at the renamed table), create the model's
    nullable table, then fail.

    As on a real v13–v18 database, ``assignment_kind`` sits at the end of the
    old table, where v16 appended it: the model's column order differs."""
    with engine.connect() as conn:
        for (name,) in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
            " AND tbl_name = 'task_execution_attempts' AND sql IS NOT NULL"
        ).fetchall():
            conn.exec_driver_sql(f'DROP INDEX "{name}"')
        conn.exec_driver_sql("ALTER TABLE task_execution_attempts DROP COLUMN assignment_kind")
        conn.exec_driver_sql(
            "ALTER TABLE task_execution_attempts ADD COLUMN assignment_kind VARCHAR DEFAULT 'bundled'"
        )
        conn.exec_driver_sql("UPDATE task_execution_attempts SET assignment_kind = 'caller'")
        conn.exec_driver_sql(f"ALTER TABLE task_execution_attempts RENAME TO {LEGACY_ATTEMPTS}")
        SQLModel.metadata.tables["task_execution_attempts"].create(conn)
        conn.commit()


@pytest.mark.parametrize("stamped_through", [18, 50, 51])
def test_orphaned_attempts_are_restored(sqlite_engine: Engine, stamped_through: int) -> None:
    """A database the old v19 broke: its next boot either retries v19 (still at
    v18) or has already stamped on to v50 or v51 with the Attempts orphaned.
    v19's entry and v56 put them back."""
    _pre_v19_database(sqlite_engine)
    evidence_indexes = _attempt_indexes(sqlite_engine, "agent_task_result_evidence")
    with sqlite_engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE schema_migrations")
    _break_like_the_old_v19(sqlite_engine)
    _stamp(sqlite_engine, stamped_through)
    with Session(sqlite_engine) as session:
        # Written by the app after the break, into the new empty table.
        session.add(
            TaskExecutionAttemptDB(
                id="attempt-2",
                project="p1",
                batch_run_id="batch-v4",
                task_run_id="run-v4-a",
                sequence_index=0,
                target_kind="caller",
                queue_expires_at=NOW + timedelta(days=1),
            )
        )
        session.commit()
    broken = _attempts_state(sqlite_engine)
    assert broken["attempts"] == [("attempt-2", None, "bundled")]
    assert broken["legacy_table"] is True
    assert broken["evidence_fk"] == [LEGACY_ATTEMPTS, "agent_task_runs"]
    repaired = {
        **UNTOUCHED,
        "attempts": [("attempt-1", "rev-1", "caller"), ("attempt-2", None, "bundled")],
        "revision_nullable": True,
    }
    if stamped_through == 18:
        # v19 restores them itself, before any later rung reads the table.
        apo_db._migrate_to_v19()
        assert _attempts_state(sqlite_engine) == repaired

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
    assert _attempts_state(sqlite_engine) == repaired
    _assert_attempts_rebuilt(sqlite_engine)
    # The evidence table was rebuilt to repoint its FK; its indexes came back
    # (a later rung may add more on the way from v18).
    assert evidence_indexes <= _attempt_indexes(sqlite_engine, "agent_task_result_evidence")
    with Session(sqlite_engine) as session:
        session.add(_evidence("ev-2", "attempt-2"))
        session.commit()

    apo_db.init_db()

    assert _attempts_state(sqlite_engine) == {
        **repaired,
        "evidence": [("ev-1", "attempt-1"), ("ev-2", "attempt-2")],
    }


def test_attempt_restore_is_a_no_op_on_postgres(ladder_engine: Engine) -> None:
    if ladder_engine.dialect.name == "sqlite":
        pytest.skip("the SQLite repair has its own tests")
    apo_db.init_db()
    with ladder_engine.connect() as conn:
        # The old v19 stopped at its PRAGMA on Postgres, before any rename.
        assert LEGACY_ATTEMPTS not in set(inspect(conn).get_table_names())
    with ladder_engine.begin() as conn:
        apo_db._restore_orphaned_attempts_sqlite(conn)
    assert _schema_versions(ladder_engine) == list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))


def _damaged(engine: Engine, through: int) -> None:
    """A database the old v19 broke, stamped through ``through``."""
    _pre_v19_database(engine)
    with engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE schema_migrations")
    _break_like_the_old_v19(engine)
    _stamp(engine, through)


def _without_foreign_keys(engine: Engine, *statements: str) -> None:
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys=OFF")
        for statement in statements:
            conn.exec_driver_sql(statement)
        conn.commit()


def _add_attempt(engine: Engine, attempt_id: str, batch_run_id: str, task_run_id: str) -> None:
    """An Attempt the app wrote after the damage, into the new empty table."""
    with Session(engine) as session:
        session.add(
            TaskExecutionAttemptDB(
                id=attempt_id,
                project="p1",
                batch_run_id=batch_run_id,
                task_run_id=task_run_id,
                sequence_index=0,
                target_kind="caller",
                queue_expires_at=NOW + timedelta(days=1),
            )
        )
        session.commit()


LATEST = list(range(1, apo_db.LATEST_SCHEMA_VERSION + 1))
REPAIRED = {
    **UNTOUCHED,
    "attempts": [("attempt-1", "rev-1", "caller")],
    "revision_nullable": True,
}


def test_attempt_of_a_deleted_run_is_left_out(sqlite_engine: Engine) -> None:
    """While the Attempts sat in the legacy table, retention deleted their
    Task Run (it found no Attempts to delete with it). Restored, the Attempt
    would make every lease-reaper sweep fail on the missing run."""
    from apo.services.execution_leases import recover_expired_attempts

    _damaged(sqlite_engine, 51)
    _without_foreign_keys(
        sqlite_engine,
        "DELETE FROM agent_task_result_evidence WHERE task_run_id = 'run-judge'",
        "DELETE FROM agent_task_runs WHERE id = 'run-judge'",
    )

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == LATEST
    state = _attempts_state(sqlite_engine)
    assert state["attempts"] == []
    assert state["legacy_table"] is False
    with sqlite_engine.connect() as conn:
        assert (
            conn.exec_driver_sql("PRAGMA foreign_key_check('task_execution_attempts')").fetchall()
            == []
        )
    with Session(sqlite_engine) as session:
        recover_expired_attempts(session, now=NOW + timedelta(days=365))


@pytest.mark.parametrize(
    "parent",
    [
        f"UPDATE {LEGACY_ATTEMPTS} SET project = 'gone' WHERE id = 'attempt-1'",
        f"UPDATE {LEGACY_ATTEMPTS} SET batch_run_id = 'gone' WHERE id = 'attempt-1'",
    ],
    ids=["project", "batch"],
)
def test_attempt_of_a_missing_parent_is_left_out(sqlite_engine: Engine, parent: str) -> None:
    """Its staging evidence goes with it."""
    _damaged(sqlite_engine, 51)
    _without_foreign_keys(sqlite_engine, parent)

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == LATEST
    assert _attempts_state(sqlite_engine) == {**REPAIRED, "attempts": [], "evidence": []}


@pytest.mark.parametrize(
    ("column", "damage"),
    [
        ("task_revision_id", "DELETE FROM task_revisions WHERE id = 'rev-1'"),
        ("target_user_id", f"UPDATE {LEGACY_ATTEMPTS} SET target_user_id = 'gone'"),
        ("executor_pool_id", f"UPDATE {LEGACY_ATTEMPTS} SET executor_pool_id = 'gone'"),
        ("executor_id", f"UPDATE {LEGACY_ATTEMPTS} SET executor_id = 'gone'"),
    ],
    ids=["revision", "target-user", "executor-pool", "executor"],
)
def test_restored_attempt_drops_a_deleted_optional_reference(
    sqlite_engine: Engine, column: str, damage: str
) -> None:
    """The row is restored with the reference nulled, and the whole database
    passes ``PRAGMA foreign_key_check``."""
    _damaged(sqlite_engine, 51)
    _without_foreign_keys(sqlite_engine, damage)

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == LATEST
    revision = None if column == "task_revision_id" else "rev-1"
    assert _attempts_state(sqlite_engine) == {
        **REPAIRED,
        "attempts": [("attempt-1", revision, "caller")],
    }
    with sqlite_engine.connect() as conn:
        assert conn.exec_driver_sql(
            "SELECT task_revision_id, target_user_id, executor_pool_id, executor_id"
            " FROM task_execution_attempts"
        ).fetchall() == [(revision, None, None, None)]


def test_attempt_whose_run_has_a_newer_attempt_is_left_out(
    sqlite_engine: Engine, caplog: pytest.LogCaptureFixture
) -> None:
    """The run was given a new Attempt after the damage; restoring the old one
    too would hit ``uq_task_execution_attempt_run`` on every boot. The old
    Attempt's staging evidence goes with it."""
    _damaged(sqlite_engine, 51)
    _add_attempt(sqlite_engine, "attempt-new", "batch-nv", "run-judge")

    with caplog.at_level("WARNING", logger="apo.db"):
        apo_db.init_db()

    assert _schema_versions(sqlite_engine) == LATEST
    assert _attempts_state(sqlite_engine) == {
        **REPAIRED,
        "attempts": [("attempt-new", None, "bundled")],
        "evidence": [],
    }
    assert "1 left out because their Task Run has a newer Attempt" in caplog.text
    apo_db.init_db()
    assert _schema_versions(sqlite_engine) == LATEST


def test_restore_keeps_a_row_already_present(sqlite_engine: Engine) -> None:
    """An id written after the damage keeps its current row."""
    _damaged(sqlite_engine, 51)
    _add_attempt(sqlite_engine, "attempt-1", "batch-v4", "run-v4-a")

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == LATEST
    assert _attempts_state(sqlite_engine) == {
        **REPAIRED,
        "attempts": [("attempt-1", None, "bundled")],
    }
    with sqlite_engine.connect() as conn:
        assert conn.exec_driver_sql(
            "SELECT task_run_id FROM task_execution_attempts"
        ).fetchall() == [("run-v4-a",)]


def test_restore_rolls_back_when_a_reference_still_dangles(sqlite_engine: Engine) -> None:
    _damaged(sqlite_engine, 51)
    _add_attempt(sqlite_engine, "attempt-ghost", "batch-v4", "run-v4-a")
    _without_foreign_keys(
        sqlite_engine,
        "UPDATE task_execution_attempts SET project = 'ghost' WHERE id = 'attempt-ghost'",
    )

    with pytest.raises(RuntimeError, match="dangling foreign keys"):
        apo_db.init_db()

    state = _attempts_state(sqlite_engine)
    assert state["legacy_table"] is True
    assert state["attempts"] == [("attempt-ghost", None, "bundled")]


def test_referencing_only_damage_is_repaired(sqlite_engine: Engine) -> None:
    """A v19 that copied the rows but renamed with foreign keys on: the legacy
    table is gone, and the evidence FK still names it."""
    _pre_v19_database(sqlite_engine)
    with sqlite_engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE schema_migrations")
        conn.exec_driver_sql("DELETE FROM agent_task_result_evidence")
    with sqlite_engine.connect() as conn:
        assert conn.exec_driver_sql("PRAGMA foreign_keys").scalar() == 1
        for (name,) in conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type = 'index'"
            " AND tbl_name = 'task_execution_attempts' AND sql IS NOT NULL"
        ).fetchall():
            conn.exec_driver_sql(f'DROP INDEX "{name}"')
        conn.exec_driver_sql(f"ALTER TABLE task_execution_attempts RENAME TO {LEGACY_ATTEMPTS}")
        SQLModel.metadata.tables["task_execution_attempts"].create(conn)
        columns = ", ".join(
            f'"{row[1]}"'
            for row in conn.exec_driver_sql(f"PRAGMA table_info('{LEGACY_ATTEMPTS}')")
        )
        conn.exec_driver_sql(
            f"INSERT INTO task_execution_attempts ({columns})"
            f" SELECT {columns} FROM {LEGACY_ATTEMPTS}"
        )
        conn.exec_driver_sql(f"DROP TABLE {LEGACY_ATTEMPTS}")
        conn.commit()
    _stamp(sqlite_engine, 51)
    assert _attempts_state(sqlite_engine)["evidence_fk"] == [LEGACY_ATTEMPTS, "agent_task_runs"]

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == LATEST
    assert _attempts_state(sqlite_engine) == {
        **UNTOUCHED,
        "revision_nullable": True,
        "evidence": [],
    }
    with Session(sqlite_engine) as session:
        session.add(_evidence("ev-2", "attempt-1"))
        session.commit()


def test_trigger_on_evidence_survives_repair(sqlite_engine: Engine) -> None:
    _pre_v19_database(sqlite_engine)
    with sqlite_engine.begin() as conn:
        conn.exec_driver_sql("DROP TABLE schema_migrations")
        conn.exec_driver_sql("CREATE TABLE ev_audit (id VARCHAR)")
        conn.exec_driver_sql(
            "CREATE TRIGGER ev_ins AFTER INSERT ON agent_task_result_evidence"
            " BEGIN INSERT INTO ev_audit VALUES (new.id); END"
        )
    _break_like_the_old_v19(sqlite_engine)
    _stamp(sqlite_engine, 51)

    apo_db.init_db()

    with Session(sqlite_engine) as session:
        session.add(_evidence("ev-2", "attempt-1"))
        session.commit()
    with sqlite_engine.connect() as conn:
        assert conn.exec_driver_sql("SELECT id FROM ev_audit").fetchall() == [("ev-2",)]


def test_v19_killed_between_rename_and_create_boots(sqlite_engine: Engine) -> None:
    """#343's v19 committed its RENAME on its own. Killed before the CREATE
    TABLE, it left no attempts table and the legacy table holding every
    attempt index name, which ``create_all`` then failed to create."""
    _pre_v19_database(sqlite_engine)
    indexes = _attempt_indexes(sqlite_engine)
    named = {name for name in indexes if not name.startswith("sqlite_autoindex_")}
    with sqlite_engine.connect() as conn:
        conn.exec_driver_sql(f"ALTER TABLE task_execution_attempts RENAME TO {LEGACY_ATTEMPTS}")
        conn.commit()
    assert named <= _attempt_indexes(sqlite_engine, LEGACY_ATTEMPTS)

    apo_db.init_db()

    assert _schema_versions(sqlite_engine) == LATEST
    assert _attempts_state(sqlite_engine) == {**UNTOUCHED, "revision_nullable": True}
    assert indexes <= _attempt_indexes(sqlite_engine)
    _assert_attempts_rebuilt(sqlite_engine)
