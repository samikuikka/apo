# pyright: reportPrivateUsage=false, reportUnknownMemberType=false, reportArgumentType=false

"""Canonical typed SQLAlchemy column handles.

These ``as_column(cast(object, Model.attr))`` derivations exist so call sites
get a typed ``ColumnElement[T]`` instead of the untyped
``InstrumentedAttribute`` pyright/SQLAlchemy produces natively. This module is
the single source of truth — routes and services import from here instead of
keeping private copies. The explicit ``ColumnElement[T]`` parametrization (not
``[object]``) is what lets the core ``sa_select`` overloads resolve.

Also hosts the ``defer()`` light-projection tuples for heavy JSON columns.
"""

from datetime import datetime
from typing import cast

from sqlalchemy.orm import defer
from sqlalchemy.sql.elements import ColumnElement

from ..db_helpers import as_column
from .db import (
    AgentTaskBatchRunDB,
    AgentTaskRunDB,
    AgentTaskScheduleDB,
    LoggedCallDB,
    RunDB,
    RunMetricDB,
    SessionDB,
)

# --- RunDB ---

RUN_ID_COL: ColumnElement[str] = as_column(cast(object, RunDB.id))
RUN_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, RunDB.created_at))
RUN_PROJECT_COL: ColumnElement[str] = as_column(cast(object, RunDB.project))
RUN_FLOW_NAME_COL: ColumnElement[str] = as_column(cast(object, RunDB.flow_name))
RUN_PRIMARY_MODEL_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.primary_model))
RUN_EXTERNAL_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.external_id))
RUN_DURATION_MS_COL: ColumnElement[float | None] = as_column(cast(object, RunDB.duration_ms))
RUN_ENVIRONMENT_COL: ColumnElement[str] = as_column(cast(object, RunDB.environment))
RUN_CALL_COUNT_COL: ColumnElement[int] = as_column(cast(object, RunDB.call_count))
RUN_TASK_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.task_id))
RUN_SESSION_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.session_id))
RUN_USER_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.user_id))

# --- LoggedCallDB ---

LOGGED_CALL_ID_COL: ColumnElement[str] = as_column(cast(object, LoggedCallDB.id))
LOGGED_CALL_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, LoggedCallDB.created_at))
LOGGED_CALL_RUN_ID_COL: ColumnElement[str | None] = as_column(cast(object, LoggedCallDB.run_id))
LOGGED_CALL_PARENT_COL: ColumnElement[str | None] = as_column(cast(object, LoggedCallDB.parent_call_id))
LOGGED_CALL_PROJECT_COL: ColumnElement[str | None] = as_column(cast(object, LoggedCallDB.project))
LOGGED_CALL_STEP_INDEX_COL: ColumnElement[int | None] = as_column(cast(object, LoggedCallDB.step_index))
LOGGED_CALL_VERSION_COL: ColumnElement[str | None] = as_column(cast(object, LoggedCallDB.version))
LOGGED_CALL_LATENCY_MS_COL: ColumnElement[float | None] = as_column(cast(object, LoggedCallDB.latency_ms))
LOGGED_CALL_COST_COL: ColumnElement[float | None] = as_column(cast(object, LoggedCallDB.cost))
LOGGED_CALL_TOTAL_TOKENS_COL: ColumnElement[int | None] = as_column(cast(object, LoggedCallDB.total_tokens))
LOGGED_CALL_MODEL_COL: ColumnElement[str] = as_column(cast(object, LoggedCallDB.model))
LOGGED_CALL_OBSERVATION_TYPE_COL: ColumnElement[str] = as_column(cast(object, LoggedCallDB.observation_type))
LOGGED_CALL_LEVEL_COL: ColumnElement[str | None] = as_column(cast(object, LoggedCallDB.level))

# --- RunMetricDB ---

RUN_METRIC_ID_COL: ColumnElement[int] = as_column(cast(object, RunMetricDB.id))
RUN_METRIC_RUN_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunMetricDB.run_id))
RUN_METRIC_PROJECT_COL: ColumnElement[str] = as_column(cast(object, RunMetricDB.project))
RUN_METRIC_NAME_COL: ColumnElement[str] = as_column(cast(object, RunMetricDB.metric_name))
RUN_METRIC_SCORE_COL: ColumnElement[float | None] = as_column(cast(object, RunMetricDB.score))
RUN_METRIC_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, RunMetricDB.created_at))

# --- SessionDB ---

SESSION_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, SessionDB.created_at))

# --- AgentTaskRunDB ---

AGENT_TASK_RUN_ID_COL: ColumnElement[str] = as_column(cast(object, AgentTaskRunDB.id))
AGENT_TASK_RUN_TASK_ID_COL: ColumnElement[str] = as_column(cast(object, AgentTaskRunDB.task_id))
AGENT_TASK_RUN_STATUS_COL: ColumnElement[str] = as_column(cast(object, AgentTaskRunDB.status))
AGENT_TASK_RUN_STARTED_AT_COL: ColumnElement[datetime | None] = as_column(cast(object, AgentTaskRunDB.started_at))
AGENT_TASK_RUN_COMPLETED_AT_COL: ColumnElement[datetime | None] = as_column(cast(object, AgentTaskRunDB.completed_at))
AGENT_TASK_RUN_TOTAL_COST_COL: ColumnElement[float | None] = as_column(cast(object, AgentTaskRunDB.total_cost))
AGENT_TASK_RUN_PASS_RESULT_COL: ColumnElement[bool | None] = as_column(cast(object, AgentTaskRunDB.pass_result))
AGENT_TASK_RUN_TOTAL_CHECKS_COL: ColumnElement[int] = as_column(cast(object, AgentTaskRunDB.total_checks))
AGENT_TASK_RUN_PASSED_CHECKS_COL: ColumnElement[int] = as_column(cast(object, AgentTaskRunDB.passed_checks))
AGENT_TASK_RUN_CORRECTED_TESTS_COL: ColumnElement[int] = as_column(cast(object, AgentTaskRunDB.corrected_tests))
AGENT_TASK_RUN_DEFINITION_REVISION_COL: ColumnElement[str | None] = as_column(
    cast(object, AgentTaskRunDB.task_definition_revision_id)
)
AGENT_TASK_RUN_CONFIGURED_MODEL_COL: ColumnElement[str | None] = as_column(
    cast(object, AgentTaskRunDB.configured_model)
)
AGENT_TASK_RUN_CONFIGURED_EFFORT_COL: ColumnElement[str | None] = as_column(
    cast(object, AgentTaskRunDB.configured_effort)
)
AGENT_TASK_RUN_BATCH_RUN_ID_COL: ColumnElement[str] = as_column(cast(object, AgentTaskRunDB.batch_run_id))

# --- AgentTaskBatchRunDB ---

AGENT_TASK_BATCH_ID_COL: ColumnElement[str] = as_column(cast(object, AgentTaskBatchRunDB.id))
AGENT_TASK_BATCH_PROJECT_COL: ColumnElement[str] = as_column(cast(object, AgentTaskBatchRunDB.project))
AGENT_TASK_BATCH_CREATED_AT_COL: ColumnElement[datetime] = as_column(
    cast(object, AgentTaskBatchRunDB.created_at)
)

# --- AgentTaskScheduleDB ---

AGENT_TASK_SCHEDULE_CREATED_AT_COL: ColumnElement[object] = as_column(
    cast(object, AgentTaskScheduleDB.created_at)
)

# Defer the heaviest LoggedCallDB columns on list/preview/metrics paths that
# only read scalar fields or short previews. Lazy-loaded on access.
CALL_LIGHT = (
    defer(LoggedCallDB.messages),
    defer(LoggedCallDB.tool_parameters),
    defer(LoggedCallDB.tool_result),
    defer(LoggedCallDB.cost_breakdown),
    defer(LoggedCallDB.raw_usage),
)

# Defer the full transcript on batch-listing projections that only read
# run-status fields. Lazy-loaded on access.
TASK_RUN_LIGHT = (
    defer(AgentTaskRunDB.transcript_json),
)
