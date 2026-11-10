# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false, reportUnnecessaryComparison=false

"""Bulk export query and serialization for runs.

The route handler owns HTTP concerns (format dispatch, download headers).
Everything from the DB fetch through the per-run serialization lives here
so it is testable without going through FastAPI.

Three bounds keep one export from exhausting a memory-capped shared
backend (issue #230 G2): the request caps ``run_ids`` (Pydantic 422
beyond), items are fetched ONE RUN AT A TIME (the render holds a single
run's rows regardless of how many ids were requested), and both renders
run under a byte budget (``APO_BULK_EXPORT_MAX_BYTES``) that fails the
export with a 413 instead of buffering without bound.

The response stays a buffered download (Content-Disposition): the budget
check must finish before the body exists and the serialize-as-fetched
shape assumes one pass.
"""

import csv
import json
from collections.abc import Iterator
from io import BytesIO, TextIOWrapper
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
from ...services.export_budget import (
    ExportBudgetExceeded,
    load_export_byte_limits,
    render_json_array,
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

_OVER_BUDGET_GUIDANCE = "narrow the selection and export in smaller batches"


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

    limits = load_export_byte_limits()
    items = iter_export_run_items(session, run_ids, project)
    try:
        if fmt == "csv":
            return _render_csv(items, len(run_ids), limits.bulk_export_max_bytes)
        body = render_json_array(
            items,
            limit=limits.bulk_export_max_bytes,
            guidance=_OVER_BUDGET_GUIDANCE,
        )
    except ExportBudgetExceeded as exc:
        return Response(
            status_code=413,
            content=json.dumps({"detail": str(exc)}),
            media_type="application/json",
        )
    return Response(
        content=body,
        media_type="application/json",
        headers={
            "Content-Disposition": f'attachment; filename="runs_export_{len(run_ids)}_runs.json"'
        },
    )


def iter_export_run_items(
    session: Session,
    run_ids: list[str],
    project: str,
) -> Iterator[dict[str, object]]:
    """Yield one serialized export item per requested run id, in order.

    Ids not found in the database (or outside ``project``) are silently
    skipped, matching the original single-query behavior. Runs are
    fetched one at a time so only one run's rows (including full call
    payloads) are resident while the render serializes.
    """
    for rid in run_ids:
        run = session.exec(
            select(RunDB).where(RUN_ID_COL == rid, RUN_PROJECT_COL == project)
        ).first()
        if run is None:
            continue
        metrics = _load_metrics_by_run(session, [rid], project).get(rid, [])
        calls = _load_calls_by_run(session, [rid], project).get(rid, [])
        yield {
            "run": Run.model_validate(run).model_dump(by_alias=True),
            "metrics": [
                RunMetric.model_validate(m).model_dump(by_alias=True)
                for m in metrics
            ],
            "calls": [
                LoggedCall.model_validate(c, from_attributes=True).model_dump(
                    by_alias=True
                )
                for c in calls
            ],
        }


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
    items: Iterator[dict[str, object]], count: int, limit: int
) -> Response:
    # The budget counts UTF-8 bytes. StringIO.tell() counts characters, and
    # non-ASCII tags inflate the wire size up to 4x past the char count, so
    # render through a write-through wrapper into BytesIO: tell() is then
    # the byte position the limit describes.
    output = BytesIO()
    text = TextIOWrapper(output, encoding="utf-8", newline="", write_through=True)
    writer = csv.writer(text)
    writer.writerow(_CSV_COLUMNS)

    for run_item in items:
        writer.writerow(_csv_row(run_item))
        if output.tell() > limit:
            raise ExportBudgetExceeded(limit, _OVER_BUDGET_GUIDANCE)

    return Response(
        content=output.getvalue(),
        media_type="text/csv",
        headers={
            "Content-Disposition": f'attachment; filename="runs_export_{count}_runs.csv"'
        },
    )


def _csv_row(run_item: dict[str, object]) -> list[object]:
    run = cast(dict[str, object], run_item["run"])
    metrics = cast(list[object], run_item["metrics"])
    tags_value = run.get("tags")
    tags: list[object] = (
        cast(list[object], tags_value) if isinstance(tags_value, list) else []
    )
    return [
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
