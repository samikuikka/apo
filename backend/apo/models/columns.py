from datetime import datetime
from typing import cast

from sqlalchemy.sql.elements import ColumnElement

from ..db_helpers import _as_column as as_column  # noqa: F401 — used in column definitions below
from .db import (
    AgentTaskBatchRunDB,
    AgentTaskScheduleDB,
    LoggedCallDB,
    RunDB,
    RunMetricDB,
    SessionDB,
)

RUN_ID_COL: ColumnElement[str] = as_column(cast(object, RunDB.id))
RUN_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, RunDB.created_at))
RUN_PROJECT_COL: ColumnElement[str] = as_column(cast(object, RunDB.project))
RUN_FLOW_NAME_COL: ColumnElement[str] = as_column(cast(object, RunDB.flow_name))
RUN_PRIMARY_MODEL_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.primary_model))
RUN_EXTERNAL_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunDB.external_id))
RUN_DURATION_MS_COL: ColumnElement[float | None] = as_column(cast(object, RunDB.duration_ms))

LOGGED_CALL_ID_COL: ColumnElement[str] = as_column(cast(object, LoggedCallDB.id))
LOGGED_CALL_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, LoggedCallDB.created_at))
LOGGED_CALL_RUN_ID_COL: ColumnElement[str | None] = as_column(cast(object, LoggedCallDB.run_id))
LOGGED_CALL_STEP_INDEX_COL: ColumnElement[int | None] = as_column(cast(object, LoggedCallDB.step_index))
LOGGED_CALL_VERSION_COL: ColumnElement[str | None] = as_column(cast(object, LoggedCallDB.version))
LOGGED_CALL_LATENCY_MS_COL: ColumnElement[float | None] = as_column(cast(object, LoggedCallDB.latency_ms))
LOGGED_CALL_COST_COL: ColumnElement[float | None] = as_column(cast(object, LoggedCallDB.cost))
LOGGED_CALL_TOTAL_TOKENS_COL: ColumnElement[int | None] = as_column(cast(object, LoggedCallDB.total_tokens))
LOGGED_CALL_MODEL_COL: ColumnElement[str] = as_column(cast(object, LoggedCallDB.model))
LOGGED_CALL_OBSERVATION_TYPE_COL: ColumnElement[str] = as_column(cast(object, LoggedCallDB.observation_type))
LOGGED_CALL_LEVEL_COL: ColumnElement[str] = as_column(cast(object, LoggedCallDB.level))

RUN_METRIC_ID_COL: ColumnElement[int] = as_column(cast(object, RunMetricDB.id))
RUN_METRIC_RUN_ID_COL: ColumnElement[str | None] = as_column(cast(object, RunMetricDB.run_id))
RUN_METRIC_NAME_COL: ColumnElement[str] = as_column(cast(object, RunMetricDB.metric_name))
RUN_METRIC_SCORE_COL: ColumnElement[float | None] = as_column(cast(object, RunMetricDB.score))
RUN_METRIC_SOURCE_COL: ColumnElement[str] = as_column(cast(object, RunMetricDB.source))
RUN_METRIC_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, RunMetricDB.created_at))

SESSION_CREATED_AT_COL: ColumnElement[datetime] = as_column(cast(object, SessionDB.created_at))

AGENT_TASK_BATCH_RUN_CREATED_AT_COL: ColumnElement[object] = as_column(
    cast(object, AgentTaskBatchRunDB.created_at)
)
RUN_ENVIRONMENT_COL: ColumnElement[str] = as_column(cast(object, RunDB.environment))
RUN_CALL_COUNT_COL: ColumnElement[int] = as_column(cast(object, RunDB.call_count))

AGENT_TASK_SCHEDULE_CREATED_AT_COL: ColumnElement[object] = as_column(
    cast(object, AgentTaskScheduleDB.created_at)
)
