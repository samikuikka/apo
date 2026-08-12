# pyright: reportUnusedCallResult=false

import os
from collections.abc import Callable

from sqlalchemy import bindparam, event, text
from sqlalchemy.engine import Connection
from sqlalchemy.pool import NullPool
from sqlmodel import JSON, SQLModel, create_engine, Session

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
        # Sync sessions are used from async routes. A bounded QueuePool can
        # deadlock the event loop when a request burst fills the pool: the next
        # checkout blocks the loop, so completed responses cannot close their
        # sessions and return connections. SQLite connections are cheap; avoid
        # that shared capacity ceiling and let each request close its own.
        kwargs["poolclass"] = NullPool
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


def _migrate_task_catalog_columns():
    """Add Task Catalog columns to project_task_sources if absent."""
    with engine.connect() as conn:
        for col, coltype in [
            ("catalog_digest", "TEXT"),
            ("task_count", "INTEGER"),
            ("published_at", "DATETIME"),
            ("published_by_user_id", "TEXT"),
        ]:
            try:
                conn.exec_driver_sql(
                    f"ALTER TABLE project_task_sources ADD COLUMN {col} {coltype}"
                )
            except Exception:
                pass  # Column already exists
        conn.commit()


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
    _migrate_task_catalog_columns()
    # the bundled JSON is the sole source of truth for
    # __global__ pricing. Replaces the old seed_default_models call.
    from .services.pricing.loader import load_default_prices

    with Session(engine) as session:
        _ = load_default_prices(session)


def reset_apo_file_db() -> None:
    """Drop every table on the configured engine and re-run ``init_db``.

    Test modules that import ``apo.db.engine`` directly and call ``init_db``
    share one (file-backed) database. ``init_db`` is idempotent — it creates
    tables if missing but never clears rows — so data accumulates across test
    files/runs and causes UNIQUE/FK violations (e.g. a stale ``batch-run-1``).
    Dropping all tables first gives each test a clean schema. Safe to call
    repeatedly; intended for the test suite, not production request paths.
    """
    SQLModel.metadata.drop_all(engine)
    init_db()


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
    timestamp_type = "DATETIME" if _is_sqlite() else "TIMESTAMPTZ"
    auto_increment_pk = (
        "INTEGER PRIMARY KEY AUTOINCREMENT"
        if _is_sqlite()
        else "SERIAL PRIMARY KEY"
    )
    boolean_true = "1" if _is_sqlite() else "TRUE"

    with engine.begin() as conn:
        _add_column_if_missing(conn, "logged_calls", "version", "VARCHAR")
        _add_column_if_missing(conn, "logged_calls", "latency_ms", "FLOAT")
        _add_column_if_missing(conn, "logged_calls", "cost", "INTEGER")  # micro-USD int

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
        _add_column_if_missing(
            conn,
            "logged_calls",
            "completion_start_time",
            timestamp_type,
        )
        _add_column_if_missing(conn, "logged_calls", "end_time", timestamp_type)
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
            conn.exec_driver_sql(f"""
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
                    created_at {timestamp_type} DEFAULT CURRENT_TIMESTAMP,
                    started_at {timestamp_type},
                    completed_at {timestamp_type}
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
            conn.exec_driver_sql(f"""
                CREATE TABLE agent_task_runs (
                    id VARCHAR PRIMARY KEY,
                    batch_run_id VARCHAR NOT NULL REFERENCES agent_task_batch_runs(id),
                    task_id VARCHAR NOT NULL,
                    task_path VARCHAR NOT NULL,
                    adapter_name VARCHAR,
                    status VARCHAR NOT NULL DEFAULT 'pending',
                    pass_result BOOLEAN,
                    started_at {timestamp_type},
                    completed_at {timestamp_type},
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
            conn.exec_driver_sql(f"""
                CREATE TABLE model_definitions (
                    id {auto_increment_pk},
                    project VARCHAR DEFAULT '__global__',
                    model_name VARCHAR NOT NULL,
                    match_pattern VARCHAR NOT NULL,
                    provider VARCHAR NOT NULL,
                    input_price REAL DEFAULT 0.0,
                    output_price REAL DEFAULT 0.0,
                    cached_input_price REAL,
                    created_at {timestamp_type} DEFAULT CURRENT_TIMESTAMP,
                    updated_at {timestamp_type} DEFAULT CURRENT_TIMESTAMP
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
            conn.exec_driver_sql(f"""
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
                    created_at {timestamp_type} DEFAULT CURRENT_TIMESTAMP,
                    updated_at {timestamp_type} DEFAULT CURRENT_TIMESTAMP
                );
            """)
            _create_index_if_not_exists(
                conn, "ix_comments_object", "comments", "object_id, object_type"
            )

        if "comment_reactions" not in tables:
            conn.exec_driver_sql(f"""
                CREATE TABLE IF NOT EXISTS comment_reactions (
                    id {auto_increment_pk},
                    comment_id TEXT NOT NULL REFERENCES comments(id),
                    emoji TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    created_at {timestamp_type} DEFAULT CURRENT_TIMESTAMP,
                    UNIQUE(comment_id, emoji, user_id)
                );
            """)

        _add_column_if_missing(
            conn,
            "users",
            "is_active",
            f"BOOLEAN DEFAULT {boolean_true}",
        )
        _create_index_if_not_exists(conn, "ix_users_is_active", "users", "is_active")

        _add_column_if_missing(
            conn,
            "users",
            "email_verified_at",
            timestamp_type,
        )

        _add_column_if_missing(
            conn,
            "users",
            "token_invalid_before",
            timestamp_type,
        )

        _add_column_if_missing(conn, "api_keys", "scope", "VARCHAR DEFAULT 'full'")

        # Two-key model columns (public_key + hashed_secret_key + display_secret_key)
        _add_column_if_missing(conn, "api_keys", "public_key", "VARCHAR")
        _add_column_if_missing(conn, "api_keys", "hashed_secret_key", "VARCHAR")
        _add_column_if_missing(conn, "api_keys", "display_secret_key", "VARCHAR DEFAULT ''")
        _create_unique_index_if_not_exists(
            conn, "ix_api_keys_public_key", "api_keys", "public_key"
        )
        _create_unique_index_if_not_exists(
            conn, "ix_api_keys_hashed_secret_key", "api_keys", "hashed_secret_key"
        )

        # Task source provenance on execution tables. All
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

        # Adaptive (SM-2) scheduling bounds. Defaults match the
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

        # backfill owner memberships for non-demo projects.
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

        primary_key = conn.execute(
            text(
                "SELECT conname, pg_get_constraintdef(oid) "
                "FROM pg_constraint "
                "WHERE conrelid = to_regclass(:table_name) AND contype = 'p'"
            ),
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
        current_pk = conn.execute(
            text(
                "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
                "WHERE conrelid = to_regclass(:table_name) AND contype = 'p'"
            ),
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
    """Version 9: add Project scope to metric tables.

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
    """Version 10: cost system redesign.

    Thin wrapper that opens the module engine transaction; the real work is in
    ``_migrate_cost_schema(conn)`` so the migration is directly testable
    against a hand-rolled old-schema engine.
    """
    with engine.begin() as conn:
        _migrate_cost_schema(conn)


def _migrate_to_v11() -> None:
    """Version 11: Task Run Deliverables table.

    Thin wrapper that opens the module engine transaction; the real work is in
    ``_migrate_deliverable_schema(conn)`` so the migration is directly testable
    against a hand-rolled old-schema engine.
    """
    with engine.begin() as conn:
        _migrate_deliverable_schema(conn)


def _migrate_to_v12() -> None:
    """Version 12: Task Revisions table.

    Thin wrapper that opens the module engine transaction; the real work is in
    ``_migrate_task_revision_schema(conn)`` so the migration is directly
    testable against a hand-rolled old-schema engine.
    """
    with engine.begin() as conn:
        _migrate_task_revision_schema(conn)


def _migrate_to_v13() -> None:
    """Version 13: Execution Control Plane tables.

    Pools, Executors, enrollment tokens, Execution Attempts, plus
    execution_target_json/cancelled_tasks/sequence_index/default_executor_pool_id.
    Thin wrapper; the real work is in ``_migrate_execution_schema(conn)``.
    """
    with engine.begin() as conn:
        _migrate_execution_schema(conn)


def _migrate_to_v14() -> None:
    """Version 14: schedule Pool target + queue policy.

    Adds ``executor_pool_id`` / ``queue_ttl_seconds`` / ``disabled_reason`` to
    ``agent_task_schedules``. No backfill body here — Bundled Pool/default
    backfill is an operator/feature-flag step; historical schedules keep a null
    Pool and are disabled with ``executor_pool_required`` when first evaluated.
    """
    with engine.begin() as conn:
        _migrate_schedule_pool_schema(conn)


def _migrate_to_v15() -> None:
    """Version 15: Task Run Configuration columns.

    Thin wrapper that opens the module engine transaction; the real work is in
    ``_migrate_run_configuration_schema(conn)`` so the migration is directly
    testable against a hand-rolled old-schema engine.
    """
    with engine.begin() as conn:
        _migrate_run_configuration_schema(conn)


def _migrate_source_owned_executor_schema(conn: Connection) -> None:
    """The v16 source-owned executor migration, runnable against any connection.

    Adds columns for member-owned executor identity, system-managed pools,
    source-owned assignment routing, and per-attempt revisions.
    """
    # executors.enrolled_by_user_id
    _add_column_if_missing(conn, "executors", "enrolled_by_user_id", "VARCHAR")
    _create_index_if_not_exists(conn, "ix_executors_enrolled_by_user_id", "executors", "enrolled_by_user_id")

    # executor_pools.system_managed
    _add_column_if_missing(conn, "executor_pools", "system_managed", "BOOLEAN DEFAULT 0")
    _create_index_if_not_exists(conn, "ix_executor_pools_system_managed", "executor_pools", "system_managed")

    # agent_task_batch_runs.requested_by_user_id
    _add_column_if_missing(conn, "agent_task_batch_runs", "requested_by_user_id", "VARCHAR")
    _create_index_if_not_exists(conn, "ix_agent_task_batch_runs_requested_by", "agent_task_batch_runs", "requested_by_user_id")

    # task_execution_attempts.task_revision_id is already non-nullable in v15.
    # SQLite can't ALTER COLUMN to make it nullable, but SQLModel.create_all
    # creates fresh tables with the new nullable definition. For existing
    # databases, the model accepts None and SQLite doesn't enforce NOT NULL
    # at the ORM level for columns added via migration. This is a known
    # SQLite migration seam documented in the spec.

    # task_execution_attempts.assignment_kind
    _add_column_if_missing(conn, "task_execution_attempts", "assignment_kind", "VARCHAR DEFAULT 'bundled'")
    _create_index_if_not_exists(conn, "ix_task_attempt_assignment_kind", "task_execution_attempts", "assignment_kind")

    # task_execution_attempts.target_user_id
    _add_column_if_missing(conn, "task_execution_attempts", "target_user_id", "VARCHAR")
    _create_index_if_not_exists(conn, "ix_task_attempt_target_user_id", "task_execution_attempts", "target_user_id")

    # Backfill assignment_kind from target_kind for existing rows
    conn.exec_driver_sql(
        "UPDATE task_execution_attempts SET assignment_kind = 'caller' WHERE target_kind = 'caller' AND assignment_kind = 'bundled'"
    )

    # Source-owned claim index
    _create_index_if_not_exists(
        conn,
        "ix_task_attempt_source_owned_claim",
        "task_execution_attempts",
        "status, assignment_kind, executor_pool_id, target_user_id, queued_at",
    )


def _migrate_to_v16() -> None:
    """Version 16: Source-Owned Connected Executor.

    Adds executor ownership, system-managed pools, assignment routing,
    and per-attempt revision columns.
    """
    with engine.begin() as conn:
        _migrate_source_owned_executor_schema(conn)


def _migrate_executor_heartbeat_observations(conn: Connection) -> None:
    """The v17 source-owned heartbeat observations migration.

    Persists the latest protocol-v2 catalog digest and reported available
    slots. Existing Executors backfill to NULL. Idempotent.
    """
    _add_column_if_missing(conn, "executors", "reported_catalog_digest", "VARCHAR")
    _create_index_if_not_exists(
        conn, "ix_executors_reported_catalog_digest", "executors", "reported_catalog_digest"
    )
    _add_column_if_missing(conn, "executors", "reported_available_slots", "INTEGER")


def _migrate_to_v17() -> None:
    """Version 17: persist source-owned heartbeat observations."""
    with engine.begin() as conn:
        _migrate_executor_heartbeat_observations(conn)


def _migrate_schedule_source_owned_schema(conn: Connection) -> None:
    """The v18 source-owned scheduled delivery migration.

    Adds schedule execution kind/owner/active-batch columns, backfills every
    existing row to ``bundled`` (no inferred owner), and creates the durable
    Schedule Occurrence table. Idempotent on SQLite.
    """
    _add_column_if_missing(
        conn, "agent_task_schedules", "execution_kind", "VARCHAR NOT NULL DEFAULT 'bundled'"
    )
    _create_index_if_not_exists(
        conn, "ix_agent_task_schedules_execution_kind", "agent_task_schedules", "execution_kind"
    )
    _add_column_if_missing(conn, "agent_task_schedules", "execution_owner_user_id", "VARCHAR")
    _create_index_if_not_exists(
        conn,
        "ix_agent_task_schedules_execution_owner_user_id",
        "agent_task_schedules",
        "execution_owner_user_id",
    )
    _add_column_if_missing(conn, "agent_task_schedules", "active_batch_run_id", "VARCHAR")
    _create_index_if_not_exists(
        conn,
        "ix_agent_task_schedules_active_batch_run_id",
        "agent_task_schedules",
        "active_batch_run_id",
    )

    ts = "DATETIME" if _is_sqlite() else "TIMESTAMPTZ"
    conn.exec_driver_sql(
        f"""
        CREATE TABLE IF NOT EXISTS agent_task_schedule_occurrences (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            schedule_id VARCHAR NOT NULL,
            schedule_name VARCHAR NOT NULL,
            kind VARCHAR NOT NULL,
            scheduled_for {ts} NOT NULL,
            status VARCHAR NOT NULL,
            batch_run_id VARCHAR UNIQUE,
            missed_reason VARCHAR,
            created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
            resolved_at {ts}
        )
        """
    )
    _create_index_if_not_exists(
        conn, "ix_schedule_occurrences_project", "agent_task_schedule_occurrences", "project"
    )
    _create_index_if_not_exists(
        conn, "ix_schedule_occurrences_schedule_id", "agent_task_schedule_occurrences", "schedule_id"
    )
    _create_index_if_not_exists(
        conn, "ix_schedule_occurrences_kind", "agent_task_schedule_occurrences", "kind"
    )
    _create_index_if_not_exists(
        conn, "ix_schedule_occurrences_scheduled_for", "agent_task_schedule_occurrences", "scheduled_for"
    )
    _create_index_if_not_exists(
        conn, "ix_schedule_occurrences_status", "agent_task_schedule_occurrences", "status"
    )
    _create_index_if_not_exists(
        conn, "ix_schedule_occurrences_batch_run_id", "agent_task_schedule_occurrences", "batch_run_id"
    )
    _create_unique_index_if_not_exists(
        conn,
        "uq_schedule_occurrence_time",
        "agent_task_schedule_occurrences",
        "schedule_id, kind, scheduled_for",
    )
    _create_index_if_not_exists(
        conn,
        "ix_schedule_occurrence_status",
        "agent_task_schedule_occurrences",
        "schedule_id, status",
    )


def _migrate_to_v18() -> None:
    """Version 18: source-owned scheduled delivery."""
    with engine.begin() as conn:
        _migrate_schedule_source_owned_schema(conn)


def _make_attempt_task_revision_nullable(conn: Connection) -> None:
    """Make task_execution_attempts.task_revision_id nullable.

    The v13 migration created it NOT NULL; a later change made the SQLModel field
    nullable (source-owned Attempts have no Revision until /start) but never
    changed the existing database constraint. This migration closes that gap.

    PostgreSQL: ``ALTER COLUMN ... DROP NOT NULL``.
    SQLite: ``ALTER COLUMN`` is unavailable, so rebuild the table from current
    metadata and copy every row without transformation. Idempotent on both.
    """
    if "task_execution_attempts" not in _get_table_names(conn):
        return

    # Already nullable? No-op.
    cols = conn.exec_driver_sql("PRAGMA table_info('task_execution_attempts')").fetchall()
    if not cols:
        # PostgreSQL path — check information_schema
        result = conn.exec_driver_sql(
            "SELECT is_nullable FROM information_schema.columns "
            "WHERE table_name = 'task_execution_attempts' AND column_name = 'task_revision_id'"
        ).fetchone()
        if result and str(result[0]).upper() == "YES":
            return
    else:
        # SQLite path
        for row in cols:
            if row[1] == "task_revision_id" and str(row[3]) == "0":
                # notnull flag is 0 → already nullable
                return
        # Check if task_revision_id column exists at all
        if not any(row[1] == "task_revision_id" for row in cols):
            return

    if _is_sqlite():
        # SQLite: rebuild the table from current metadata.
        # 1. Drop indexes that reference the table so they can be recreated
        existing_indexes = conn.exec_driver_sql(
            "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='task_execution_attempts'"
        ).fetchall()
        for idx_row in existing_indexes:
            idx_name = idx_row[0]
            if idx_name and not idx_name.startswith("sqlite_"):
                conn.exec_driver_sql(f"DROP INDEX IF EXISTS \"{idx_name}\"")

        # 2. Rename the legacy table
        conn.exec_driver_sql(
            "ALTER TABLE task_execution_attempts RENAME TO _task_execution_attempts_v18_legacy"
        )

        # 3. Create the table from current SQLModel metadata (nullable field)
        from sqlmodel import SQLModel
        from apo.models import db as models_db  # noqa: F401 - registers models

        _ = models_db
        TaskExecutionAttemptDB_meta = SQLModel.metadata.tables.get("task_execution_attempts")
        if TaskExecutionAttemptDB_meta is not None:
            TaskExecutionAttemptDB_meta.create(conn)

        # 4. Copy every row without transformation
        conn.exec_driver_sql(
            "INSERT INTO task_execution_attempts SELECT * FROM _task_execution_attempts_v18_legacy"
        )

        # 5. Drop the temporary table
        conn.exec_driver_sql("DROP TABLE _task_execution_attempts_v18_legacy")
    else:
        # PostgreSQL: simple ALTER COLUMN
        conn.exec_driver_sql(
            "ALTER TABLE task_execution_attempts ALTER COLUMN task_revision_id DROP NOT NULL"
        )


def _migrate_to_v19() -> None:
    """Version 19: make Attempt task_revision_id nullable (SPEC-166, issues #83/#84)."""
    with engine.begin() as conn:
        _make_attempt_task_revision_nullable(conn)


def _migrate_task_definition_revisions(conn: Connection) -> None:
    """SPEC-169: Task Definition Revisions table + nullable FK pointers."""
    ts = "DATETIME" if _is_sqlite() else "TIMESTAMPTZ"
    conn.exec_driver_sql(
        f"""
        CREATE TABLE IF NOT EXISTS task_definition_revisions (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            task_id VARCHAR NOT NULL,
            schema_version INTEGER NOT NULL DEFAULT 1,
            content_sha256 VARCHAR NOT NULL,
            source_files_json JSON,
            source_size_bytes INTEGER NOT NULL,
            created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    _create_index_if_not_exists(conn, "ix_task_def_rev_project", "task_definition_revisions", "project")
    _create_index_if_not_exists(conn, "ix_task_def_rev_task_id", "task_definition_revisions", "task_id")
    _create_index_if_not_exists(conn, "ix_task_def_rev_digest", "task_definition_revisions", "content_sha256")
    _create_unique_index_if_not_exists(
        conn, "uq_task_definition_revision_identity",
        "task_definition_revisions", "project, task_id, content_sha256",
    )

    # Nullable FK pointers on existing tables
    _add_column_if_missing(conn, "agent_task_runs", "task_definition_revision_id", "VARCHAR")
    _create_index_if_not_exists(conn, "ix_agent_task_runs_task_def_rev", "agent_task_runs", "task_definition_revision_id")
    _add_column_if_missing(conn, "project_task_inventory", "task_definition_revision_id", "VARCHAR")
    _create_index_if_not_exists(conn, "ix_project_task_inv_task_def_rev", "project_task_inventory", "task_definition_revision_id")
    _add_column_if_missing(conn, "project_task_sources", "catalog_schema_version", "INTEGER NOT NULL DEFAULT 1")


def _migrate_to_v21() -> None:
    """Version 21: store immutable task definition revisions (SPEC-169)."""
    with engine.begin() as conn:
        _migrate_task_definition_revisions(conn)


def _migrate_to_v20() -> None:
    """Version 20 (SPEC-167): move check evidence off the hot run row."""
    with engine.begin() as conn:
        _migrate_check_report_schema(conn)


def _migrate_to_v22() -> None:
    """Version 22: drop the dead ``has_user_simulator`` inventory column.

    The user-simulator feature was never built (``turn()`` replaced it), so the
    flag was always ``False``. Drops the column from ``project_task_inventory``;
    guarded so re-running on an already-clean schema is a no-op.
    """
    with engine.begin() as conn:
        _drop_column_if_exists(conn, "project_task_inventory", "has_user_simulator")


def _migrate_to_v23() -> None:
    """Version 23 (issue #94): add ``unpriced_call_count`` to task runs.

    Existing rows backfill to 0 (the honest value for a run whose calls were all
    priced). The column lets the CLI/dashboard mark a total as partial instead
    of silently under-reporting spend when a model has no pricing pattern.
    """
    with engine.begin() as conn:
        _add_column_if_missing(
            conn, "agent_task_runs", "unpriced_call_count", "INTEGER NOT NULL DEFAULT 0"
        )


def _migrate_to_v24() -> None:
    """Version 24 (SPEC-174): ``task_view_comparison`` snapshot table + ``task_view`` saved views.

    Stores immutable selection-scoped comparisons and per-user saved evidence
    views. New tables are created by ``SQLModel.metadata.create_all`` on fresh
    DBs, so this only brings existing DBs up. Idempotent.
    """
    ts = "DATETIME" if _is_sqlite() else "TIMESTAMPTZ"
    with engine.begin() as conn:
        conn.exec_driver_sql(
            f"""
            CREATE TABLE IF NOT EXISTS task_view_comparison (
                id VARCHAR PRIMARY KEY,
                project_id VARCHAR NOT NULL REFERENCES projects(id),
                view_a_config JSON NOT NULL,
                view_b_config JSON NOT NULL,
                task_ids JSON NOT NULL,
                resolved JSON NOT NULL,
                coverage JSON NOT NULL,
                created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                created_by VARCHAR REFERENCES users(id)
            )
            """
        )
        _create_index_if_not_exists(conn, "ix_task_view_comparison_project_id", "task_view_comparison", "project_id")
        conn.exec_driver_sql(
            f"""
            CREATE TABLE IF NOT EXISTS task_view (
                id VARCHAR PRIMARY KEY,
                project_id VARCHAR NOT NULL REFERENCES projects(id),
                user_id VARCHAR NOT NULL REFERENCES users(id),
                label VARCHAR NOT NULL,
                model VARCHAR,
                effort VARCHAR,
                since VARCHAR,
                created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
            """
        )
        _create_index_if_not_exists(conn, "ix_task_view_project_user", "task_view", "project_id, user_id")


def _migrate_check_report_schema(conn: Connection) -> None:
    """The v20 check-report migration, runnable against any connection.

    Adds the scalar verdict columns (``total_checks`` / ``passed_checks`` /
    ``failed_checks``) to ``agent_task_runs`` and the
    ``agent_task_check_reports`` table, then backfills both from legacy
    ``checks_json`` in the SAME transaction: counts onto the run row, the
    evidence into a 1:1 report row, and the legacy column nulled — so the hot
    list/stats path is safe immediately and the data lives in exactly one
    place.

    New DBs already have the columns + table (``SQLModel.metadata.create_all``
    runs before migrations), so the DDL is a guarded no-op there and the
    backfill loop processes zero rows. Idempotent via the
    ``_add_column_if_missing`` / table-existence guards.
    """
    import json
    from datetime import datetime, timezone

    _add_column_if_missing(
        conn, "agent_task_runs", "total_checks", "INTEGER NOT NULL DEFAULT 0"
    )
    _add_column_if_missing(
        conn, "agent_task_runs", "passed_checks", "INTEGER NOT NULL DEFAULT 0"
    )
    _add_column_if_missing(
        conn, "agent_task_runs", "failed_checks", "INTEGER NOT NULL DEFAULT 0"
    )

    if "agent_task_check_reports" not in _get_table_names(conn):
        id_type = "TEXT" if _is_sqlite() else "VARCHAR"
        timestamp_type = "DATETIME" if _is_sqlite() else "TIMESTAMPTZ"
        conn.exec_driver_sql(
            f"""
            CREATE TABLE agent_task_check_reports (
                run_id {id_type} PRIMARY KEY
                    REFERENCES agent_task_runs(id) ON DELETE CASCADE,
                value_json JSON,
                created_at {timestamp_type} NOT NULL
            )
            """
        )

    # Backfill: read legacy checks_json, compute counts, copy evidence into the
    # report row, then null the legacy column — all atomically within the
    # caller's transaction. ``raw`` is already in hand per row, so nulling
    # checks_json during the loop cannot affect the remaining rows.
    rows = conn.exec_driver_sql(
        "SELECT id, checks_json FROM agent_task_runs WHERE checks_json IS NOT NULL"
    ).fetchall()
    now = datetime.now(timezone.utc)
    for run_id, raw in rows:
        try:
            checks = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError):
            checks = None
        if not isinstance(checks, list):
            continue
        total = len(checks)
        passed = sum(
            1 for c in checks if isinstance(c, dict) and c.get("pass") is True
        )
        # Insert evidence via the JSON bind type so the value round-trips on
        # read, then null the legacy column.
        conn.execute(
            text(
                "INSERT INTO agent_task_check_reports "
                "(run_id, value_json, created_at) VALUES (:id, :v, :now)"
            ).bindparams(bindparam("v", type_=JSON)),
            {"id": run_id, "v": checks, "now": now},
        )
        conn.execute(
            text(
                "UPDATE agent_task_runs "
                "SET total_checks = :t, passed_checks = :p, "
                "failed_checks = :f, checks_json = NULL WHERE id = :id"
            ),
            {"t": total, "p": passed, "f": total - passed, "id": run_id},
        )


def _migrate_schedule_pool_schema(conn: Connection) -> None:
    """The v14 schedule-pool migration, runnable against any connection."""
    _add_column_if_missing(conn, "agent_task_schedules", "executor_pool_id", "VARCHAR")
    _add_column_if_missing(conn, "agent_task_schedules", "queue_ttl_seconds", "INTEGER NOT NULL DEFAULT 86400")
    _add_column_if_missing(conn, "agent_task_schedules", "disabled_reason", "VARCHAR")
    _create_index_if_not_exists(conn, "ix_agent_task_schedules_executor_pool_id", "agent_task_schedules", "executor_pool_id")


def _migrate_run_configuration_schema(conn: Connection) -> None:
    """The v15 Run Configuration migration, runnable against any connection.

    Adds the nullable ``configured_model`` / ``configured_effort`` columns to
    ``agent_task_runs`` and the composite
    ``(configured_model, configured_effort, batch_run_id)`` index used by the
    model/effort filtering and comparison dimensions.

    No backfill (legacy rows stay NULL = "unknown"), no Batch Run columns,
    and no JSON metadata column — these are typed, indexed product dimensions.
    Idempotent via the ``_add_column_if_missing`` /
    ``_create_index_if_not_exists`` guards.
    """
    if "agent_task_runs" not in _get_table_names(conn):
        return  # nothing to migrate (baseline create handles it)

    _add_column_if_missing(conn, "agent_task_runs", "configured_model", "VARCHAR")
    _add_column_if_missing(conn, "agent_task_runs", "configured_effort", "VARCHAR")
    _create_index_if_not_exists(
        conn,
        "ix_agent_task_runs_configuration",
        "agent_task_runs",
        "configured_model, configured_effort, batch_run_id",
    )


def _migrate_execution_schema(conn: Connection) -> None:
    """The v13 execution control-plane migration, runnable against any connection.

    Creates the four new tables with indexes/constraints and adds the column
    extensions to existing tables. No backfill, no external I/O, idempotent.
    Historical Runs receive no synthetic Attempts.
    """
    ts = "DATETIME" if _is_sqlite() else "TIMESTAMPTZ"

    # ── executor_pools ────────────────────────────────────────────────────
    conn.exec_driver_sql(
        f"""
        CREATE TABLE IF NOT EXISTS executor_pools (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            name VARCHAR NOT NULL,
            slug VARCHAR NOT NULL,
            kind VARCHAR NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            archived_at {ts},
            queue_ttl_seconds INTEGER NOT NULL DEFAULT 86400,
            required_driver_kind VARCHAR NOT NULL DEFAULT 'subprocess',
            created_by_user_id VARCHAR,
            created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    _add_column_if_missing(conn, "executor_pools", "id", "VARCHAR PRIMARY KEY")
    for col, decl in (
        ("project", "VARCHAR NOT NULL DEFAULT ''"),
        ("name", "VARCHAR NOT NULL DEFAULT ''"),
        ("slug", "VARCHAR NOT NULL DEFAULT ''"),
        ("kind", "VARCHAR NOT NULL DEFAULT 'bundled'"),
        ("enabled", "BOOLEAN NOT NULL DEFAULT TRUE"),
        ("archived_at", ts),
        ("queue_ttl_seconds", "INTEGER NOT NULL DEFAULT 86400"),
        ("required_driver_kind", "VARCHAR NOT NULL DEFAULT 'subprocess'"),
        ("created_by_user_id", "VARCHAR"),
        ("created_at", f"{ts} NOT NULL DEFAULT CURRENT_TIMESTAMP"),
        ("updated_at", f"{ts} NOT NULL DEFAULT CURRENT_TIMESTAMP"),
    ):
        _add_column_if_missing(conn, "executor_pools", col, decl)
    _create_index_if_not_exists(conn, "ix_executor_pools_project", "executor_pools", "project")
    _create_index_if_not_exists(conn, "ix_executor_pools_kind", "executor_pools", "kind")
    _create_index_if_not_exists(conn, "ix_executor_pools_enabled", "executor_pools", "enabled")
    _create_unique_index_if_not_exists(
        conn, "uq_executor_pool_project_slug", "executor_pools", "project, slug"
    )

    # ── executors ─────────────────────────────────────────────────────────
    conn.exec_driver_sql(
        f"""
        CREATE TABLE IF NOT EXISTS executors (
            id VARCHAR PRIMARY KEY,
            scope_kind VARCHAR NOT NULL,
            project VARCHAR,
            executor_pool_id VARCHAR,
            name VARCHAR NOT NULL,
            enabled BOOLEAN NOT NULL DEFAULT TRUE,
            credential_prefix VARCHAR NOT NULL,
            credential_hash VARCHAR NOT NULL,
            protocol_version INTEGER NOT NULL,
            executor_version VARCHAR NOT NULL,
            driver_kinds_json JSON,
            capabilities_json JSON,
            max_concurrency INTEGER NOT NULL DEFAULT 1,
            last_seen_at {ts},
            enrolled_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
            revoked_at {ts},
            created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    _create_index_if_not_exists(conn, "ix_executors_project", "executors", "project")
    _create_index_if_not_exists(conn, "ix_executors_executor_pool_id", "executors", "executor_pool_id")
    _create_index_if_not_exists(conn, "ix_executors_enabled", "executors", "enabled")
    _create_index_if_not_exists(conn, "ix_executors_credential_hash", "executors", "credential_hash")
    _create_unique_index_if_not_exists(conn, "uq_executors_credential_hash", "executors", "credential_hash")

    # ── executor_enrollment_tokens ───────────────────────────────────────
    conn.exec_driver_sql(
        f"""
        CREATE TABLE IF NOT EXISTS executor_enrollment_tokens (
            id VARCHAR PRIMARY KEY,
            project VARCHAR,
            executor_pool_id VARCHAR,
            scope_kind VARCHAR NOT NULL,
            token_prefix VARCHAR NOT NULL,
            token_hash VARCHAR NOT NULL,
            expires_at {ts} NOT NULL,
            used_at {ts},
            revoked_at {ts},
            created_by_user_id VARCHAR,
            created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    _create_index_if_not_exists(conn, "ix_executor_enrollment_tokens_project", "executor_enrollment_tokens", "project")
    _create_index_if_not_exists(conn, "ix_executor_enrollment_tokens_executor_pool_id", "executor_enrollment_tokens", "executor_pool_id")
    _create_index_if_not_exists(conn, "ix_executor_enrollment_tokens_token_hash", "executor_enrollment_tokens", "token_hash")
    _create_unique_index_if_not_exists(conn, "uq_executor_enrollment_tokens_token_hash", "executor_enrollment_tokens", "token_hash")

    # ── task_execution_attempts ──────────────────────────────────────────
    conn.exec_driver_sql(
        f"""
        CREATE TABLE IF NOT EXISTS task_execution_attempts (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            batch_run_id VARCHAR NOT NULL,
            task_run_id VARCHAR NOT NULL,
            task_revision_id VARCHAR NOT NULL,
            sequence_index INTEGER NOT NULL DEFAULT 0,
            target_kind VARCHAR NOT NULL,
            executor_pool_id VARCHAR,
            executor_id VARCHAR,
            status VARCHAR NOT NULL DEFAULT 'queued',
            phase VARCHAR,
            lease_generation INTEGER NOT NULL DEFAULT 0,
            lease_expires_at {ts},
            queue_expires_at {ts} NOT NULL,
            queued_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
            claimed_at {ts},
            started_at {ts},
            heartbeat_at {ts},
            completed_at {ts},
            cancel_requested_at {ts},
            driver_kind VARCHAR,
            executor_snapshot_json JSON,
            completion_id VARCHAR,
            completion_sha256 VARCHAR,
            exit_code INTEGER,
            failure_kind VARCHAR,
            error_message VARCHAR,
            stdout_tail TEXT,
            stderr_tail TEXT,
            created_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at {ts} NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_project", "task_execution_attempts", "project")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_batch_run_id", "task_execution_attempts", "batch_run_id")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_task_run_id", "task_execution_attempts", "task_run_id")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_task_revision_id", "task_execution_attempts", "task_revision_id")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_target_kind", "task_execution_attempts", "target_kind")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_executor_pool_id", "task_execution_attempts", "executor_pool_id")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_executor_id", "task_execution_attempts", "executor_id")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_status", "task_execution_attempts", "status")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_lease_expires_at", "task_execution_attempts", "lease_expires_at")
    _create_index_if_not_exists(conn, "ix_task_execution_attempts_queue_expires_at", "task_execution_attempts", "queue_expires_at")
    _create_unique_index_if_not_exists(conn, "uq_task_execution_attempt_run", "task_execution_attempts", "task_run_id")
    _create_index_if_not_exists(conn, "ix_task_attempt_claim", "task_execution_attempts", "status, executor_pool_id, queued_at")
    _create_index_if_not_exists(conn, "ix_task_attempt_lease", "task_execution_attempts", "status, lease_expires_at")

    # ── column additions to existing tables ──────────────────────────────
    _add_column_if_missing(conn, "agent_task_batch_runs", "execution_target_json", "JSON")
    _add_column_if_missing(conn, "agent_task_batch_runs", "cancelled_tasks", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "agent_task_runs", "sequence_index", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "projects", "default_executor_pool_id", "VARCHAR")


def _migrate_task_revision_schema(conn: Connection) -> None:
    """The v12 Task Revisions migration, runnable against any connection.

    Creates ``task_revisions`` with its indexes and the unique
    ``batch_run_id`` constraint (one Revision per Batch). Performs no body
    backfill and no external I/O. Uses ``CREATE TABLE IF NOT EXISTS`` for
    upgrade safety, then adds any missing columns idempotently so a partially
    migrated database is brought up to the full shape.

    Historical Batches simply have no Revision row; nothing is rewritten.
    """
    timestamp_type = "DATETIME" if _is_sqlite() else "TIMESTAMPTZ"
    conn.exec_driver_sql(
        f"""
        CREATE TABLE IF NOT EXISTS task_revisions (
            id VARCHAR PRIMARY KEY,
            project VARCHAR NOT NULL,
            batch_run_id VARCHAR NOT NULL,
            materialization VARCHAR NOT NULL,
            source_type VARCHAR NOT NULL,
            source_ref VARCHAR,
            commit_sha VARCHAR,
            dirty BOOLEAN NOT NULL DEFAULT FALSE,
            content_sha256 VARCHAR NOT NULL,
            file_count INTEGER NOT NULL,
            uncompressed_size_bytes INTEGER NOT NULL,
            manifest_summary_json JSON NOT NULL,
            bundle_storage_backend VARCHAR,
            bundle_storage_key VARCHAR,
            bundle_sha256 VARCHAR,
            bundle_size_bytes INTEGER,
            created_at {timestamp_type} NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )

    # Idempotently bring a partially-created table up to the full shape.
    _add_column_if_missing(conn, "task_revisions", "id", "VARCHAR PRIMARY KEY")
    _add_column_if_missing(conn, "task_revisions", "project", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "task_revisions", "batch_run_id", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "task_revisions", "materialization", "VARCHAR NOT NULL DEFAULT 'attested'")
    _add_column_if_missing(conn, "task_revisions", "source_type", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "task_revisions", "source_ref", "VARCHAR")
    _add_column_if_missing(conn, "task_revisions", "commit_sha", "VARCHAR")
    _add_column_if_missing(conn, "task_revisions", "dirty", "BOOLEAN NOT NULL DEFAULT FALSE")
    _add_column_if_missing(conn, "task_revisions", "content_sha256", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "task_revisions", "file_count", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "task_revisions", "uncompressed_size_bytes", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "task_revisions", "manifest_summary_json", "JSON")
    _add_column_if_missing(conn, "task_revisions", "bundle_storage_backend", "VARCHAR")
    _add_column_if_missing(conn, "task_revisions", "bundle_storage_key", "VARCHAR")
    _add_column_if_missing(conn, "task_revisions", "bundle_sha256", "VARCHAR")
    _add_column_if_missing(conn, "task_revisions", "bundle_size_bytes", "INTEGER")
    _add_column_if_missing(conn, "task_revisions", "created_at", f"{timestamp_type} NOT NULL DEFAULT CURRENT_TIMESTAMP")

    _create_index_if_not_exists(conn, "ix_task_revisions_project", "task_revisions", "project")
    _create_index_if_not_exists(conn, "ix_task_revisions_content_sha256", "task_revisions", "content_sha256")
    _create_unique_index_if_not_exists(conn, "uq_task_revisions_batch_run_id", "task_revisions", "batch_run_id")


def _migrate_deliverable_schema(conn: Connection) -> None:
    """The v11 deliverables migration, runnable against any connection.

    Creates ``agent_task_deliverables`` with its indexes and the
    ``(project, task_run_id, name)`` unique constraint. Performs no body
    backfill and no external I/O. Uses ``CREATE TABLE IF NOT EXISTS`` for
    upgrade safety, then adds any missing columns idempotently so a partially
    migrated database is brought up to the full shape.

    Legacy ``transcript_json`` / ``deliverables_json`` columns on
    ``agent_task_runs`` are intentionally left untouched.
    """
    if _is_sqlite():
        conn.exec_driver_sql(
            """
            CREATE TABLE IF NOT EXISTS agent_task_deliverables (
                id VARCHAR PRIMARY KEY,
                project VARCHAR NOT NULL,
                task_run_id VARCHAR NOT NULL,
                name VARCHAR NOT NULL,
                kind VARCHAR NOT NULL,
                status VARCHAR NOT NULL,
                storage_backend VARCHAR,
                storage_key VARCHAR,
                inline_value_json JSON,
                display_filename VARCHAR,
                media_type VARCHAR NOT NULL,
                content_encoding VARCHAR NOT NULL DEFAULT 'identity',
                size_bytes INTEGER NOT NULL,
                stored_size_bytes INTEGER,
                sha256 VARCHAR NOT NULL,
                error_message VARCHAR,
                created_at DATETIME NOT NULL,
                ready_at DATETIME
            )
            """
        )
    else:
        conn.exec_driver_sql(
            """
            CREATE TABLE IF NOT EXISTS agent_task_deliverables (
                id VARCHAR PRIMARY KEY,
                project VARCHAR NOT NULL,
                task_run_id VARCHAR NOT NULL,
                name VARCHAR NOT NULL,
                kind VARCHAR NOT NULL,
                status VARCHAR NOT NULL,
                storage_backend VARCHAR,
                storage_key VARCHAR,
                inline_value_json JSON,
                display_filename VARCHAR,
                media_type VARCHAR NOT NULL,
                content_encoding VARCHAR NOT NULL DEFAULT 'identity',
                size_bytes INTEGER NOT NULL,
                stored_size_bytes INTEGER,
                sha256 VARCHAR NOT NULL,
                error_message VARCHAR,
                created_at TIMESTAMPTZ NOT NULL,
                ready_at TIMESTAMPTZ
            )
            """
        )

    # Idempotently bring a partially-created table up to the full shape.
    # In production ``create_all`` creates the full table first and this is a
    # no-op; these ``ADD COLUMN`` guards cover the edge case of a partially
    # migrated table and keep the migration safe to re-run.
    _add_column_if_missing(conn, "agent_task_deliverables", "project", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "agent_task_deliverables", "task_run_id", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "agent_task_deliverables", "name", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "agent_task_deliverables", "kind", "VARCHAR NOT NULL DEFAULT 'json'")
    _add_column_if_missing(conn, "agent_task_deliverables", "status", "VARCHAR NOT NULL DEFAULT 'pending'")
    _add_column_if_missing(conn, "agent_task_deliverables", "storage_backend", "VARCHAR")
    _add_column_if_missing(conn, "agent_task_deliverables", "storage_key", "VARCHAR")
    _add_column_if_missing(conn, "agent_task_deliverables", "inline_value_json", "JSON")
    _add_column_if_missing(conn, "agent_task_deliverables", "display_filename", "VARCHAR")
    _add_column_if_missing(conn, "agent_task_deliverables", "media_type", "VARCHAR NOT NULL DEFAULT 'application/octet-stream'")
    _add_column_if_missing(conn, "agent_task_deliverables", "content_encoding", "VARCHAR NOT NULL DEFAULT 'identity'")
    _add_column_if_missing(conn, "agent_task_deliverables", "size_bytes", "INTEGER NOT NULL DEFAULT 0")
    _add_column_if_missing(conn, "agent_task_deliverables", "stored_size_bytes", "INTEGER")
    _add_column_if_missing(conn, "agent_task_deliverables", "sha256", "VARCHAR NOT NULL DEFAULT ''")
    _add_column_if_missing(conn, "agent_task_deliverables", "error_message", "VARCHAR")
    _add_column_if_missing(conn, "agent_task_deliverables", "created_at", "DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP")
    _add_column_if_missing(conn, "agent_task_deliverables", "ready_at", "DATETIME")

    _create_index_if_not_exists(
        conn, "ix_agent_task_deliverables_project", "agent_task_deliverables", "project"
    )
    _create_index_if_not_exists(
        conn, "ix_agent_task_deliverables_task_run_id", "agent_task_deliverables", "task_run_id"
    )
    _create_unique_index_if_not_exists(
        conn,
        "uq_agent_task_deliverable_name",
        "agent_task_deliverables",
        "project, task_run_id, name",
    )


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


LATEST_SCHEMA_VERSION = 24

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
    11: _migrate_to_v11,
    12: _migrate_to_v12,
    13: _migrate_to_v13,
    14: _migrate_to_v14,
    15: _migrate_to_v15,
    16: _migrate_to_v16,
    17: _migrate_to_v17,
    18: _migrate_to_v18,
    19: _migrate_to_v19,
    20: _migrate_to_v20,
    21: _migrate_to_v21,
    22: _migrate_to_v22,
    23: _migrate_to_v23,
    24: _migrate_to_v24,
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
