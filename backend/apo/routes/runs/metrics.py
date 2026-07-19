from datetime import datetime, timezone

from ...models import LoggedCallDB, RunMetricDB


def calculate_run_metrics_from_calls(
    calls: list[LoggedCallDB], run_id: str
) -> list[RunMetricDB]:
    if not calls:
        return []

    metrics: list[RunMetricDB] = []

    costs = [c.cost for c in calls if c.cost is not None]
    if costs:
        metrics.append(
            RunMetricDB(
                run_id=run_id,
                metric_name="total_cost",
                metric_type="aggregate",
                score=sum(costs),
                reasoning=f"Sum of {len(costs)} call costs",
                created_at=datetime.now(timezone.utc),
            )
        )

    latencies = [c.latency_ms for c in calls if c.latency_ms is not None]
    if latencies:
        metrics.append(
            RunMetricDB(
                run_id=run_id,
                metric_name="avg_latency",
                metric_type="aggregate",
                score=sum(latencies) / len(latencies),
                reasoning=f"Average of {len(latencies)} call latencies",
                created_at=datetime.now(timezone.utc),
            )
        )

    total_tokens_list: list[int] = []
    for c in calls:
        prompt_tokens = c.prompt_tokens or 0
        completion_tokens = c.completion_tokens or 0
        if prompt_tokens + completion_tokens > 0:
            total_tokens_list.append(prompt_tokens + completion_tokens)

    if total_tokens_list:
        metrics.append(
            RunMetricDB(
                run_id=run_id,
                metric_name="total_tokens",
                metric_type="aggregate",
                score=sum(total_tokens_list),
                reasoning=f"Sum of {len(total_tokens_list)} call token counts",
                created_at=datetime.now(timezone.utc),
            )
        )

    return metrics
