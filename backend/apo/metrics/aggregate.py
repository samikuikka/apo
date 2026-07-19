"""
Aggregate metric calculations for runs.
Shared logic for computing total_cost, avg_latency, total_tokens from logged calls.
"""

from sqlmodel import Session, col, select

from ..models import RunMetricDB, LoggedCallDB


def calculate_and_store_aggregate_metrics(
    session: Session, run_id: str, project: str
) -> list[RunMetricDB]:
    """
    Calculate total_cost, avg_latency, total_tokens from all calls in a run.

    Scoped by ``(run_id, project)``: two Projects may share an OTel trace id, so
    summing calls without the Project would mix tenants (SPEC-133 M4).
    Returns list of RunMetricDB objects to be added to the session.
    """
    calls = session.exec(
        select(LoggedCallDB).where(
            LoggedCallDB.run_id == run_id, col(LoggedCallDB.project) == project
        )
    ).all()

    if not calls:
        return []

    metrics: list[RunMetricDB] = []

    # Calculate total_cost
    costs = [c.cost for c in calls if c.cost is not None]
    if costs:
        metrics.append(RunMetricDB(
            run_id=run_id,
            project=project,
            metric_name="total_cost",
            metric_type="aggregate",
            score=sum(costs),
            reasoning=f"Sum of {len(costs)} call costs",
        ))

    # Calculate avg_latency
    latencies = [c.latency_ms for c in calls if c.latency_ms is not None]
    if latencies:
        metrics.append(RunMetricDB(
            run_id=run_id,
            project=project,
            metric_name="avg_latency",
            metric_type="aggregate",
            score=sum(latencies) / len(latencies),
            reasoning=f"Average of {len(latencies)} call latencies",
        ))

    # Calculate total_tokens
    total_tokens_list = [
        (c.prompt_tokens or 0) + (c.completion_tokens or 0)
        for c in calls
        if (c.prompt_tokens or 0) + (c.completion_tokens or 0) > 0
    ]
    if total_tokens_list:
        metrics.append(RunMetricDB(
            run_id=run_id,
            project=project,
            metric_name="total_tokens",
            metric_type="aggregate",
            score=sum(total_tokens_list),
            reasoning=f"Sum of {len(total_tokens_list)} call token counts",
        ))

    return metrics
