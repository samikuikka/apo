"""The single cost compute function.

``compute_cost`` is used by ingestion AND re-pricing AND the match endpoint.
It resolves era -> tier -> prices, then computes a per-dimension breakdown
(micro-USD int, rounded per dimension) whose sum is the total.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime

from sqlmodel import Session

from ...models.serving import ServingMatch
from ...models.usage_keys import UsageKey
from .resolution import load_tier_prices, match_tier, resolve_model_era_qualified

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
    # Serving-qualified pricing outcome markers (issue #307).
    pricing_quality: str | None = None
    matched_serving: "ServingMatch | None" = None
    reason: str | None = None
    candidate_model_ids: list[int] = field(default_factory=list)
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
    provider: str | None = None,
    serving: "ServingMatch | None" = None,
) -> ComputedCost | None:
    """Resolve model+usage -> per-dimension cost breakdown (micro-USD int).

    Returns ``None`` when no model-era resolves. Keys present in usage but
    unpriced are skipped (contribute 0). Negative token counts are clamped to
    0 with a warning. ``total = sum(breakdown.values())`` (reconciles exactly).

    Per-dimension cost: ``round(price_stored * tokens / 1_000_000)`` where
    ``price_stored`` is micro-USD-per-1M tokens.

    ``serving`` (issue #307) is the call's observed serving identity; a
    pricing row with matching selectors dominates less-specific rows, and an
    ambiguous pair yields no winner. ``provider`` maps onto the api-provider
    selector for callers that only know the provider. The result carries
    ``pricing_quality`` ("qualified" / "model_only" / "ambiguous") and the
    matched selector for persistence.
    """
    if serving is None and provider:
        serving = ServingMatch(api_provider=provider)
    resolution = resolve_model_era_qualified(
        session, model_name, project, at_time, serving=serving
    )
    if resolution.row is None and "/" in model_name:
        # Routers like OpenRouter prefix the model with a provider slug
        # (e.g. "google/gemini-2.5-flash-lite"), but the pricing table keys on
        # the bare model name. Retry with the slug stripped so routed models
        # resolve against the same entries as direct-API models.
        stripped = model_name.rsplit("/", 1)[-1]
        if stripped != model_name:
            resolution = resolve_model_era_qualified(
                session, stripped, project, at_time, serving=serving
            )
    model = resolution.row
    if model is None or model.id is None:
        if resolution.quality == "ambiguous":
            return ComputedCost(
                pricing_quality="ambiguous",
                reason=resolution.reason,
                candidate_model_ids=resolution.candidate_model_ids,
            )
        return None

    tier = match_tier(session, model, raw_usage)
    assert tier.id is not None  # populated by the DB on insert
    prices = load_tier_prices(session, tier.id)

    breakdown: dict[str, int] = {}
    for key_str, units in raw_usage.items():
        price_per_1m = prices.get(key_str)
        if price_per_1m is None:
            # Issue #143: reasoning tokens billed as output when no separate
            # reasoning price row exists. Providers bill reasoning as output
            # tokens when they don't price it separately. Without this fallback,
            # the normalizer's split of reasoning out of output makes reasoning
            # free — the tokens vanish from both the output bill and any bill.
            if key_str == UsageKey.REASONING.value and UsageKey.OUTPUT.value in prices:
                price_per_1m = prices[UsageKey.OUTPUT.value]
            else:
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
        pricing_quality=resolution.quality,
        matched_serving=resolution.matched_serving,
        reason=resolution.reason,
        candidate_model_ids=resolution.candidate_model_ids,
    )


__all__ = ["ComputedCost", "compute_cost"]
