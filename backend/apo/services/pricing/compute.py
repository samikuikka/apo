"""SPEC-136 ticket 06: the single cost compute function.

``compute_cost`` is used by ingestion AND re-pricing AND the match endpoint.
It resolves era -> tier -> prices, then computes a per-dimension breakdown
(micro-USD int, rounded per dimension) whose sum is the total.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

from sqlmodel import Session

from .resolution import load_tier_prices, match_tier, resolve_model_era

logger = logging.getLogger(__name__)


@dataclass
class ComputedCost:
    """The result of compute_cost: a per-dimension breakdown + reconciled total.

    ``breakdown`` is keyed by UsageKey value -> micro-USD int.
    ``total`` defaults to the sum of breakdown values if not supplied.
    """

    model_id: int | None = None
    tier_id: int | None = None
    tier_name: str | None = None
    breakdown: dict[str, int] = field(default_factory=dict)
    _total: int | None = None

    @property
    def total(self) -> int:
        if self._total is not None:
            return self._total
        return sum(self.breakdown.values())

    @total.setter
    def total(self, value: int) -> None:
        self._total = value


def compute_cost(
    session: Session,
    model_name: str,
    raw_usage: dict[str, int],
    project: str,
    at_time: datetime,
) -> ComputedCost | None:
    """Resolve model+usage -> per-dimension cost breakdown (micro-USD int).

    Returns ``None`` when no model-era resolves. Keys present in usage but
    unpriced are skipped (contribute 0). Negative token counts are clamped to
    0 with a warning. ``total = sum(breakdown.values())`` (reconciles exactly).

    Per-dimension cost: ``round(price_stored * tokens / 1_000_000)`` where
    ``price_stored`` is micro-USD-per-1M tokens.
    """
    model = resolve_model_era(session, model_name, project, at_time)
    if model is None or model.id is None:
        return None

    tier = match_tier(session, model, raw_usage)
    assert tier.id is not None  # populated by the DB on insert
    prices = load_tier_prices(session, tier.id)

    breakdown: dict[str, int] = {}
    for key_str, units in raw_usage.items():
        price_per_1m = prices.get(key_str)
        if price_per_1m is None:
            # Key in usage but unpriced for this tier -> skip (contributes 0).
            continue
        if units < 0:
            logger.warning("negative token count for %s on %s: %d; clamping to 0", key_str, model_name, units)
            units = 0
        # micro-USD per 1M tokens * tokens / 1M = micro-USD for this dimension.
        cost_for_dim = round(price_per_1m * units / 1_000_000)
        if cost_for_dim == 0:
            # Zero-cost dimensions are omitted: they don't affect the total and
            # the display hides zero-cost rows anyway. Keeps breakdowns clean.
            continue
        breakdown[key_str] = cost_for_dim

    return ComputedCost(
        model_id=model.id,
        tier_id=tier.id,
        tier_name=tier.name,
        breakdown=breakdown,
    )


__all__ = ["ComputedCost", "compute_cost"]
