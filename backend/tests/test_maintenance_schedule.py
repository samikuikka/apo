# pyright: reportAny=false, reportAttributeAccessIssue=false, reportCallIssue=false, reportPrivateUsage=false, reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownParameterType=false, reportUnknownVariableType=false, reportUntypedFunctionDecorator=false, reportUnusedCallResult=false, reportUnusedParameter=false

"""When the daily maintenance pass runs.

The pass used to run at every boot and then every 24 h, so every restart
paid for it on a cold cache. It now runs once a day inside a quiet-hour
window, and a boot only catches up when the last recorded pass is a day
old. The loop scenes drive the real thread through
``start_retention_loop`` with a frozen clock and a recording pass.
"""

from __future__ import annotations

import threading
from collections.abc import Iterator
from datetime import datetime, timezone

import pytest
from sqlmodel import Session

from apo.services import retention
from apo.services.retention import (
    MAINTENANCE_WINDOW_END_HOUR_ENV as END,
    MAINTENANCE_WINDOW_START_HOUR_ENV as START,
    MaintenanceScheduleError,
    MaintenanceWindow,
    load_maintenance_window,
    maintenance_pass_due,
)
from tests.conftest import engine as test_engine

DEFAULT_WINDOW = MaintenanceWindow(start_hour=3, end_hour=5)
OVERNIGHT_WINDOW = MaintenanceWindow(start_hour=22, end_hour=2)


def _at(hour: int, minute: int = 0, second: int = 0, *, day: int = 10) -> datetime:
    """A UTC instant in November 2026; day 10 unless a scene spans days."""
    return datetime(2026, 11, day, hour, minute, second, tzinfo=timezone.utc)


@pytest.fixture(name="loop")
def loop_fixture(monkeypatch: pytest.MonkeyPatch) -> Iterator[LoopHarness]:
    monkeypatch.delenv(START, raising=False)
    monkeypatch.delenv(END, raising=False)
    harness = LoopHarness(monkeypatch)
    yield harness
    harness.stop()


# ---------------------------------------------------------------------------
# The window comes from the environment, validated at startup
# ---------------------------------------------------------------------------


def test_window_defaults_to_three_to_five_utc(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv(START, raising=False)
    monkeypatch.delenv(END, raising=False)

    assert load_maintenance_window() == MaintenanceWindow(start_hour=3, end_hour=5)


def test_window_reads_the_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(START, "22")
    monkeypatch.setenv(END, " 2 ")

    assert load_maintenance_window() == MaintenanceWindow(start_hour=22, end_hour=2)


@pytest.mark.parametrize("name", [START, END])
@pytest.mark.parametrize("raw", ["", "   ", "three", "3.5", "24", "-1"])
def test_invalid_hour_names_the_variable(
    monkeypatch: pytest.MonkeyPatch, name: str, raw: str
) -> None:
    monkeypatch.delenv(START, raising=False)
    monkeypatch.delenv(END, raising=False)
    monkeypatch.setenv(name, raw)

    with pytest.raises(MaintenanceScheduleError, match=name):
        load_maintenance_window()


def test_equal_start_and_end_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    """Start equal to end is either an empty window or the whole day."""
    monkeypatch.setenv(START, "4")
    monkeypatch.setenv(END, "4")

    with pytest.raises(MaintenanceScheduleError, match=f"{END} must differ from {START}"):
        load_maintenance_window()


# ---------------------------------------------------------------------------
# The rule: once per window, and a catch-up when a day was missed
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("now", "last_pass_at", "due"),
    [
        pytest.param(_at(14), None, True, id="never-ran"),
        pytest.param(_at(14), _at(3), False, id="afternoon-restart-ran-this-morning"),
        pytest.param(_at(14), _at(13, day=9), True, id="afternoon-restart-last-pass-25h-old"),
        pytest.param(_at(14), _at(14, 0, 1, day=9), False, id="one-second-short-of-a-day"),
        pytest.param(_at(3, 30), _at(23, 30, day=9), True, id="in-window-not-yet-served"),
        pytest.param(_at(3, 30), _at(3), False, id="in-window-already-served"),
        pytest.param(_at(3), _at(23, 30, day=9), True, id="window-opens-on-the-hour"),
        pytest.param(_at(2, 59), _at(23, 30, day=9), False, id="a-minute-before-the-window"),
        pytest.param(_at(5), _at(23, 30, day=9), False, id="window-end-is-exclusive"),
        pytest.param(_at(14), _at(14, day=11), True, id="last-pass-recorded-in-the-future"),
    ],
)
def test_pass_is_due_once_per_window_or_after_a_missed_day(
    now: datetime, last_pass_at: datetime | None, due: bool
) -> None:
    assert maintenance_pass_due(now, last_pass_at, DEFAULT_WINDOW) is due


@pytest.mark.parametrize(
    ("now", "last_pass_at", "due"),
    [
        pytest.param(_at(23), _at(10), True, id="evening-half-not-yet-served"),
        pytest.param(_at(1), _at(10, day=9), True, id="after-midnight-half-not-yet-served"),
        pytest.param(_at(1), _at(23, day=9), False, id="after-midnight-served-before-midnight"),
        pytest.param(_at(2), _at(10, day=9), False, id="closes-at-two"),
        pytest.param(_at(12), _at(23, day=9), False, id="midday-is-outside"),
    ],
)
def test_window_may_wrap_past_midnight(
    now: datetime, last_pass_at: datetime, due: bool
) -> None:
    assert maintenance_pass_due(now, last_pass_at, OVERNIGHT_WINDOW) is due


# ---------------------------------------------------------------------------
# Scenes: the real loop thread, through start_retention_loop
# ---------------------------------------------------------------------------


def test_restart_outside_the_window_skips_a_recent_pass(loop: LoopHarness) -> None:
    """The point of the change: a restart at 14:00 must not rerun the pass
    that already ran at 03:00."""
    loop.now, loop.last_recorded = _at(14), _at(3)

    loop.start()

    assert loop.passes == []


def test_restart_catches_up_when_the_last_pass_is_a_day_old(loop: LoopHarness) -> None:
    loop.now, loop.last_recorded = _at(14), _at(13, day=9)

    loop.start()

    assert loop.passes == [_at(14)]


def test_first_boot_runs_a_pass(loop: LoopHarness) -> None:
    loop.now, loop.last_recorded = _at(14), None

    loop.start()

    assert loop.passes == [_at(14)]


def test_restart_inside_the_window_runs_that_days_pass(loop: LoopHarness) -> None:
    loop.now, loop.last_recorded = _at(3, 30), _at(23, 30, day=9)

    loop.start()

    assert loop.passes == [_at(3, 30)]


def test_restart_inside_the_window_does_not_repeat_that_days_pass(loop: LoopHarness) -> None:
    loop.now, loop.last_recorded = _at(3, 30), _at(3)

    loop.start()

    assert loop.passes == []


def test_the_window_follows_the_env(
    loop: LoopHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same clock as the scene above, under a different window: 03:30 is
    no longer quiet hour, 22:10 is."""
    monkeypatch.setenv(START, "22")
    monkeypatch.setenv(END, "23")
    loop.now, loop.last_recorded = _at(3, 30), _at(23, 30, day=9)

    loop.start()
    assert loop.passes == []

    loop.advance_to(_at(22, 10))
    assert loop.passes == [_at(22, 10)]


def test_a_running_server_runs_one_pass_per_window(loop: LoopHarness) -> None:
    loop.now, loop.last_recorded = _at(14), _at(3)
    loop.start()

    loop.advance_to(_at(2, 58, day=11))
    assert loop.passes == []
    # Two minutes out, the loop sleeps exactly until the window opens
    # instead of its five-minute ceiling.
    assert loop.sleeps[-1] == 120.0

    loop.advance_to(_at(3, day=11))
    loop.advance_to(_at(3, 5, day=11))
    loop.advance_to(_at(4, 59, day=11))
    loop.advance_to(_at(14, day=11))
    assert loop.passes == [_at(3, day=11)]

    loop.advance_to(_at(3, day=12))
    assert loop.passes == [_at(3, day=11), _at(3, day=12)]


def test_a_failing_pass_waits_for_the_next_window(loop: LoopHarness) -> None:
    """A broken pass must not turn the quiet-hour schedule into a retry
    every few minutes, and must not kill the loop either."""
    loop.pass_fails = True
    loop.now, loop.last_recorded = _at(3, 30), _at(23, 30, day=9)
    loop.start()
    assert loop.passes == [_at(3, 30)]

    loop.advance_to(_at(3, 35))
    loop.advance_to(_at(4, 59))
    loop.advance_to(_at(14))
    assert loop.passes == [_at(3, 30)]

    loop.advance_to(_at(3, day=11))
    assert loop.passes == [_at(3, 30), _at(3, day=11)]


def test_an_invalid_window_fails_startup(
    loop: LoopHarness, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A bad value must stop the boot, not surface at three in the morning."""
    monkeypatch.setenv(START, "soon")

    with pytest.raises(MaintenanceScheduleError, match=START):
        retention.start_retention_loop()

    thread = retention._retention_thread
    assert thread is None or not thread.is_alive()
    assert loop.passes == []


def test_a_recorded_pass_is_what_the_next_boot_reads(
    session: Session, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The catch-up decision rests on ``maintenance_state``: what a pass
    writes there is what the next process start reads back."""
    monkeypatch.setattr(retention, "engine", test_engine)
    monkeypatch.setattr(retention, "run_maintenance_cleanup", lambda: {"trimmed": 1})
    assert retention._last_recorded_pass_at() is None

    before = datetime.now(timezone.utc)
    retention._run_and_record_maintenance_pass()
    after = datetime.now(timezone.utc)

    recorded = retention._last_recorded_pass_at()
    assert recorded is not None
    assert before <= recorded <= after
    # So a restart a moment later, with the quiet window still hours away,
    # has nothing to do.
    later_window = MaintenanceWindow(
        start_hour=(after.hour + 2) % 24, end_hour=(after.hour + 3) % 24
    )
    assert maintenance_pass_due(after, recorded, later_window) is False


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class LoopHarness:
    """The real maintenance thread, stepped one evaluation at a time.

    The clock, the recorded last pass, and the pass itself are replaced.
    Where the loop would sleep, it parks here until the test moves the clock,
    so every assertion runs against a loop that has finished deciding.
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.now: datetime = _at(14)
        self.last_recorded: datetime | None = None
        self.pass_fails: bool = False
        self.passes: list[datetime] = []
        self.sleeps: list[float] = []
        self._parked: threading.Event = threading.Event()
        self._resume: threading.Event = threading.Event()
        real_sleep = retention._seconds_until_next_check

        def run_pass() -> None:
            self.passes.append(self.now)
            if self.pass_fails:
                raise RuntimeError("maintenance exploded")

        def park(
            now: datetime, last_attempt_at: datetime | None, window: MaintenanceWindow
        ) -> float:
            self.sleeps.append(real_sleep(now, last_attempt_at, window))
            self._parked.set()
            self._resume.wait(timeout=10)
            self._resume.clear()
            return 0.001

        monkeypatch.setattr(retention, "_utcnow", lambda: self.now)
        monkeypatch.setattr(retention, "_last_recorded_pass_at", lambda: self.last_recorded)
        monkeypatch.setattr(retention, "_run_and_record_maintenance_pass", run_pass)
        monkeypatch.setattr(retention, "_seconds_until_next_check", park)

    def start(self) -> None:
        retention.start_retention_loop()
        self._wait_until_parked()

    def advance_to(self, now: datetime) -> None:
        """Move the clock and let the loop take one more look."""
        self.now = now
        self._parked.clear()
        self._resume.set()
        self._wait_until_parked()

    def stop(self) -> None:
        retention.stop_retention_loop()
        self._resume.set()
        thread = retention._retention_thread
        if thread is not None:
            thread.join(timeout=10)
            assert not thread.is_alive(), "the maintenance loop did not stop"

    def _wait_until_parked(self) -> None:
        assert self._parked.wait(timeout=10), "the maintenance loop never reached its sleep"
