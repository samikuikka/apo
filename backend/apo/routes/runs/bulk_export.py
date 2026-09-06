# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryComparison=false

"""Bulk export query and serialization for runs.

The route handler owns HTTP concerns (format dispatch, download headers).
Everything from the DB fetch through the per-run serialization lives here
so it is testable without going through FastAPI.

Two bounds keep one export from exhausting a memory-capped shared
backend (issue #230 G2): the request caps `run_ids` (Pydantic 422
beyond), and the render produces the file body exactly once — no
pre-serialized copy nested inside a JSON envelope (~3–4× resident) —
with a byte budget that fails the export instead of buffering without
bound. The response is a buffered download (Content-Disposition), not a
StreamingResponse: the request-size middleware pre-reads and replays
capped write bodies, which drops streamed response bodies under nested
BaseHTTPMiddleware.
"""

import csv
import json
from io import StringIO
from typing import cast

from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import asc
from sqlmodel import Session, select

from ...models import LoggedCall, LoggedCallDB, Run, RunMetric, RunMetricDB, RunDB
from ...models.columns import (
    LOGGED_CALL_CREATED_AT_COL,
    LOGGED_CALL_PROJECT_COL,
    LOGGED_CALL_RUN_ID_COL,
    LOGGED_CALL_STEP_INDEX_COL,
    RUN_ID_COL,
    RUN_METRIC_PROJECT_COL,
    RUN_METRIC_RUN_ID_COL,
    RUN_PROJECT_COL,
)

_CSV_COLUMNS = [
    "Run ID",
    "Project",
    "Flow Name",
    "Task ID",
    "Version",
    "Environment",
    "Created At",
    "Completed At",
    "Duration (ms)",
    "Call Count",
    "Tags",
    "Metrics Count",
]

MAX_EXPORT_RUN_IDS = 200

# Semantic ceiling on one export's rendered size: a handful of very large
# agentic traces within the run-id cap can still overflow a memory-limited
# backend, so past this budget the export fails with a clear error instead
# of buffering without bound. Roughly an hour of today's largest traces.
MAX_EXPORT_BYTES = 128 * 1024 * 1024


class BulkExportRequest(BaseModel):
    run_ids: list[str] = Field(min_length=1, max_length=MAX_EXPORT_RUN_IDS)
    format: str = "json"


def export_runs(
    session: Session,
    run_ids: list[str],
    project: str,
    fmt: str,
) -> Response:
    if not run_ids:
        return Response(
            status_code=400,
            content='{"detail": "No run IDs provided"}',
            media_type="application/json",
        )

    runs_data = collect_runs_for_export(session, run_ids, project)
    if fmt == "csv":
        return _render_csv(runs_data, len(run_ids))
    return _render_json(runs_data, len(run_ids))


def collect_runs_for_export(
    session: Session,
    run_ids: list[str],
    project: str,
) -> list[dict[str, object]]:
    """Fetch runs + related metrics/calls and serialize to export dicts.

    Runs are returned in the order of ``run_ids``; ids not found in the
    database (or outside ``project``) are silently skipped — matching the
    original route handler's behaviour.
    """
    runs_in_db = session.exec(
        select(RunDB).where(RUN_ID_COL.in_(run_ids), RUN_PROJECT_COL == project)
    ).all()
    run_id_map = {r.id: r for r in runs_in_db}
    export_run_ids = [rid for rid in run_ids if rid in run_id_map]

    metrics_by_run = _load_metrics_by_run(session, export_run_ids, project)
    calls_by_run = _load_calls_by_run(session, export_run_ids, project)

    return [
        {
            "run": Run.model_validate(run_id_map[rid]).model_dump(by_alias=True),
            "metrics": [
                RunMetric.model_validate(m).model_dump(by_alias=True)
                for m in metrics_by_run.get(rid, [])
            ],
            "calls": [
                LoggedCall.model_validate(c, from_attributes=True).model_dump(
                    by_alias=True
                )
                for c in calls_by_run.get(rid, [])
            ],
        }
        for rid in export_run_ids
    ]


def _load_metrics_by_run(
    session: Session, run_ids: list[str], project: str
) -> dict[str, list[RunMetricDB]]:
    if not run_ids:
        return {}
    rows = session.exec(
        select(RunMetricDB).where(
            RUN_METRIC_RUN_ID_COL.in_(run_ids),
            RUN_METRIC_PROJECT_COL == project,
        )
    ).all()
    result: dict[str, list[RunMetricDB]] = {}
    for m in rows:
        if m.run_id is not None:
            result.setdefault(m.run_id, []).append(m)
    return result


def _load_calls_by_run(
    session: Session, run_ids: list[str], project: str
) -> dict[str, list[LoggedCallDB]]:
    if not run_ids:
        return {}
    rows = session.exec(
        select(LoggedCallDB)
        .where(
            LOGGED_CALL_RUN_ID_COL.in_(run_ids),
            LOGGED_CALL_PROJECT_COL == project,
        )
        .order_by(
            asc(LOGGED_CALL_STEP_INDEX_COL).nulls_last(),
            asc(LOGGED_CALL_CREATED_AT_COL),
        )
    ).all()
    result: dict[str, list[LoggedCallDB]] = {}
    for c in rows:
        if c.run_id is not None:
            result.setdefault(c.run_id, []).append(c)
    return result


def _render_csv(
    runs_data: list[dict[str, object]], count: int
) -> Response:
    output = StringIO()
    writer = csv.writer(output)
    writer.writerow(_CSV_COLUMNS)

    for run_item in runs_data:
        run = cast(dict[str, object], run_item["run"])
        metrics = cast(list[object], run_item["metrics"])
        tags_value = run.get("tags")
        tags: list[object] = (
            cast(list[object], tags_value) if isinstance(tags_value, list) else []
        )
        writer.writerow(
            [
                run.get("id"),
                run.get("project"),
                run.get("flow_name") or "",
                run.get("task_id") or "",
                run.get("version") or "",
                run.get("environment") or "",
                run.get("created_at") or "",
                run.get("completed_at") or "",
                run.get("duration_ms") or "",
                run.get("call_count") or 0,
                ",".join(str(tag) for tag in tags),
                len(metrics),
            ]
        )

    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="runs_export_{count}_runs.csv"'
        },
    )


def _render_json(
    runs_data: list[dict[str, object]], count: int
) -> Response:
    """Render the export JSON exactly once, under a byte budget.

    Each run serializes independently so the budget check can fail the
    export before the final join; dropping the dict as it serializes keeps
    peak memory at roughly one copy of the data instead of the ~3–4× of
    the old envelope render.
    """
    parts = ["["]
    total = 1
    for i, run_item in enumerate(runs_data):
        chunk = json.dumps(run_item, default=str)
        if i > 0:
            chunk = ",\n" + chunk
        total += len(chunk)
        if total > MAX_EXPORT_BYTES:
            return Response(
                status_code=413,
                content=json.dumps(
                    {
                        "detail": (
                            f"Export exceeds the {MAX_EXPORT_BYTES} byte budget; "
                            "narrow the selection and export in smaller batches"
                        )
                    }
                ),
                media_type="application/json",
            )
        parts.append(chunk)
        runs_data[i] = {}  # free the serialized dict
    parts.append("]")

    return Response(
        content="".join(parts),
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="runs_export_{count}_runs.json"'
        },
    )
