# pyright: reportAny=false

from apo.services.metrics import compute_aggregate, compute_percentile


def test_compute_aggregate_sum():
    assert compute_aggregate([1.0, 2.0, 3.0], "sum") == 6.0


def test_compute_aggregate_avg():
    assert compute_aggregate([1.0, 2.0, 3.0], "avg") == 2.0


def test_compute_aggregate_count():
    assert compute_aggregate([1.0, 2.0, 3.0], "count") == 3.0


def test_compute_aggregate_empty():
    assert compute_aggregate([], "sum") is None
    assert compute_aggregate([], "avg") is None
    assert compute_aggregate([], "count") is None


def test_compute_aggregate_unknown():
    assert compute_aggregate([1.0, 2.0], "unknown") is None


def test_compute_percentile_p50():
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    result = compute_percentile(values, 50)
    assert result is not None
    assert result == 30.0


def test_compute_percentile_p95():
    values = [float(value) for value in range(1, 101)]
    result = compute_percentile(values, 95)
    assert result is not None
    assert result >= 95.0
    assert result <= 96.0


def test_compute_percentile_p99():
    values = [float(value) for value in range(1, 101)]
    result = compute_percentile(values, 99)
    assert result is not None
    assert result >= 99.0


def test_compute_percentile_empty():
    assert compute_percentile([], 50) is None


def test_compute_percentile_single_value():
    assert compute_percentile([42.0], 50) == 42.0


def test_compute_percentile_edge_cases():
    values = [10.0, 20.0, 30.0]
    assert compute_percentile(values, 0) == 10.0
    assert compute_percentile(values, 100) == 30.0


def test_compute_aggregate_p95():
    values = [float(value) for value in range(1, 101)]
    result = compute_aggregate(values, "p95")
    assert result is not None
    assert result >= 95.0


def test_compute_aggregate_p50():
    values = [10.0, 20.0, 30.0, 40.0, 50.0]
    result = compute_aggregate(values, "p50")
    assert result is not None
    assert result == 30.0
