"""Check Report storage boundary.

A Task Run's check evidence lives off the hot ``agent_task_runs`` row. The run
row carries only the scalar verdict (``total_checks`` / ``passed_checks`` /
``failed_checks``); the full per-check results — reasoning, judge segments,
assertions, identity — live in ``agent_task_check_reports`` and are loaded only
by the detail / compare / CLI path via :func:`load_check_report`.

Per-field hygiene is retained so one pathological value cannot blow up the row
or the detail response. Limits apply at semantic locations in both the legacy
top-level shape and the current nested SDK shape:

- ``received`` (top-level and ``assertions[].received``) larger than
  ``RECEIVED_VALUE_LIMIT`` -> a ``TruncatedCheckValue`` marker.
- Judge prompt/response segments — both legacy ``judge_prompt`` /
  ``judge_response`` and nested ``judge.prompt.system`` / ``.user`` /
  ``judge.response`` at check and assertion level — larger than
  ``JUDGE_SEGMENT_LIMIT`` -> truncated marker.

Reasoning, instruction, expected, and identity fields are never truncated.
Normalization runs on both write and read, making historical oversized rows
safe to transport without a database rewrite.
"""

# pyright: reportUnknownArgumentType=false, reportUnknownVariableType=false, reportUnnecessaryIsInstance=false, reportUnusedParameter=false

from __future__ import annotations

import hashlib
import json
from collections.abc import Sequence
from datetime import datetime, timezone

from sqlmodel import Session, col, select

from ..models.db import AgentTaskCheckReportDB, AgentTaskRunDB

RECEIVED_VALUE_LIMIT = 4 * 1024  # 4 KiB
JUDGE_SEGMENT_LIMIT = 16 * 1024  # 16 KiB

# Agentic-judge session caps (the SDK pre-compacts to the same numbers; the
# backend re-enforces defensively — same double-enforcement contract as the
# limits above). Identity fields (outcome, usage, evidence fingerprints) are
# never truncated: they are the replay-audit backbone.
MAX_JUDGE_STEPS = 64
JUDGE_KEEP_HEAD_STEPS = 56
JUDGE_TOOL_INPUT_LIMIT = 2 * 1024
JUDGE_TOOL_RESULT_LIMIT = 4 * 1024
JUDGE_STEP_TEXT_LIMIT = 2 * 1024
JUDGE_SESSION_LIMIT = 96 * 1024

_PREVIEW_CHARS = 256

# Legacy text-segment fields truncated to TruncatedCheckValue markers.
_TRUNCATED_TEXT_FIELDS = ("judge_prompt", "judge_response")


def normalize_check_report(
    checks: list[dict[str, object]],
) -> list[dict[str, object]]:
    """Return a normalized copy without mutating caller-owned input.

    Applies per-field limits at both the legacy top-level shape and the current
    nested SDK shape (``assertions[].received``, ``judge.prompt.{system,user}``,
    ``judge.response`` at both check and assertion levels). Existing markers are
    left unchanged, making the function idempotent.
    """
    return [
        _normalize_check(entry)
        for entry in checks
        if isinstance(entry, dict)
    ]


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
    cleaned = normalize_check_report(checks or [])
    run.total_checks = len(cleaned)
    run.passed_checks = sum(1 for c in cleaned if c.get("pass") is True)
    run.failed_checks = run.total_checks - run.passed_checks
    session.add(run)
    _upsert_report_row(session, run.id, cleaned)


def load_check_report(
    session: Session,
    run_id: str,
) -> list[dict[str, object]] | None:
    """Resolve a run's full check evidence.

    The ``agent_task_check_reports`` row is the only store — the legacy
    ``checks_json`` column fallback was removed with the column (schema
    v28). Returns ``None`` for an unknown run. Read-time normalization is
    applied so historical oversized rows are safe to transport without a
    database rewrite.
    """
    report = session.get(AgentTaskCheckReportDB, run_id)
    if report is None:
        return None
    raw = report.value_json
    return normalize_check_report(raw) if raw is not None else None


def load_check_reports(
    session: Session,
    runs: Sequence[AgentTaskRunDB],
) -> dict[str, list[dict[str, object]] | None]:
    """Load check evidence for many already-loaded Task Runs in one query.

    Read-time normalization is applied so historical oversized rows are safe
    to transport without a database rewrite.
    """
    run_by_id = {run.id: run for run in runs}
    if not run_by_id:
        return {}

    reports = session.exec(
        select(AgentTaskCheckReportDB).where(
            col(AgentTaskCheckReportDB.run_id).in_(run_by_id)
        )
    ).all()
    report_by_id = {
        report.run_id: normalize_check_report(raw) if (raw := report.value_json) is not None else None
        for report in reports
    }
    # The legacy ``checks_json`` column fallback was removed with the column
    # (schema v28): runs without a report row simply have no check evidence.
    return {run_id: report_by_id.get(run_id) for run_id in run_by_id}


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


def _normalize_check(entry: dict[str, object]) -> dict[str, object]:
    """Normalize one check entry, recursing into assertions and judge objects."""
    result: dict[str, object] = {}
    for key, value in entry.items():
        if key == "received":
            result[key] = _truncate_value(value, RECEIVED_VALUE_LIMIT)
        elif key in _TRUNCATED_TEXT_FIELDS:
            result[key] = _truncate_text(value, JUDGE_SEGMENT_LIMIT)
        elif key == "judge" and isinstance(value, dict):
            result[key] = _normalize_judge(value)
        elif key == "assertions" and isinstance(value, list):
            result[key] = [
                _normalize_assertion(a)
                for a in value
                if isinstance(a, dict)
            ]
        else:
            result[key] = value
    return result


def _normalize_assertion(assertion: dict[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in assertion.items():
        if key == "received":
            result[key] = _truncate_value(value, RECEIVED_VALUE_LIMIT)
        elif key == "judge" and isinstance(value, dict):
            result[key] = _normalize_judge(value)
        else:
            result[key] = value
    return result


def _normalize_judge(judge: dict[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in judge.items():
        if key == "response":
            result[key] = _truncate_text(value, JUDGE_SEGMENT_LIMIT)
        elif key == "prompt" and isinstance(value, dict):
            result[key] = _normalize_prompt(value)
        elif key == "session" and isinstance(value, dict):
            result[key] = _normalize_session(value)
        else:
            result[key] = value
    return result


def _normalize_session(session: dict[str, object]) -> dict[str, object]:
    """Cap an agentic-judge session transcript under the design-doc limits.

    Tool input/result text and step prose truncate to their limits with
    sha256/bytes identity preserved; beyond 64 steps the middle collapses to
    a marker so early orientation and the final verdict always survive; and
    a pathological session still over budget after field caps loses more
    middle steps until it fits or hits the keep floor (identity fields are
    never cut, so the cap is soft by design). ``outcome``, ``usage`` and
    ``evidence`` pass through untouched.
    """
    result: dict[str, object] = {}
    for key, value in session.items():
        if key == "briefing" and isinstance(value, dict):
            result[key] = {
                k: _truncate_text(v, JUDGE_SEGMENT_LIMIT)
                for k, v in value.items()
            }
        elif key == "steps" and isinstance(value, list):
            result[key] = _normalize_steps(value)
        else:
            result[key] = value

    if len(_dumps(result)) > JUDGE_SESSION_LIMIT:
        result = _shrink_session_to_budget(result)
    return result


def _normalize_steps(steps: list[object]) -> list[dict[str, object]]:
    cleaned: list[dict[str, object]] = []
    for step in steps:
        if not isinstance(step, dict):
            continue
        entry: dict[str, object] = {}
        for key, value in step.items():
            if key == "text":
                entry[key] = _truncate_text(value, JUDGE_STEP_TEXT_LIMIT)
            elif key == "tool_calls" and isinstance(value, list):
                entry[key] = [_normalize_tool_call(c) for c in value if isinstance(c, dict)]
            else:
                entry[key] = value
        cleaned.append(entry)

    if len(cleaned) <= MAX_JUDGE_STEPS:
        return cleaned
    head = cleaned[:JUDGE_KEEP_HEAD_STEPS]
    tail = cleaned[-(MAX_JUDGE_STEPS - JUDGE_KEEP_HEAD_STEPS):]
    skipped = len(cleaned) - MAX_JUDGE_STEPS
    marker: dict[str, object] = {
        "index": JUDGE_KEEP_HEAD_STEPS,
        "text": f"…[{skipped} intermediate steps truncated]",
    }
    return [*head, marker, *tail]


def _normalize_tool_call(call: dict[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in call.items():
        if key == "input":
            result[key] = _truncate_text_or_value(value, JUDGE_TOOL_INPUT_LIMIT)
        elif key == "result":
            result[key] = _truncate_text_or_value(value, JUDGE_TOOL_RESULT_LIMIT)
        else:
            result[key] = value
    return result


def _truncate_text_or_value(value: object, limit: int) -> object:
    """Truncate text directly; measure structured values by their JSON form.

    Tool results may arrive as objects (the API models that), and a large
    dict would sail past the text limit untouched — measure it like a
    ``received`` value instead so the cap holds for both shapes.
    """
    if isinstance(value, str):
        return _truncate_text(value, limit)
    if value is None:
        return value
    if len(_dumps(value)) <= limit:
        return value
    return _truncate_value(value, limit)


def _shrink_session_to_budget(session: dict[str, object]) -> dict[str, object]:
    """Last-resort fit: drop middle steps until the session fits its budget."""
    steps_obj = session.get("steps")
    if not isinstance(steps_obj, list):
        return session
    steps: list[object] = steps_obj
    import json as _json

    keep = len(steps)
    while keep > 2:
        candidate = _json.dumps(session, default=str).encode("utf-8")
        if len(candidate) <= JUDGE_SESSION_LIMIT:
            break
        keep = max(2, keep // 2)
        head = steps[: max(1, keep // 2)]
        tail = steps[-max(1, keep // 2):]
        rebuilt: list[object] = [
            *head, {"index": len(head), "text": "…[session shrunk to storage budget]"}, *tail
        ]
        session = {**session, "steps": rebuilt}
        steps = rebuilt
    return session


def _normalize_prompt(prompt: dict[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in prompt.items():
        if key in ("system", "user"):
            result[key] = _truncate_text(value, JUDGE_SEGMENT_LIMIT)
        else:
            result[key] = value
    return result


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
