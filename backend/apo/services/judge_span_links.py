"""Judge-span deep links on check reports (issue #288).

Judge work is emitted as spans under the run's trace: ``judge:<check id>``
for single-shot calls, ``t.agent:<check id>`` for agentic sessions. Runs
recorded since the SDK stamps ``span_id`` onto the judge metadata carry the
exact link already; runs recorded before that get one here via a bounded
join — the run's own trace, matched on step name. Ambiguous names (two
``judge:judge`` spans in one run, e.g. two unlabeled criteria in one check)
stay unlinked rather than guessed: a link that lands on the wrong judgment
is worse than no link.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import cast

from sqlmodel import Session, col, or_, select

from ..models.db import AgentTaskRunDB, LoggedCallDB

JUDGE_STEP_PREFIXES = ("judge:", "t.agent:")


def annotate_judge_span_ids(
    session: Session,
    runs: Sequence[AgentTaskRunDB],
    checks_by_run: Mapping[str, list[dict[str, object]] | None],
) -> None:
    """Stamp ``judge.span_id`` onto the checks of the given runs, in place.

    One bounded query covers all runs regardless of comparison size. Judge
    metadata that already carries a ``span_id`` recorded at emission keeps it
    (it is exact) — unless the span is absent from the trace, in which case
    the stale id is dropped so the UI never links into a missing observation.
    """
    trace_run_ids = [
        run.trace_run_id
        for run in runs
        if run.trace_run_id and checks_by_run.get(run.id)
    ]
    if not trace_run_ids:
        return

    spans_by_trace = _judge_spans_by_trace(session, trace_run_ids)
    for run in runs:
        checks = checks_by_run.get(run.id)
        if not checks or not run.trace_run_id:
            continue
        _annotate_run_checks(checks, spans_by_trace.get(run.trace_run_id, {}))


def _judge_spans_by_trace(
    session: Session,
    trace_run_ids: Sequence[str],
) -> dict[str, dict[str, list[str]]]:
    """Judge-span call ids per trace run, keyed by step name.

    Only the id and step name are selected — the join needs no span bodies,
    so the response stays summary-sized even on traces with many judgments.
    """
    rows = session.exec(
        select(LoggedCallDB.run_id, LoggedCallDB.step_name, LoggedCallDB.id).where(
            col(LoggedCallDB.run_id).in_(trace_run_ids),
            or_(
                col(LoggedCallDB.step_name).like("judge:%"),
                col(LoggedCallDB.step_name).like("t.agent:%"),
            ),
        )
    ).all()
    spans: dict[str, dict[str, list[str]]] = {}
    for run_id, step_name, span_id in rows:
        if run_id is None or not step_name:
            continue
        by_name = spans.setdefault(run_id, {})
        by_name.setdefault(step_name, []).append(span_id)
    return spans


def _annotate_run_checks(
    checks: list[dict[str, object]],
    spans_by_name: dict[str, list[str]],
) -> None:
    if not spans_by_name:
        return
    known_span_ids = {
        span_id for ids in spans_by_name.values() for span_id in ids
    }
    for check in checks:
        check_id = str(check.get("id") or "")
        if not check_id:
            continue
        judges = _judge_metadata_objects(check)
        if not judges:
            continue
        # Fallback join for runs recorded before the SDK stamped span_id:
        # the check's judge spans, found by prefixed step name. Link only
        # when exactly one candidate exists across both prefixes.
        candidates = [
            *(spans_by_name.get(f"judge:{check_id}", [])),
            *(spans_by_name.get(f"t.agent:{check_id}", [])),
        ]
        fallback = candidates[0] if len(candidates) == 1 else None
        for judge in judges:
            recorded = judge.get("span_id")
            if isinstance(recorded, str) and recorded in known_span_ids:
                continue
            if isinstance(recorded, str) and recorded:
                del judge["span_id"]  # emission-time id the trace doesn't have
            if fallback:
                judge["span_id"] = fallback


def _judge_metadata_objects(check: dict[str, object]) -> list[dict[str, object]]:
    """The judge metadata dicts of one check: check-level plus assertions'."""
    judges: list[dict[str, object]] = []
    top = check.get("judge")
    if isinstance(top, dict):
        judges.append(cast(dict[str, object], top))
    assertions = check.get("assertions")
    if isinstance(assertions, list):
        for item in cast(list[object], assertions):
            if not isinstance(item, dict):
                continue
            judge = cast(dict[str, object], item).get("judge")
            if isinstance(judge, dict):
                judges.append(cast(dict[str, object], judge))
    return judges
