"""
Aggregate metric calculations for runs.
Shared logic for computing total_cost, avg_latency, total_tokens from logged calls.
"""

from collections.abc import Sequence
from dataclasses import dataclass, field

from sqlmodel import Session, col, select

from ..models import RunMetricDB, LoggedCallDB


@dataclass(frozen=True)
class CallAggregate:
    """One run-level aggregate derived from per-call measurements.

    ``meta`` carries soft references the UI needs — chiefly ``call_id`` for
    the max metrics, so "the slowest call" can link straight to the
    observation in the trace view.
    """

    metric_name: str
    score: float
    reasoning: str
    meta: dict[str, object] = field(default_factory=dict)


def compute_call_aggregates(calls: Sequence[LoggedCallDB]) -> list[CallAggregate]:
    """Derive every run-level aggregate from a run's calls.

    The single source of the rollups both persistence paths share: the
    stored rows (:func:`calculate_and_store_aggregate_metrics`) and the
    on-read derivation in ``routes/runs/metrics.py``. Pure — no session,
    no timestamps — so both callers wrap the result in their own
    ``RunMetricDB`` construction.

    Reasoning tokens read the normalized ``raw_usage["reasoning"]``
    dimension. A call without that key did not report reasoning; a run
    where NO call reported it yields no reasoning metrics at all, which
    consumers must render as unknown — never as zero. When only some
    calls reported, the totals are partial sums over the reporting calls
    and the ``reasoning`` text says so.

    Latency aggregates (``avg_latency`` / ``max_call_latency_ms`` /
    ``total_model_time_ms``) are computed over ``GENERATION``
    observations only. ``logged_calls`` also holds TOOL/CHAIN/structural
    rows, and the agent-task root span's latency is the whole run's wall
    clock — maxing or summing those would double-count the run and could
    crown a tool (or the run itself) as the "slowest model call". This is
    a semantic fix: ``avg_latency`` previously averaged every observation.
    """

    generations = [c for c in calls if c.observation_type == "GENERATION"]

    aggregates: list[CallAggregate] = []

    costs = [c.cost for c in calls if c.cost is not None]
    if costs:
        aggregates.append(CallAggregate(
            metric_name="total_cost",
            score=sum(costs),
            reasoning=f"Sum of {len(costs)} call costs",
        ))

    latencies = [
        (c.id, c.latency_ms)
        for c in generations
        if c.latency_ms is not None
    ]
    if latencies:
        aggregates.append(CallAggregate(
            metric_name="avg_latency",
            score=sum(ms for _, ms in latencies) / len(latencies),
            reasoning=f"Average of {len(latencies)} generation latencies",
        ))
        slowest_id, slowest_ms = max(latencies, key=lambda item: item[1])
        aggregates.append(CallAggregate(
            metric_name="max_call_latency_ms",
            score=slowest_ms,
            reasoning=f"Slowest of {len(latencies)} generations",
            meta={"call_id": slowest_id},
        ))
        # Model wall time: the sum of generation latencies. Deliberately
        # distinct from the run's duration_ms — tool time and harness time
        # between calls are not model time.
        aggregates.append(CallAggregate(
            metric_name="total_model_time_ms",
            score=sum(ms for _, ms in latencies),
            reasoning=f"Sum of {len(latencies)} generation latencies",
        ))

    total_tokens_list = [
        (c.prompt_tokens or 0) + (c.completion_tokens or 0)
        for c in calls
        if (c.prompt_tokens or 0) + (c.completion_tokens or 0) > 0
    ]
    if total_tokens_list:
        aggregates.append(CallAggregate(
            metric_name="total_tokens",
            score=sum(total_tokens_list),
            reasoning=f"Sum of {len(total_tokens_list)} call token counts",
        ))

    def _reasoning_value(call: LoggedCallDB) -> int | None:
        # A null value means the same as a missing key: unreported. (The
        # normalizer only emits ints, but hand-written rows exist — coerce
        # rather than crash on a stray string.)
        value = (call.raw_usage or {}).get("reasoning")
        if value is None:
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None

    reported = [
        (c.id, value)
        for c in generations
        # Errored generations skip usage like the task-run scalars do (the
        # final streamed usage event often never arrives): a projected
        # plausible-zero or partial usage is not a measurement. Latency
        # above already keeps them.
        if c.level != "ERROR" and (value := _reasoning_value(c)) is not None
    ]
    if reported:
        unreported = len(generations) - len(reported)
        partial_note = (
            f" ({unreported} call{'s' if unreported != 1 else ''} did not report reasoning)"
            if unreported
            else ""
        )
        aggregates.append(CallAggregate(
            metric_name="total_reasoning_tokens",
            score=sum(tokens for _, tokens in reported),
            reasoning=(
                f"Sum of {len(reported)} reporting calls' reasoning tokens{partial_note}"
            ),
            meta={"reported_calls": len(reported), "unreported_calls": unreported},
        ))
        deepest_id, deepest_tokens = max(reported, key=lambda item: item[1])
        aggregates.append(CallAggregate(
            metric_name="max_call_reasoning_tokens",
            score=deepest_tokens,
            reasoning=f"Largest single-call reasoning total of {len(reported)} reporting calls",
            meta={"call_id": deepest_id},
        ))

    return aggregates


def calculate_and_store_aggregate_metrics(
    session: Session, run_id: str, project: str
) -> list[RunMetricDB]:
    """
    Calculate all run-level aggregates from all calls in a run.

    Scoped by ``(run_id, project)``: two Projects may share an OTel trace id, so
    summing calls without the Project would mix tenants.
    Returns list of RunMetricDB objects to be added to the session.
    """
    calls = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.run_id == run_id, col(LoggedCallDB.project) == project
        )
    ).all()

    if not calls:
        return []

    return [
        RunMetricDB(
            run_id=run_id,
            project=project,
            metric_name=agg.metric_name,
            metric_type="aggregate",
            score=agg.score,
            reasoning=agg.reasoning,
            meta=agg.meta or None,
        )
        for agg in compute_call_aggregates(calls)
    ]
