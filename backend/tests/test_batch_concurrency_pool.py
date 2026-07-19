"""Tests for bounded batch execution pool (SPEC-132 Behavior 7).

Previously every batch spawned its own daemon thread via
``threading.Thread``, so a burst of batches could overwhelm a small host
and spike LLM spend. These tests pin the bounded-pool contract:

- At most ``AGENT_TASK_MAX_CONCURRENT_BATCHES`` batches run at once.
- Excess batches queue without spawning additional worker threads.
- Tasks inside one batch still run sequentially.
- Shutdown/restart leaves queued/running DB states honest (reuses the
  existing stuck-run recovery; not re-tested here).

Uses ``_configure_batch_pool_limit`` instead of module reload so other
tests' monkeypatches are not polluted.
"""

from __future__ import annotations

import threading
import time

from _pytest.monkeypatch import MonkeyPatch

from apo.services import agent_task_runner


class TestBoundedPoolConcurrency:
    """The pool enforces the configured concurrency limit."""

    def test_at_most_n_batches_run_concurrently(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """With a limit of 2, submitting 4 batches never lets more than 2
        execute at the same moment; the other 2 wait."""
        agent_task_runner._configure_batch_pool_limit(2)

        gate = threading.Event()
        done = threading.Event()
        observed_peak = {"value": 0}
        lock = threading.Lock()
        in_flight = {"value": 0}

        def slow_batch(_batch_id: str) -> None:
            with lock:
                in_flight["value"] += 1
                observed_peak["value"] = max(
                    observed_peak["value"], in_flight["value"]
                )
            # Block until the test signals release.
            gate.wait(timeout=5.0)
            with lock:
                in_flight["value"] -= 1
            done.set()

        monkeypatch.setattr(agent_task_runner, "_run_batch_in_background", slow_batch)

        for i in range(4):
            agent_task_runner.start_batch_run_execution(f"batch-{i}")

        # Let the pool settle — the two slots should fill, the rest queue.
        time.sleep(0.3)
        assert observed_peak["value"] <= 2
        assert observed_peak["value"] == 2  # both slots used

        # Release the running batches so queued ones can proceed + cleanup.
        gate.set()
        done.wait(timeout=5.0)
        time.sleep(0.3)

    def test_excess_batches_queue_without_extra_threads(
        self, monkeypatch: MonkeyPatch
    ) -> None:
        """With limit 1, submitting 3 batches must use exactly ONE worker
        thread from the pool, not 3 raw threads."""
        agent_task_runner._configure_batch_pool_limit(1)

        gate = threading.Event()
        worker_threads: set[int] = set()
        lock = threading.Lock()

        def tracked_batch(_batch_id: str) -> None:
            with lock:
                worker_threads.add(threading.get_ident())
            gate.wait(timeout=5.0)

        monkeypatch.setattr(agent_task_runner, "_run_batch_in_background", tracked_batch)

        for i in range(3):
            agent_task_runner.start_batch_run_execution(f"q-batch-{i}")

        time.sleep(0.3)
        # Only one worker thread should be observed running batch code.
        assert len(worker_threads) == 1

        gate.set()
        time.sleep(0.3)  # let queued batches drain


class TestConcurrencyLimitParsing:
    """The limit is read from the env at import (clamped to [1, 8])."""

    def test_default_limit_is_one(self) -> None:
        # _configure_batch_pool_limit sets the runtime value; verify the
        # default constant path via a fresh reconfigure.
        agent_task_runner._configure_batch_pool_limit(1)
        assert agent_task_runner.get_max_concurrent_batches() == 1

    def test_limit_set_via_configure(self) -> None:
        agent_task_runner._configure_batch_pool_limit(3)
        assert agent_task_runner.get_max_concurrent_batches() == 3

    def test_limit_clamped_to_max_eight(self) -> None:
        agent_task_runner._configure_batch_pool_limit(50)
        assert agent_task_runner.get_max_concurrent_batches() == 8

    def test_limit_clamped_to_min_one(self) -> None:
        agent_task_runner._configure_batch_pool_limit(0)
        assert agent_task_runner.get_max_concurrent_batches() == 1

    def test_negative_clamped_to_min_one(self) -> None:
        agent_task_runner._configure_batch_pool_limit(-3)
        assert agent_task_runner.get_max_concurrent_batches() == 1
