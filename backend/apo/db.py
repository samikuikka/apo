# pyright: reportUnusedCallResult=false

import os
from collections.abc import Callable

from sqlalchemy import event
from sqlalchemy.engine import Connection
from sqlmodel import SQLModel, create_engine, Session

DATA_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "data")
if not os.path.exists(DATA_DIR):
    os.makedirs(DATA_DIR)

SQLITE_FILE_NAME = "apo.db"
DEFAULT_SQLITE_URL = f"sqlite:///{os.path.join(DATA_DIR, SQLITE_FILE_NAME)}"

DATABASE_URL = os.environ.get("DATABASE_URL", DEFAULT_SQLITE_URL)


def _is_sqlite() -> bool:
    return "sqlite" in DATABASE_URL


def _get_engine_kwargs() -> dict[str, object]:
    kwargs: dict[str, object] = {"echo": False}
    if _is_sqlite():
        kwargs["connect_args"] = {"check_same_thread": False}
    if "postgresql" in DATABASE_URL or "postgres" in DATABASE_URL:
        kwargs["pool_size"] = 10
        kwargs["max_overflow"] = 20
    return kwargs


engine = create_engine(DATABASE_URL, **_get_engine_kwargs())


# Production-hardening PRAGMAs applied to every new SQLite connection.
# WAL mode lets concurrent readers coexist with the single writer (the
# request thread plus the batch-runner and scheduler background threads),
# so reads never block writes and vice-versa. busy_timeout makes locked
# writes retry instead of raising SQLITE_BUSY immediately. foreign_keys
# enforces declared FK constraints. synchronous=NORMAL is safe under WAL
# and dramatically faster than the default FULL fsync-per-commit.
if _is_sqlite():

    @event.listens_for(engine, "connect")
    def _set_sqlite_pragmas(dbapi_conn, _connection_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA busy_timeout=5000")
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.close()


def _get_column_names(conn, table_name: str) -> set[str]:
    if _is_sqlite():
        columns = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
        return {col[1] for col in columns}
    columns = conn.exec_driver_sql(
        f"SELECT column_name FROM information_schema.columns "
        f"WHERE table_schema = 'public' AND table_name = '{table_name}'"
    ).fetchall()
    return {col[0] for col in columns}


def _get_table_names(conn) -> set[str]:
    if _is_sqlite():
        tables = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        return {t[0] for t in tables}
    tables = conn.exec_driver_sql(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
    ).fetchall()
    return {t[0] for t in tables}


def _add_column_if_missing(
    conn, table_name: str, column_name: str, column_type: str
) -> bool:
    column_names = _get_column_names(conn, table_name)
    if not column_names:
        return False
    if column_name not in column_names:
        conn.exec_driver_sql(
            f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_type};"
        )
        return True
    return False


def _drop_column_if_exists(conn, table_name: str, column_name: str) -> bool:
    """Drop a column if it exists. No-op when the table or column is absent.

    Modern SQLite (3.35+) supports ``ALTER TABLE DROP COLUMN``; Postgres
    has supported it forever. We guard on the column actually existing so
    re-running the migration is a safe no-op on already-cleaned schemas.
    """
    column_names = _get_column_names(conn, table_name)
    if not column_names:
        return False
    if column_name not in column_names:
        return False
    conn.exec_driver_sql(
        f"ALTER TABLE {table_name} DROP COLUMN {column_name};"
    )
    return True


def _create_index_if_not_exists(conn, index_name: str, table_name: str, columns: str) -> None:
    if _is_sqlite():
        conn.exec_driver_sql(
            f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name}({columns});"
        )
    else:
        conn.exec_driver_sql(
            f"CREATE INDEX IF NOT EXISTS {index_name} ON {table_name}({columns});"
        )


def _create_unique_index_if_not_exists(
    conn, index_name: str, table_name: str, columns: str
) -> None:
    """Create a UNIQUE index if it does not already exist.

    Works for nullable columns: SQL (both SQLite and PostgreSQL) treats each NULL as
    distinct, so multiple rows with NULL are allowed in a UNIQUE index.
    """
    conn.exec_driver_sql(
        f"CREATE UNIQUE INDEX IF NOT EXISTS {index_name} ON {table_name}({columns});"
    )


def _enforce_single_task_trace(conn: Connection) -> None:
    """Keep only the canonical reverse link, then enforce one trace per task run."""
    conn.exec_driver_sql("""
        UPDATE runs
        SET task_run_id = NULL
        WHERE task_run_id IS NOT NULL
          AND id != COALESCE(
              (
                  SELECT trace_run_id
                  FROM agent_task_runs
                  WHERE agent_task_runs.id = runs.task_run_id
              ),
              ''
          );
    """)
    _create_unique_index_if_not_exists(
        conn, "ux_runs_task_run_id", "runs", "task_run_id"
    )


def init_db():
    """
    Initialize database by creating all tables.

    IMPORTANT: We must import all model classes before calling create_all()
    so that SQLModel knows about them and can create the corresponding tables.
    """
    from .models import db as models_db
    from .models import pricing as models_pricing

    assert models_db is not None
    assert models_pricing is not None

    SQLModel.metadata.create_all(engine)
    _run_migrations()
    # SPEC-136 ticket 07: the bundled JSON is the sole source of truth for
    # __global__ pricing. Replaces the old seed_default_models call.
    from .services.pricing.loader import load_default_prices

    with Session(engine) as session:
        _ = load_default_prices(session)


def _migrate_to_baseline():
    """Version 1 baseline migration.

    The historical "lightweight migrations" ladder: idempotent
    ``ADD COLUMN``/``CREATE INDEX`` plus a few raw ``CREATE TABLE``/backfill
    steps for legacy tables that predate the SQLModel models. Runs on every
    fresh database to bring the schema from ``create_all``'s output up to
    the full current shape.

    Idempotent, so re-running on an already-migrated database is a no-op —
    this is what makes it safe as a baseline that existing pre-framework
    databases run exactly once before being stamped at version 1.
    Works across SQLite and PostgreSQL.
    """
    with engine.begin() as conn:
        _add_column_if_missing(conn, "logged_calls", "version", "VARCHAR")
        _add_column_if_missing(conn, "logged_calls", "latency_ms", "FLOAT")
        _add_column_if_missing(conn, "logged_calls", "cost", "INTEGER")  # SPEC-136: micro-USD int

        # Inline-comment selection anchors (nullable; whole-object comments
        # leave them NULL).
        _add_column_if_missing(conn, "comments", "selection_field", "VARCHAR")
        _add_column_if_missing(conn, "comments", "selection_path", "JSON")
        _add_column_if_missing(conn, "comments", "selection_range_start", "JSON")
        _add_column_if_missing(conn, "comments", "selection_range_end", "JSON")
        _add_column_if_missing(conn, "comments", "selected_text", "TEXT")

        run_column_names = _get_column_names(conn, "runs")
        _add_column_if_missing(conn, "runs", "session_id", "VARCHAR")
        _add_column_if_missing(conn, "runs", "environment", "VARCHAR DEFAULT 'default'")
        _add_column_if_missing(conn, "runs", "external_id", "VARCHAR")
        _add_column_if_missing(conn, "runs", "tags", "JSON")
        _add_column_if_missing(conn, "runs", "metadata", "JSON")

        if "primary_model" not in run_column_names:
            conn.exec_driver_sql("ALTER TABLE runs ADD COLUMN primary_model VARCHAR;")
            conn.exec_driver_sql("""
                UPDATE runs
                SET primary_model = (
                    SELECT model FROM logged_calls
                    WHERE logged_calls.run_id = runs.id
                    ORDER BY created_at ASC
                    LIMIT 1
                )
                WHERE primary_model IS NULL;
            """)
            _create_index_if_not_exists(conn, "idx_runs_primary_model", "runs", "primary_model")

        if "bookmarked" not in run_column_names:
            conn.exec_driver_sql(
                "ALTER TABLE runs ADD COLUMN bookmarked INTEGER NOT NULL DEFAULT 0;"
            )
            _create_index_if_not_exists(conn, "ix_runs_bookmarked", "runs", "bookmarked")

        if "is_public" not in run_column_names:
            conn.exec_driver_sql(
                "ALTER TABLE runs ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;"
            )
            _create_index_if_not_exists(conn, "ix_runs_is_public", "runs", "is_public")

        _add_column_if_missing(conn, "runs", "task_run_id", "VARCHAR")
        _create_index_if_not_exists(conn, "ix_runs_task_run_id", "runs", "task_run_id")
        _enforce_single_task_trace(conn)
        _add_column_if_missing(conn, "runs", "input", "JSON")
        _add_column_if_missing(conn, "runs", "output", "JSON")

        _add_column_if_missing(conn, "logged_calls", "parent_call_id", "VARCHAR")
        _add_column_if_missing(
            conn, "logged_calls", "observation_type", "VARCHAR DEFAULT 'GENERATION'"
        )
        _add_column_if_missing(
            conn, "logged_calls", "level", "VARCHAR DEFAULT 'DEFAULT'"
        )
        _add_column_if_missing(conn, "logged_calls", "status_message", "VARCHAR")
        _add_column_if_missing(conn, "logged_calls", "completion_start_time", "DATETIME")
        _add_column_if_missing(conn, "logged_calls", "end_time", "DATETIME")
        _add_column_if_missing(conn, "logged_calls", "prompt_tokens", "INTEGER")
        _add_column_if_missing(conn, "logged_calls", "completion_tokens", "INTEGER")
        _add_column_if_missing(conn, "logged_calls", "session_id", "VARCHAR")
        _add_column_if_missing(
            conn, "logged_calls", "environment", "VARCHAR DEFAULT 'default'"
        )
        _add_column_if_missing(conn, "logged_calls", "tags", "JSON")

        _add_column_if_missing(conn, "logged_calls", "total_tokens", "INTEGER")
        _add_column_if_missing(conn, "logged_calls", "prompt_id", "TEXT")
        _add_column_if_missing(conn, "logged_calls", "prompt_version", "INTEGER")
        _add_column_if_missing(conn, "logged_calls", "provided_cost", "REAL")
        _add_column_if_missing(conn, "logged_calls", "time_to_first_token_ms", "REAL")
        _add_column_if_missing(conn, "logged_calls", "provided_model_name", "TEXT")
        _add_column_if_missing(conn, "logged_calls", "internal_model_id", "TEXT")
        _add_column_if_missing(conn, "logged_calls", "tool_name", "TEXT")
        _add_column_if_missing(conn, "logged_calls", "tool_parameters", "TEXT")
        _add_column_if_missing(conn, "logged_calls", "tool_result", "TEXT")
        _add_column_if_missing(conn, "logged_calls", "corrected_output", "TEXT")

        _create_index_if_not_exists(conn, "idx_runs_session_id", "runs", "session_id")
        _create_index_if_not_exists(conn, "idx_runs_external_id", "runs", "external_id")
        _create_index_if_not_exists(conn, "idx_runs_environment", "runs", "environment")
        _create_index_if_not_exists(
            conn, "idx_calls_parent_call_id", "logged_calls", "parent_call_id"
        )
        _create_index_if_not_exists(
            conn, "idx_calls_observation_type", "logged_calls", "observation_type"
        )
        _create_index_if_not_exists(conn, "idx_calls_session_id", "logged_calls", "session_id")
        _create_index_if_not_exists(conn, "idx_calls_prompt_id", "logged_calls", "prompt_id")
        _create_index_if_not_exists(
            conn, "idx_calls_internal_model_id", "logged_calls", "internal_model_id"
        )
        _create_index_if_not_exists(conn, "idx_calls_tool_name", "logged_calls", "tool_name")

        _create_index_if_not_exists(
            conn, "idx_sessions_environment", "sessions", "environment"
        )
        _create_index_if_not_exists(conn, "idx_sessions_user_id", "sessions", "user_id")
        _create_index_if_not_exists(conn, "idx_sessions_created_at", "sessions", "created_at")

        table_names = _get_table_names(conn)

        if "agent_task_batch_runs" not in table_names:
            conn.exec_driver_sql("""
                CREATE TABLE agent_task_batch_runs (
                    id VARCHAR PRIMARY KEY,
                    project VARCHAR NOT NULL,
                    selection_type VARCHAR NOT NULL,
                    selection_query JSON,
                    task_root VARCHAR,
                    grep VARCHAR,
                    environment VARCHAR DEFAULT 'default',
                    run_metadata JSON,
                    status VARCHAR NOT NULL DEFAULT 'queued',
                    total_tasks INTEGER DEFAULT 0,
                    passed_tasks INTEGER DEFAULT 0,
                    failed_tasks INTEGER DEFAULT 0,
                    errored_tasks INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    started_at DATETIME,
                    completed_at DATETIME
                );
            """)
            _create_index_if_not_exists(
                conn,
                "idx_agent_task_batch_runs_project",
                "agent_task_batch_runs",
                "project",
            )
            _create_index_if_not_exists(
                conn,
                "idx_agent_task_batch_runs_status",
                "agent_task_batch_runs",
                "status",
            )
            _create_index_if_not_exists(
                conn,
                "idx_agent_task_batch_runs_selection_type",
                "agent_task_batch_runs",
                "selection_type",
            )

        if "agent_task_runs" not in table_names:
            conn.exec_driver_sql("""
                CREATE TABLE agent_task_runs (
                    id VARCHAR PRIMARY KEY,
                    batch_run_id VARCHAR NOT NULL REFERENCES agent_task_batch_runs(id),
                    task_id VARCHAR NOT NULL,
                    task_path VARCHAR NOT NULL,
                    adapter_name VARCHAR,
                    status VARCHAR NOT NULL DEFAULT 'pending',
                    pass_result BOOLEAN,
                    started_at DATETIME,
                    completed_at DATETIME,
                    trace_run_id VARCHAR,
                    error_message VARCHAR,
                    checks_json JSON,
                    transcript_json JSON,
                    deliverables_json JSON
                );
            """)
            _create_index_if_not_exists(
                conn,
                "idx_agent_task_runs_batch_run_id",
                "agent_task_runs",
                "batch_run_id",
            )
            _create_index_if_not_exists(
                conn, "idx_agent_task_runs_task_id", "agent_task_runs", "task_id"
            )
            _create_index_if_not_exists(
                conn, "idx_agent_task_runs_status", "agent_task_runs", "status"
            )

        if "model_definitions" not in table_names:
            conn.exec_driver_sql("""
                CREATE TABLE model_definitions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    project VARCHAR DEFAULT '__global__',
                    model_name VARCHAR NOT NULL,
                    match_pattern VARCHAR NOT NULL,
                    provider VARCHAR NOT NULL,
                    input_price REAL DEFAULT 0.0,
                    output_price REAL DEFAULT 0.0,
                    cached_input_price REAL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)
            _create_index_if_not_exists(
                conn, "idx_model_definitions_project", "model_definitions", "project"
            )
            _create_index_if_not_exists(
                conn,
                "idx_model_definitions_model_name",
                "model_definitions",
                "model_name",
            )
            _create_index_if_not_exists(
                conn,
                "idx_model_definitions_match_pattern",
                "model_definitions",
                "match_pattern",
            )
            _create_index_if_not_exists(
                conn, "idx_model_definitions_provider", "model_definitions", "provider"
            )

        _add_column_if_missing(conn, "agent_task_runs", "total_cost", "REAL")
        _add_column_if_missing(conn, "agent_task_runs", "total_tokens", "INTEGER")

        _add_column_if_missing(
            conn,
            "agent_task_runs",
            "trace_persistence_status",
            "VARCHAR DEFAULT 'pending'",
        )
        _add_column_if_missing(conn, "agent_task_runs", "trace_error_message", "VARCHAR")
        _add_column_if_missing(
            conn,
            "agent_task_batch_runs",
            "trace_persistence_status",
            "VARCHAR DEFAULT 'pending'",
        )
        _add_column_if_missing(
            conn, "agent_task_batch_runs", "trace_error_message", "VARCHAR"
        )
        _create_index_if_not_exists(
            conn,
            "idx_agent_task_runs_trace_persistence_status",
            "agent_task_runs",
            "trace_persistence_status",
        )
        _create_index_if_not_exists(
            conn,
            "idx_agent_task_batch_runs_trace_persistence_status",
            "agent_task_batch_runs",
            "trace_persistence_status",
        )

        tables = _get_table_names(conn)

        if "comments" not in tables:
            conn.exec_driver_sql("""
                CREATE TABLE IF NOT EXISTS comments (
                    id TEXT PRIMARY KEY,
                    project_id TEXT NOT NULL,
                    object_id TEXT NOT NULL,
                    object_type TEXT NOT NULL,
                    content TEXT NOT NULL,
                    author_id TEXT,
                    author_name TEXT,
                    parent_comment_id TEXT,
                    mentioned_user_ids TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );
            """)
            _create_index_if_not_exists(
                conn, "ix_comments_object", "comments", "object_id, object_type"
            )

        if "comment_reactions" not in tables:
            conn.exec_driver_sql("""
                CREATE TABLE IF NOT EXISTS comment_reactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    comment_id TEXT NOT NULL REFERENCES comments(id),
                    emoji TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(comment_id, emoji, user_id)
                );
            """)

        _add_column_if_missing(conn, "users", "is_active", "BOOLEAN DEFAULT 1")
        _create_index_if_not_exists(conn, "ix_users_is_active", "users", "is_active")

        _add_column_if_missing(conn, "users", "email_verified_at", "DATETIME")

        _add_column_if_missing(conn, "users", "token_invalid_before", "DATETIME")

        _add_column_if_missing(conn, "api_keys", "scope", "VARCHAR DEFAULT 'full'")

        # SPEC-092: Two-key model columns (public_key + hashed_secret_key + display_secret_key)
        _add_column_if_missing(conn, "api_keys", "public_key", "VARCHAR")
        _add_column_if_missing(conn, "api_keys", "hashed_secret_key", "VARCHAR")
        _add_column_if_missing(conn, "api_keys", "display_secret_key", "VARCHAR DEFAULT ''")
        _create_unique_index_if_not_exists(
            conn, "ix_api_keys_public_key", "api_keys", "public_key"
        )
        _create_unique_index_if_not_exists(
            conn, "ix_api_keys_hashed_secret_key", "api_keys", "hashed_secret_key"
        )

        # SPEC-119: Task source provenance on execution tables. All
        # columns nullable so legacy rows keep rendering unchanged.
        _add_column_if_missing(conn, "agent_task_batch_runs", "task_source_type", "VARCHAR")
        _add_column_if_missing(conn, "agent_task_batch_runs", "task_source_ref", "VARCHAR")
        _add_column_if_missing(conn, "agent_task_batch_runs", "task_source_commit_sha", "VARCHAR")
        _add_column_if_missing(conn, "agent_task_batch_runs", "task_source_subpath", "VARCHAR")

        _add_column_if_missing(conn, "agent_task_runs", "task_inventory_id", "VARCHAR")
        _add_column_if_missing(conn, "agent_task_runs", "task_source_commit_sha", "VARCHAR")
        _create_index_if_not_exists(
            conn,
            "idx_agent_task_runs_task_inventory_id",
            "agent_task_runs",
            "task_inventory_id",
        )

        _add_column_if_missing(conn, "agent_task_schedules", "task_source_type", "VARCHAR")
        _add_column_if_missing(conn, "agent_task_schedules", "task_source_ref", "VARCHAR")
        _add_column_if_missing(conn, "agent_task_schedules", "task_source_subpath", "VARCHAR")

        # SPEC-069: Adaptive (SM-2) scheduling bounds. Defaults match the
        # model so legacy daily/weekly/monthly schedules are unaffected.
        _add_column_if_missing(
            conn, "agent_task_schedules", "min_interval_days", "REAL DEFAULT 1.0"
        )
        _add_column_if_missing(
            conn, "agent_task_schedules", "max_interval_days", "REAL DEFAULT 30.0"
        )
        _create_index_if_not_exists(
            conn,
            "idx_adaptive_task_states_schedule",
            "adaptive_task_states",
            "schedule_id",
        )
        _create_index_if_not_exists(
            conn,
            "idx_adaptive_task_states_next_run",
            "adaptive_task_states",
            "next_run_at",
        )

        # SPEC-122: backfill owner memberships for non-demo projects.
        # The ``project_memberships`` table itself is created by
        # ``SQLModel.metadata.create_all`` once ``ProjectMembershipDB``
        # is registered; this block only handles the legacy-data
        # backfill and the unique index.
        #
        # The backfill SQL uses SQLite-specific ``randomblob()``; skip it
        # on Postgres (fresh Postgres deploys have no legacy projects to
        # backfill, and SQLite→Postgres migration is a separate path).
        tables = _get_table_names(conn)
        if _is_sqlite() and "project_memberships" in tables:
            conn.exec_driver_sql(
                """
                INSERT INTO project_memberships
                    (id, project_id, user_id, role, created_at, updated_at)
                SELECT
                    lower(hex(randomblob(16))),
                    p.id,
                    p.created_by,
                    'owner',
                    p.created_at,
                    p.updated_at
                FROM projects p
                WHERE p.id != 'demo'
                  AND p.created_by IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM project_memberships pm
                      WHERE pm.project_id = p.id
                        AND pm.user_id = p.created_by
                  );
                """
            )
            _create_unique_index_if_not_exists(
                conn,
                "uq_project_membership",
                "project_memberships",
                "project_id, user_id",
            )


# ---------------------------------------------------------------------------
# Versioned migration framework
# ---------------------------------------------------------------------------
#
# Schema evolution is tracked by a tiny ``schema_migrations`` table holding
# the versions applied. Each migration is a numbered, idempotent function
# registered in ``_SCHEMA_MIGRATIONS``; ``_run_migrations`` applies every
# migration newer than the database's current version, then stamps the
# resulting version.
#
# The entire historical ladder lives as the single version-1 baseline
# (``_migrate_to_baseline``) rather than being re-derived into N tiny steps
# — those steps are already deployed and idempotent, so atomising them buys
# risk without value. The seam this introduces is for *future* schema
# changes: add a ``_migrate_to_vN`` function, register it, bump
# ``LATEST_SCHEMA_VERSION``, and it runs exactly once on every database that
# hasn't seen it — instead of appending to a monolithic ladder that re-runs
# on every boot.
#
# Safety of the transition: a pre-framework database has no
# ``schema_migrations`` table, so its version reads as 0. The baseline
# migration runs once (a no-op against already-migrated schemas) and the
# database is stamped at version 1. Subsequent boots skip it entirely.

def _migrate_to_v2() -> None:
    """Version 2: drop legacy criteria columns from the database.

    The criteria/criterion-evaluator system has been fully replaced by
    ``checks.ts`` with ``t.judge``/``t.check`` (persisted as
    ``checks_json``). The ``criteria_json`` column on ``agent_task_runs``
    and the ``has_criterion_evaluator`` column on
    ``project_task_inventory`` are no longer written by any code path.

    This migration drops both columns. Idempotent: each drop is guarded by
    ``_drop_column_if_exists`` so re-running on an already-cleaned
    database is a no-op. Safe on Postgres and on SQLite >=3.35 (which
    every Python shipped in the last few years vendors).
    """
    with engine.begin() as conn:
        _drop_column_if_exists(conn, "agent_task_runs", "criteria_json")
        _drop_column_if_exists(
            conn, "project_task_inventory", "has_criterion_evaluator"
        )


def _migrate_to_v3() -> None:
    """Version 3: enforce one canonical trace link per agent task run."""
    with engine.begin() as conn:
        _enforce_single_task_trace(conn)


def _migrate_to_v4() -> None:
    """Version 4: check-level rollup columns on agent_task_batch_runs.

    Adds ``total_checks`` / ``passed_checks`` — the dashboard pass-rate bar
    uses these for a "how well did it do" metric that's comparable across
    batch sizes (unlike task-level ``passed_tasks``, which is all-or-nothing
    per task and shows a misleading 0% for a near-miss).

    Backfills historical batches from each task run's ``checks_json`` so the
    new metric is accurate everywhere, not just for runs created after this
    migration. Idempotent: re-running recomputes from source data.
    """
    import json

    from sqlalchemy import text

    with engine.begin() as conn:
        added_total = _add_column_if_missing(
            conn, "agent_task_batch_runs", "total_checks", "INTEGER DEFAULT 0"
        )
        added_passed = _add_column_if_missing(
            conn, "agent_task_batch_runs", "passed_checks", "INTEGER DEFAULT 0"
        )
        # Only backfill when at least one column is freshly added — otherwise
        # this is a no-op re-run on an already-correct database, and rewriting
        # live rows would race with the runner's own updates.
        if not (added_total or added_passed):
            return

        batches = conn.exec_driver_sql(
            "SELECT id FROM agent_task_batch_runs"
        ).fetchall()
        for (batch_id,) in batches:
            rows = conn.exec_driver_sql(
                "SELECT checks_json FROM agent_task_runs WHERE batch_run_id = :bid",
                {"bid": batch_id},
            ).fetchall()
            total = 0
            passed = 0
            for (raw,) in rows:
                try:
                    checks = json.loads(raw) if isinstance(raw, str) else raw
                except (ValueError, TypeError):
                    checks = None
                if not isinstance(checks, list):
                    continue
                total += len(checks)
                passed += sum(
                    1 for c in checks if isinstance(c, dict) and c.get("pass") is True
                )
            conn.execute(
                text(
                    "UPDATE agent_task_batch_runs "
                    "SET total_checks = :total, passed_checks = :passed "
                    "WHERE id = :bid"
                ),
                {"total": total, "passed": passed, "bid": batch_id},
            )


def _migrate_to_v5() -> None:
    """Version 5: retain the verified Task Run claim on queued OTLP batches."""
    with engine.begin() as conn:
        _add_column_if_missing(
            conn, "otlp_ingest_batches", "verified_task_run_id", "VARCHAR"
        )
        _create_index_if_not_exists(
            conn,
            "ix_otlp_ingest_batches_verified_task_run_id",
            "otlp_ingest_batches",
            "verified_task_run_id",
        )


def _migrate_to_v6() -> None:
    """Version 6: add a lease timestamp for durable queue recovery."""
    with engine.begin() as conn:
        _add_column_if_missing(
            conn, "otlp_ingest_batches", "processing_started_at", "DATETIME"
        )


def _migrate_to_v7() -> None:
    """Version 7: persist Project-owned OTLP content retention policy."""
    with engine.begin() as conn:
        _add_column_if_missing(
            conn,
            "projects",
            "trace_content_policy",
            "VARCHAR NOT NULL DEFAULT 'redacted'",
        )
        _add_column_if_missing(
            conn,
            "otlp_ingest_batches",
            "content_policy",
            "VARCHAR NOT NULL DEFAULT 'redacted'",
        )


def _migrate_to_v8() -> None:
    """Version 8: make Trace Projection storage identity Project-scoped."""
    with engine.begin() as conn:
        _add_column_if_missing(
            conn,
            "otlp_spans",
            "content_policy",
            "VARCHAR NOT NULL DEFAULT 'redacted'",
        )
        if _is_sqlite():
            _migrate_projection_identity_sqlite(conn)
        else:
            _migrate_projection_identity_postgres(conn)


def _migrate_projection_identity_sqlite(conn: Connection) -> None:
    """Rebuild projection tables because SQLite cannot replace a primary key."""
    tables = _get_table_names(conn)
    if not {"runs", "logged_calls"}.issubset(tables):
        return

    runs_pk = _sqlite_primary_key_columns(conn, "runs")
    calls_pk = _sqlite_primary_key_columns(conn, "logged_calls")
    if runs_pk == ["row_id"] and calls_pk == ["row_id"]:
        return

    from .models import db as models_db

    assert models_db is not None

    target_tables = (
        SQLModel.metadata.tables["runs"],
        SQLModel.metadata.tables["logged_calls"],
        SQLModel.metadata.tables["run_metrics"],
        SQLModel.metadata.tables["call_metrics"],
    )
    existing_targets = [table for table in target_tables if table.name in tables]

    # Rename children first. Renaming the parents then updates any legacy child
    # foreign keys to reference the renamed parent tables.
    for table in reversed(existing_targets):
        conn.exec_driver_sql(
            f'ALTER TABLE "{table.name}" RENAME TO "{table.name}_pre_v8"'
        )

    for table in existing_targets:
        _drop_sqlite_named_indexes(conn, f"{table.name}_pre_v8")

    for table in target_tables:
        table.create(bind=conn, checkfirst=True)

    for table in existing_targets:
        legacy_name = f"{table.name}_pre_v8"
        old_columns = _get_column_names(conn, legacy_name)
        copy_columns = [
            column.name
            for column in table.columns
            if column.name in old_columns and column.name != "row_id"
        ]
        quoted_columns = ", ".join(f'"{name}"' for name in copy_columns)
        conn.exec_driver_sql(
            f'INSERT INTO "{table.name}" ({quoted_columns}) '
            f'SELECT {quoted_columns} FROM "{legacy_name}"'
        )

    for table in reversed(existing_targets):
        conn.exec_driver_sql(f'DROP TABLE "{table.name}_pre_v8"')


def _migrate_projection_identity_postgres(conn: Connection) -> None:
    """Replace global public-ID primary keys with internal surrogate keys."""
    foreign_keys = conn.exec_driver_sql(
        "SELECT child.relname, constraint_row.conname "
        "FROM pg_constraint AS constraint_row "
        "JOIN pg_class AS child ON child.oid = constraint_row.conrelid "
        "WHERE constraint_row.contype = 'f' "
        "AND constraint_row.confrelid IN "
        "(to_regclass('runs'), to_regclass('logged_calls'))"
    ).fetchall()
    for table_ref, constraint_ref in foreign_keys:
        table_name = str(table_ref).replace('"', '""')
        constraint_name = str(constraint_ref).replace('"', '""')
        conn.exec_driver_sql(
            f'ALTER TABLE "{table_name}" DROP CONSTRAINT "{constraint_name}"'
        )

    for table_name in ("runs", "logged_calls"):
        if table_name not in _get_table_names(conn):
            continue
        if "row_id" not in _get_column_names(conn, table_name):
            conn.exec_driver_sql(
                f'ALTER TABLE "{table_name}" ADD COLUMN row_id BIGSERIAL'
            )

        primary_key = conn.exec_driver_sql(
            "SELECT conname, pg_get_constraintdef(oid) "
            "FROM pg_constraint "
            "WHERE conrelid = to_regclass(:table_name) AND contype = 'p'",
            {"table_name": table_name},
        ).first()
        if primary_key is not None and "row_id" not in primary_key[1]:
            constraint_name = str(primary_key[0]).replace('"', '""')
            conn.exec_driver_sql(
                f'ALTER TABLE "{table_name}" DROP CONSTRAINT "{constraint_name}"'
            )
        conn.exec_driver_sql(
            f'ALTER TABLE "{table_name}" ALTER COLUMN row_id SET NOT NULL'
        )
        current_pk = conn.exec_driver_sql(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conrelid = to_regclass(:table_name) AND contype = 'p'",
            {"table_name": table_name},
        ).scalar_one_or_none()
        if current_pk is None:
            conn.exec_driver_sql(
                f'ALTER TABLE "{table_name}" ADD PRIMARY KEY (row_id)'
            )

    _create_unique_index_if_not_exists(
        conn, "uq_runs_project_trace", "runs", "project, id"
    )
    _create_unique_index_if_not_exists(
        conn, "uq_logged_calls_project_span", "logged_calls", "project, id"
    )


def _sqlite_primary_key_columns(conn: Connection, table_name: str) -> list[str]:
    rows = conn.exec_driver_sql(f"PRAGMA table_info('{table_name}')").fetchall()
    return [str(row[1]) for row in sorted(rows, key=lambda row: row[5]) if row[5]]


def _drop_sqlite_named_indexes(conn: Connection, table_name: str) -> None:
    for row in conn.exec_driver_sql(f"PRAGMA index_list('{table_name}')").fetchall():
        index_name = str(row[1])
        if not index_name.startswith("sqlite_autoindex_"):
            escaped = index_name.replace('"', '""')
            conn.exec_driver_sql(f'DROP INDEX "{escaped}"')


def _migrate_to_v9() -> None:
    """Version 9: add Project scope to metric tables (SPEC-133 M4).

    RunMetricDB/CallMetricDB previously referenced runs/logged_calls by the public
    OTel ID only. Post-v8 that ID is no longer globally unique, so every metric
    query needs Project scope. Adding a denormalized ``project`` column lets metric
    rows resolve without a join, mirroring the projection-table identity (ADR-0002).
    """
    with engine.begin() as conn:
        if "run_metrics" in _get_table_names(conn) and "project" not in _get_column_names(
            conn, "run_metrics"
        ):
            _add_metric_project_column(conn, "run_metrics", "run_id")
        if "call_metrics" in _get_table_names(conn) and "project" not in _get_column_names(
            conn, "call_metrics"
        ):
            _add_metric_project_column(conn, "call_metrics", "call_id")


def _migrate_to_v10() -> None:
    """Version 10: cost system redesign (SPEC-136 ticket 09, big-bang).

    Thin wrapper that opens the module engine transaction; the real work is in
    ``_migrate_cost_schema(conn)`` so the migration is directly testable
    against a hand-rolled old-schema engine.
    """
    with engine.begin() as conn:
        _migrate_cost_schema(conn)


def _migrate_cost_schema(conn: Connection) -> None:
    """The v10 cost migration, runnable against any connection.

    1. The new 3-table pricing shape (models, pricing_tiers, prices) is created
       by ``SQLModel.metadata.create_all`` (these tables are new, so create_all
       is enough; no ALTER needed here).
    2. Add the new ``logged_calls`` cost columns (cost_breakdown, raw_usage,
       matched_tier_id, matched_tier_name, cost_provenance).
    3. Transform existing ``cost`` and ``provided_cost``: float-USD ->
       INTEGER micro-USD via ``ROUND(v * 1000000)`` (idempotent guard: only when
       the value is < 1e6, i.e. still in USD scale).
    4. Drop ``calculated_cost`` (replaced by the provenance flag).
    5. Drop the old ``model_definitions`` table (the JSON loader seeds fresh).

    ``internal_model_id`` already exists as TEXT; historical client-supplied
    free-form strings don't map to the new models.id, so existing values are
    nulled (new calls get the real id at compute time).
    """
    if "logged_calls" not in _get_table_names(conn):
        return  # nothing to migrate (baseline create handles it)

    cols = _get_column_names(conn, "logged_calls")

    # New cost-storage columns.
    _add_column_if_missing(conn, "logged_calls", "cost_breakdown", "TEXT")
    _add_column_if_missing(conn, "logged_calls", "raw_usage", "TEXT")
    _add_column_if_missing(conn, "logged_calls", "matched_tier_id", "INTEGER")
    _add_column_if_missing(conn, "logged_calls", "matched_tier_name", "TEXT")
    _add_column_if_missing(conn, "logged_calls", "cost_provenance", "TEXT")

    # float-USD -> micro-USD int via ROUND(v * 1000000). Idempotency is
    # guaranteed by the schema-version stamp (v10 runs once per DB), NOT by
    # value inspection: a USD value and a micro-USD value are not reliably
    # distinguishable by magnitude, so there is no safe re-run guard here.
    # SQLite ROUND() returns a float; the value is a whole number, so int() in
    # the model layer reads it back cleanly.
    conn.exec_driver_sql(
        "UPDATE logged_calls SET cost = ROUND(cost * 1000000) WHERE cost IS NOT NULL"
    )
    conn.exec_driver_sql(
        "UPDATE logged_calls SET provided_cost = ROUND(provided_cost * 1000000) "
        "WHERE provided_cost IS NOT NULL"
    )

    # Null legacy internal_model_id values (free-form strings, not FKs).
    conn.exec_driver_sql(
        "UPDATE logged_calls SET internal_model_id = NULL WHERE internal_model_id IS NOT NULL"
    )

    # Drop calculated_cost (replaced by cost_provenance).
    if "calculated_cost" in cols:
        _drop_column_if_exists(conn, "logged_calls", "calculated_cost")

    # Drop the old flat model_definitions table (JSON loader seeds fresh).
    if "model_definitions" in _get_table_names(conn):
        conn.exec_driver_sql("DROP TABLE IF EXISTS model_definitions")


def _add_metric_project_column(conn: Connection, table_name: str, id_column: str) -> None:
    """Add and backfill ``project`` on a metric table from its projection row.

    ``project`` is a new column, so an ``ALTER TABLE ADD COLUMN`` + ``UPDATE``
    backfill works on both engines. The reference projection table owns the same
    OTel id under the column name ``id`` (it is not a foreign key).

    Pre-v9 data had no uniqueness constraint, so duplicate ``(id, metric_name,
    metric_type)`` rows may exist (and cross-project trace-id collisions resolve
    ambiguously to ``default``). We collapse duplicates to the latest row per
    scope before creating the unique index, keeping the most recent value.
    """
    reference_table = "runs" if table_name == "run_metrics" else "logged_calls"
    if _is_sqlite():
        conn.exec_driver_sql(
            f'ALTER TABLE "{table_name}" ADD COLUMN project VARCHAR NOT NULL DEFAULT \'default\''
        )
    else:
        conn.exec_driver_sql(
            f'ALTER TABLE "{table_name}" ADD COLUMN project VARCHAR NOT NULL DEFAULT \'default\''
        )
    conn.exec_driver_sql(
        f"""
        UPDATE "{table_name}"
        SET project = COALESCE(
            (SELECT ref.project
             FROM "{reference_table}" AS ref
             WHERE ref."id" = "{table_name}"."{id_column}"),
            'default'
        )
        """
    )
    conn.exec_driver_sql(
        f"""
        DELETE FROM "{table_name}"
        WHERE id NOT IN (
            SELECT MAX(id)
            FROM "{table_name}"
            GROUP BY project, "{id_column}", metric_name, metric_type
        )
        """
    )
    index_name = (
        "uq_run_metrics_scope" if table_name == "run_metrics" else "uq_call_metrics_scope"
    )
    _create_unique_index_if_not_exists(
        conn,
        index_name,
        table_name,
        f"project, {id_column}, metric_name, metric_type",
    )


LATEST_SCHEMA_VERSION = 10

_SCHEMA_MIGRATIONS: dict[int, Callable[[], None]] = {
    1: _migrate_to_baseline,
    2: _migrate_to_v2,
    3: _migrate_to_v3,
    4: _migrate_to_v4,
    5: _migrate_to_v5,
    6: _migrate_to_v6,
    7: _migrate_to_v7,
    8: _migrate_to_v8,
    9: _migrate_to_v9,
    10: _migrate_to_v10,
}


def _ensure_schema_migrations_table(conn) -> None:
    conn.exec_driver_sql(
        "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER NOT NULL)"
    )


def _get_schema_version(conn) -> int:
    row = conn.exec_driver_sql(
        "SELECT MAX(version) FROM schema_migrations"
    ).scalar()
    return int(row) if row is not None else 0


def _record_schema_version(conn, version: int) -> None:
    conn.exec_driver_sql(
        f"INSERT INTO schema_migrations (version) VALUES ({int(version)})"
    )


def _run_migrations() -> None:
    """Apply every registered migration newer than the DB's current version."""
    with engine.begin() as conn:
        _ensure_schema_migrations_table(conn)
        version = _get_schema_version(conn)

    while version < LATEST_SCHEMA_VERSION:
        next_version = version + 1
        migration_fn = _SCHEMA_MIGRATIONS.get(next_version)
        if migration_fn is None:
            # Gap in the migration chain — stop rather than skip silently.
            break
        # Each migration is self-contained (opens its own transaction) so a
        # failure in migration N leaves the DB stamped at N-1, not half-applied.
        migration_fn()
        with engine.begin() as conn:
            _record_schema_version(conn, next_version)
        version = next_version


async def get_session():
    with Session(engine) as session:
        yield session
