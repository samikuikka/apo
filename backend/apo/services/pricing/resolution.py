"""Tickets 04/05: model-era resolution + tier matching.

Resolution order (3-step pipeline):
  1. Resolve model era (match_pattern + temporal predicate -> one models row)
  2. Resolve tier within that model (first non-default tier whose conditions
     all pass, else the default tier)
  3. Look up prices (model_id, tier_id, usage_key) -> price

Tier conditions are evaluated on the call's usage only, never on time.
"""

# pyright: reportAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false
from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field as dataclass_field
from datetime import datetime

from sqlmodel import Session, col, select

from ...models.pricing import ModelRowDB, PriceDB, PricingTierDB
from ...models.serving import ServingMatch
from ...models.usage_keys import UsageKey
from ._timeutils import naive

logger = logging.getLogger(__name__)

GLOBAL_PROJECT = "__global__"


@dataclass
class _ParsedCondition:
    """A parsed tier condition (typed view of the stored JSON)."""

    keys: list[UsageKey]
    operator: str
    threshold: int


def _fullmatch(pattern: str, name: str) -> bool:
    """Anchored full-match, case-insensitive. Invalid regex -> exact equality.

    See ticket 10: ``re.fullmatch(pattern, name, re.IGNORECASE)``. Falls back
    to exact string equality (case-insensitive) if the pattern is invalid —
    never raises at match time.
    """
    try:
        return re.fullmatch(pattern, name, re.IGNORECASE) is not None
    except re.error:
        logger.warning("invalid match_pattern %r at match time; using exact match", pattern)
        return pattern.lower() == name.lower()


# Serving-selector columns on ModelRowDB, in ServingMatch field order.
_SELECTOR_COLUMNS = (
    "match_api_provider",
    "match_serving_host",
    "match_route",
    "match_service_tier",
)
_SELECTOR_KEYS = ("api_provider", "serving_host", "route", "service_tier")


@dataclass
class EraResolution:
    """Outcome of serving-qualified model-era resolution.

    ``row`` is the winning era or None. ``quality`` is "qualified" (the row
    carries at least one serving selector that matched the observation),
    "model_only" (a wildcard rate as an estimate), "ambiguous" (two
    incomparable maximal selectors; no winner, null cost), or "unpriced"
    (nothing matched).
    """

    row: ModelRowDB | None
    quality: str
    reason: str | None = None
    candidate_model_ids: list[int] = dataclass_field(default_factory=list)

    @property
    def matched_serving(self) -> "ServingMatch | None":
        if self.row is None or not _row_selectors(self.row):
            return None
        values = _row_selectors(self.row)
        return ServingMatch(
            api_provider=values.get("api_provider"),
            serving_host=values.get("serving_host"),
            route=values.get("route"),
            service_tier=values.get("service_tier"),
        )


def _row_selectors(row: ModelRowDB) -> dict[str, str]:
    return {
        key: getattr(row, column)
        for key, column in zip(_SELECTOR_KEYS, _SELECTOR_COLUMNS, strict=True)
        if getattr(row, column) is not None
    }


def _dominates(a: ModelRowDB, b: ModelRowDB) -> bool:
    """True when a's non-null selectors are a strict superset of b's with the
    same values. The wildcard row dominates nothing."""
    sa, sb = _row_selectors(a), _row_selectors(b)
    if not sa:
        return False
    return set(sa) > set(sb) and all(sa.get(k) == v for k, v in sb.items())


def resolve_model_era_qualified(
    session: Session,
    model_name: str,
    project: str,
    at_time: datetime,
    serving: "ServingMatch | None" = None,
) -> EraResolution:
    """Resolve the era with serving selectors, ambiguity over guesswork.

    Pipeline: pattern full-match on the observed model, selector
    compatibility (a concrete selector never matches an unknown observation),
    era containment, project-over-global shadowing scoped per
    (match_pattern, selector tuple) BEFORE era filtering (so an override's
    date gap never silently falls back to global pricing), then
    strict-superset dominance among the survivors. Two incomparable maximal
    candidates are ambiguous: no winner, deterministic candidate ids, never
    a choice by row order.
    """
    stmt = select(ModelRowDB).where(
        col(ModelRowDB.project).in_([project, GLOBAL_PROJECT]),
    )
    candidates = list(session.exec(stmt).all())
    if not candidates:
        return EraResolution(None, "unpriced", "no pricing rows in scope")

    observed = (
        {
            "api_provider": serving.api_provider,
            "serving_host": serving.serving_host,
            "route": serving.route,
            "service_tier": serving.service_tier,
        }
        if serving is not None
        else {}
    )

    def _selector_compatible(row: ModelRowDB) -> bool:
        # Selector values compare as anchored full matches: plain ids match
        # themselves, and migrated regex wildcards (legacy provider_pattern
        # semantics) keep working.
        for key, value in _row_selectors(row).items():
            observed_value = observed.get(key)
            if observed_value is None or not _fullmatch(value, observed_value):
                return False
        return True

    def _in_era(row: ModelRowDB) -> bool:
        if row.start_date is not None and naive(row.start_date) > naive(at_time):
            return False
        if row.end_date is not None and naive(row.end_date) <= naive(at_time):
            return False
        return True

    matching = [
        c
        for c in candidates
        if _fullmatch(c.match_pattern, model_name) and _selector_compatible(c)
    ]
    if not matching:
        return EraResolution(
            None,
            "unpriced",
            f"no era matches model {model_name!r} with the observed serving identity",
        )

    # Project shadowing per (match_pattern, selector tuple), scoped BEFORE the
    # era filter: a project override hides the global row in the same slot for
    # its whole series, and an override's date gap must not fall back to the
    # global row in that same slot.
    project_slots = {
        (c.match_pattern, tuple(sorted(_row_selectors(c).items())))
        for c in matching
        if c.project == project
    }
    visible = [
        c
        for c in matching
        if c.project == project
        or (c.match_pattern, tuple(sorted(_row_selectors(c).items())))
        not in project_slots
    ]

    in_era = [c for c in visible if _in_era(c)]
    if not in_era:
        return EraResolution(
            None,
            "unpriced",
            f"no era for model {model_name!r} covers {at_time.isoformat()}",
            sorted({c.id for c in visible if c.id is not None}),
        )

    # Maximal under strict-superset dominance: a candidate no other
    # candidate dominates. Two incomparable maximal candidates = ambiguous.
    winners = [
        c
        for c in in_era
        if not any(_dominates(o, c) for o in in_era if o is not c)
    ]
    if len(winners) > 1:
        return EraResolution(
            None,
            "ambiguous",
            "two incomparable serving selectors both match",
            sorted({c.id for c in winners if c.id is not None}),
        )
    winner = winners[0]
    quality = "qualified" if _row_selectors(winner) else "model_only"
    return EraResolution(winner, quality)


def resolve_model_era(
    session: Session,
    model_name: str,
    project: str,
    at_time: datetime,
    provider: str | None = None,
) -> ModelRowDB | None:
    """Back-compat wrapper: the winning row for (model, project, time).

    ``provider`` (the observed serving provider) maps onto the api-provider
    selector; a None observation resolves against wildcard rows. Callers that
    need the quality/reason/candidates use
    :func:`resolve_model_era_qualified`.
    """
    serving = ServingMatch(api_provider=provider) if provider else None
    return resolve_model_era_qualified(
        session, model_name, project, at_time, serving=serving
    ).row


def match_tier(
    session: Session,
    model: ModelRowDB,
    usage: dict[str, int],
) -> PricingTierDB:
    """Return the matched tier for (model, usage).

    Non-default tiers evaluated in ascending ``priority`` order; first whose
    all conditions pass (AND) wins; else the default tier. See ticket 05.

    A condition sums its ``keys`` from ``usage`` and compares to ``threshold``
    with ``operator``. Keys absent from ``usage`` contribute 0.
    """
    tiers = list(
        session.exec(
            select(PricingTierDB)
            .where(PricingTierDB.model_id == model.id)
            .order_by(col(PricingTierDB.priority).asc())
        ).all()
    )
    if not tiers:
        # Defensive: validation guarantees a default tier exists.
        raise RuntimeError(f"model {model.id} has no tiers")

    default: PricingTierDB | None = None
    for tier in tiers:
        if tier.is_default:
            default = tier
            continue
        if _all_conditions_pass(tier, usage):
            return tier
    if default is None:
        raise RuntimeError(f"model {model.id} has no default tier")
    return default


def _all_conditions_pass(tier: PricingTierDB, usage: dict[str, int]) -> bool:
    conditions = _parse_conditions(tier.conditions_json)
    if not conditions:
        return True
    for cond in conditions:
        total = sum(usage.get(k.value, 0) for k in cond.keys)
        threshold = cond.threshold
        if cond.operator == "gt" and not total > threshold:
            return False
        if cond.operator == "lt" and not total < threshold:
            return False
        if cond.operator == "gte" and not total >= threshold:
            return False
        if cond.operator == "lte" and not total <= threshold:
            return False
    return True


def _parse_conditions(conditions_json: str) -> list[_ParsedCondition]:
    """Parse the stored JSON conditions into typed structures.

    Stored shape: ``[{"keys": ["input", ...], "operator": "gt", "threshold": 200000}]``.
    """
    if not conditions_json:
        return []
    raw = json.loads(conditions_json)
    if not isinstance(raw, list):
        return []
    parsed: list[_ParsedCondition] = []
    for entry in raw:
        if not isinstance(entry, dict):
            continue
        keys_raw = entry.get("keys", [])
        if not isinstance(keys_raw, list):
            continue
        keys = [UsageKey(k) for k in keys_raw if isinstance(k, str)]
        threshold_raw = entry.get("threshold", 0)
        try:
            threshold = int(threshold_raw) if isinstance(threshold_raw, (int, str)) else 0
        except (TypeError, ValueError):
            threshold = 0
        op = str(entry.get("operator", ""))
        parsed.append(_ParsedCondition(keys=keys, operator=op, threshold=threshold))
    return parsed


def load_tier_prices(session: Session, tier_id: int) -> dict[str, int]:
    """Return ``{usage_key: price_per_1m (micro-USD int)}`` for one tier."""
    rows = session.exec(
        select(PriceDB).where(PriceDB.tier_id == tier_id)
    ).all()
    return {row.usage_key: row.price_per_1m for row in rows}


__all__ = [
    "resolve_model_era",
    "match_tier",
    "load_tier_prices",
]
