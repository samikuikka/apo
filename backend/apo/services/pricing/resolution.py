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
from dataclasses import dataclass
from datetime import datetime

from sqlmodel import Session, col, select

from ...models.pricing import ModelRowDB, PriceDB, PricingTierDB
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


def resolve_model_era(
    session: Session,
    model_name: str,
    project: str,
    at_time: datetime,
    provider: str | None = None,
) -> ModelRowDB | None:
    """Find the active model-era row for (model_name, project) at ``at_time``.

    Loads rows where ``project IN (project, "__global__")`` AND
    ``match_pattern`` full-matches ``model_name``. Among matches, selects the
    era whose ``[start_date, end_date)`` contains ``at_time``
    (``start_date IS NULL`` matches any time, for legacy seed rows).

    Project overrides shadow globals per ``match_pattern``.

    ``provider`` (issue #307) is the call's *observed* serving provider —
    never a guess from the model name. A row with a non-empty
    ``provider_pattern`` matches only when that pattern full-matches it;
    rows without one match any provider. Resolution precedence among rows
    that match the model and are active at ``at_time``:

      1. provider-qualified (pattern matches the observed provider)
      2. provider-agnostic

    so the same model served by two hosts bills at each host's rate, and a
    call whose provider has no qualified era — or whose qualified era's
    time window doesn't cover it — falls back to the agnostic rate instead
    of going unpriced. Project rows shadow globals *per slot*: a project's
    ``(match_pattern, provider_pattern)`` era hides the global era in that
    same slot, but never the global fallback in the other slot (a project
    adding a per-host rate keeps the global base rate for its other hosts).
    """
    stmt = select(ModelRowDB).where(
        col(ModelRowDB.project).in_([project, GLOBAL_PROJECT]),
    )
    candidates = list(session.exec(stmt).all())
    if not candidates:
        return None

    # Project rows shadow globals per (match_pattern, provider_pattern) slot.
    project_slots = {
        (c.match_pattern, c.provider_pattern) for c in candidates if c.project == project
    }
    visible = [
        c
        for c in candidates
        if c.project == project or (c.match_pattern, c.provider_pattern) not in project_slots
    ]

    # Filter to full-matching patterns.
    matching = [c for c in visible if _fullmatch(c.match_pattern, model_name)]
    if not matching:
        return None

    # Filter to the era whose [start_date, end_date) contains at_time.
    # start_date IS NULL -> matches any lower bound (legacy seed rows).
    def _in_era(row: ModelRowDB) -> bool:
        if row.start_date is not None:
            if naive(row.start_date) > naive(at_time):
                return False
        if row.end_date is not None:
            if naive(row.end_date) <= naive(at_time):
                return False
        return True

    # Provider qualification (issue #307) applies AFTER the era filter: a
    # qualified row competes only when its pattern matches the observed
    # provider AND its window covers the call; otherwise the call falls
    # back to the agnostic rows rather than resolving to nothing (which
    # would mark history unpriced the moment a per-host era appears).
    def _qualified(row: ModelRowDB) -> bool:
        return bool(
            row.provider_pattern
            and provider
            and _fullmatch(row.provider_pattern, provider)
        )

    qualified_in_era = [c for c in matching if _qualified(c) and _in_era(c)]
    if qualified_in_era:
        in_era = qualified_in_era
    else:
        in_era = [c for c in matching if not c.provider_pattern and _in_era(c)]
    if not in_era:
        return None

    # Exactly one era should be active (overlap invariant, ticket 04). If a
    # data bug ever yields two, prefer the project row then the latest start.
    in_era.sort(
        key=lambda r: (r.project == project, r.start_date or datetime.min.replace(tzinfo=None)),
        reverse=True,
    )
    return in_era[0]


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
