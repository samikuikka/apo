"""A controllable monotonic clock for TTL/window tests.

Patches the ``monotonic`` seam in ``apo.auth.api_key_cache`` and
``apo.auth.rate_limit`` so expiry windows are advanced instead of slept.
The epoch sits far above any real ``time.monotonic()`` value (Linux reads
machine uptime), so an entry accidentally written with the real clock
reads as expired under the fake one instead of never expiring.
"""

# pyright: reportUnusedCallResult=false

from __future__ import annotations

from _pytest.monkeypatch import MonkeyPatch

EPOCH = 1.0e12


class FakeClock:
    """Patches a module's clock seam; tests call ``advance`` instead of sleeping."""

    def __init__(self) -> None:
        self._elapsed: float = 0.0

    def __call__(self) -> float:
        return EPOCH + self._elapsed

    def advance(self, seconds: float) -> None:
        self._elapsed += seconds


def install_fake_clock(monkeypatch: MonkeyPatch, module: object) -> FakeClock:
    """Patch ``module.monotonic`` (the clock seam) and return the clock."""
    clock = FakeClock()
    monkeypatch.setattr(module, "monotonic", clock)
    return clock
