"""
Metrics aggregation service.

Provides pure functions for computing statistical aggregates
on collections of numeric values: sum, avg, count, and percentiles.
"""


def compute_aggregate(values: list[float], aggregation: str) -> float | None:
    if not values:
        return None

    agg = aggregation.lower()
    if agg == "sum":
        return sum(values)
    if agg == "avg":
        return sum(values) / len(values)
    if agg == "count":
        return float(len(values))
    if agg in ("p50", "p90", "p95", "p99"):
        percentile = int(agg[1:])
        return compute_percentile(values, percentile)
    return None


def compute_percentile(values: list[float], percentile: int) -> float | None:
    if not values:
        return None

    sorted_vals = sorted(values)
    n = len(sorted_vals)

    if percentile <= 0:
        return sorted_vals[0]
    if percentile >= 100:
        return sorted_vals[-1]

    rank = (percentile / 100) * (n - 1)
    lower = int(rank)
    upper = min(lower + 1, n - 1)
    fraction = rank - lower

    return sorted_vals[lower] + (sorted_vals[upper] - sorted_vals[lower]) * fraction
