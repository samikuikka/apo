"""Check Report storage boundary.

A Task Run's check evidence lives off the hot ``agent_task_runs`` row. The run
row carries only the scalar verdict (``total_checks`` / ``passed_checks`` /
``failed_checks``); the full per-check results — reasoning, judge segments,
assertions, identity — live in ``agent_task_check_reports`` and are loaded only
by the detail / compare / CLI path via :func:`load_check_report`.

Per-field hygiene is retained so one pathological value cannot blow up the row
or the detail response:

- ``received`` larger than ``RECEIVED_VALUE_LIMIT`` -> a ``TruncatedCheckValue``
  marker (preview + size + sha256); a check's ``received`` can echo a whole
  Deliverable blob, so it must stay bounded;
- ``judge_prompt`` / ``judge_response`` larger than ``JUDGE_SEGMENT_LIMIT`` ->
  truncated marker (defense vs a judge echoing huge input).

The retired 1 MiB total cap and the 32 KiB per-string caps on
``reasoning`` / ``instruction`` / ``expected`` are gone: for a judged run the
reasoning *is* the result, and the report row is no longer on the hot path, so
there is nothing for those caps to protect.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlmodel import Session, col, select

from ..models.db import AgentTaskCheckReportDB, AgentTaskRunDB

RECEIVED_VALUE_LIMIT = 4 * 1024  # 4 KiB
JUDGE_SEGMENT_LIMIT = 16 * 1024  # 16 KiB

_PREVIEW_CHARS = 256

# Text-segment fields truncated to TruncatedCheckValue markers.
_TRUNCATED_TEXT_FIELDS = ("judge_prompt", "judge_response")


def persist_check_report(
    session: Session,
    run: AgentTaskRunDB,
    checks: list[dict[str, object]] | None,
) -> None:
    """Persist the run's scalar verdict and its check evidence.

    Writes ``run.total_checks`` / ``passed_checks`` / ``failed_checks``, clears
    the legacy ``checks_json`` column (kept readable only for the compatibility
    window), and upserts the evidence into ``agent_task_check_reports``. Stages
    the changes on ``session`` without committing — the caller's transaction
    owns the commit so the verdict scalars and the report body land together.
    """
    cleaned = [
        _normalize_one(entry)
        for entry in (checks or [])
        if isinstance(entry, dict)
    ]
    run.total_checks = len(cleaned)
    run.passed_checks = sum(1 for c in cleaned if c.get("pass") is True)
    run.failed_checks = run.total_checks - run.passed_checks
    run.checks_json = None
    session.add(run)
    _upsert_report_row(session, run.id, cleaned)


def load_check_report(
    session: Session,
    run_id: str,
) -> list[dict[str, object]] | None:
    """Resolve a run's full check evidence.

    Primary path: the ``agent_task_check_reports`` row. Falls back to the
    legacy ``checks_json`` column only when no report row exists (a restored
    backup or a row that predates the backfill); returns ``None`` for an
    unknown run. After the atomic backfill every run has a report row, so the
    fallback is a safety net, not a rollout strategy.
    """
    report = session.get(AgentTaskCheckReportDB, run_id)
    if report is not None:
        return report.value_json
    run = session.get(AgentTaskRunDB, run_id)
    return run.checks_json if run is not None else None


def load_check_reports(
    session: Session,
    runs: Sequence[AgentTaskRunDB],
) -> dict[str, list[dict[str, object]] | None]:
    """Load check evidence for many already-loaded Task Runs in one query."""
    run_by_id = {run.id: run for run in runs}
    if not run_by_id:
        return {}

    reports = session.exec(
        select(AgentTaskCheckReportDB).where(
            col(AgentTaskCheckReportDB.run_id).in_(run_by_id)
        )
    ).all()
    report_by_id = {report.run_id: report.value_json for report in reports}
    return {
        run_id: report_by_id[run_id]
        if run_id in report_by_id
        else run.checks_json
        for run_id, run in run_by_id.items()
    }


def _upsert_report_row(
    session: Session,
    run_id: str,
    checks: list[dict[str, object]],
) -> None:
    """Insert or replace the run's check report row (1:1 with the run)."""
    report = session.get(AgentTaskCheckReportDB, run_id)
    now = datetime.now(timezone.utc)
    if report is None:
        session.add(
            AgentTaskCheckReportDB(
                run_id=run_id,
                value_json=checks,
                created_at=now,
            )
        )
    else:
        report.value_json = checks
        report.created_at = now
        session.add(report)


# ── per-field hygiene ────────────────────────────────────────────────────────


def _normalize_one(entry: dict[str, object]) -> dict[str, object]:
    return {key: _normalize_field(key, value) for key, value in entry.items()}


def _normalize_field(key: str, value: object) -> object:
    if key == "received":
        return _truncate_value(value, RECEIVED_VALUE_LIMIT)
    if key in _TRUNCATED_TEXT_FIELDS:
        return _truncate_text(value, JUDGE_SEGMENT_LIMIT)
    return value


def _truncate_value(value: object, limit: int) -> object:
    """Truncate a ``received`` value when its compact JSON form exceeds ``limit``."""
    if value is None:
        return None
    try:
        encoded = _dumps(value)
    except (TypeError, ValueError):
        encoded = _dumps(str(value))
    if len(encoded) <= limit:
        return value
    return _marker(encoded, limit)


def _truncate_text(value: object, limit: int) -> object:
    if not isinstance(value, str):
        return value
    if len(value.encode("utf-8")) <= limit:
        return value
    return _marker(value.encode("utf-8"), limit)


def _marker(payload: bytes, limit: int) -> dict[str, object]:
    preview = payload[:_PREVIEW_CHARS].decode("utf-8", errors="replace")
    return {
        "kind": "truncated",
        "preview": preview,
        "size_bytes": len(payload),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def _dumps(value: object) -> bytes:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
