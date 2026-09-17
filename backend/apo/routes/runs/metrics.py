from datetime import datetime, timezone

from ...metrics.aggregate import compute_call_aggregates
from ...models import LoggedCallDB, RunMetricDB


def calculate_run_metrics_from_calls(
    calls: list[LoggedCallDB], run_id: str
) -> list[RunMetricDB]:
    # Thin on-read twin of calculate_and_store_aggregate_metrics: same
    # computation (shared via compute_call_aggregates), no project column
    # and an explicit created_at because these rows are never persisted.
    return [
        RunMetricDB(
            run_id=run_id,
            metric_name=agg.metric_name,
            metric_type="aggregate",
            score=agg.score,
            reasoning=agg.reasoning,
            meta=agg.meta or None,
            created_at=datetime.now(timezone.utc),
        )
        for agg in compute_call_aggregates(calls)
    ] if calls else []
