# pyright: reportAny=false, reportExplicitAny=false, reportUnknownArgumentType=false, reportUnusedParameter=false

"""Tickets 04/05: tier-graph + era validation.

Enforces write-time invariants so the resolution/compute layers can assume
they hold:
  - (A) exactly one default tier per model (ticket 05)
  - (B) the same usage_key set across all tiers of a model (ticket 05)
  - (C) a model's match_pattern is a valid regex (ticket 04)
  - (D) eras for the same (project, match_pattern) do not overlap (ticket 04)

Raises ``TierValidationError`` (caught by routes -> HTTP 422) on violation.
"""

from __future__ import annotations

import re
from datetime import datetime

from sqlmodel import Session, select

from ...models.pricing import ModelDocumentCreate, ModelRowDB
from ...models.serving import ServingMatch
from ._timeutils import naive


class TierValidationError(ValueError):
    """A tier-graph or era invariant was violated. Maps to HTTP 422."""


def validate_match_pattern(pattern: str) -> None:
    """Reject invalid regex at write time (ticket 04)."""
    try:
        _ = re.compile(pattern)
    except re.error as exc:
        raise TierValidationError(f"invalid match_pattern regex {pattern!r}: {exc}") from exc


def validate_model_document(doc: ModelDocumentCreate) -> None:
    """Validate the tier graph of a create/replace payload (tickets 05).

    Checks: exactly one default tier, same usage_key set across tiers, valid
    regex. Era overlap against existing DB rows is checked separately
    (``validate_era_no_overlap``) because it needs the session.
    """
    validate_match_pattern(doc.match_pattern)

    tiers = doc.pricing_tiers
    if not tiers:
        raise TierValidationError("model must have at least one pricing tier")

    defaults = [t for t in tiers if t.is_default]
    if len(defaults) != 1:
        raise TierValidationError(
            f"exactly one default tier is required per model; found {len(defaults)}"
        )

    # Same usage_key set across all tiers (ticket 05 rule C). Omitted keys are
    # unpriced; the set of PRICED keys must match tier-to-tier so a matched
    # tier always has a price for every dimension the model prices.
    key_sets: list[frozenset[str]] = []
    for tier in tiers:
        keys = frozenset(tier.prices.to_dict().keys())
        key_sets.append(keys)
    if len(set(key_sets)) > 1:
        raise TierValidationError(
            "all tiers of a model must price the same set of usage keys; "
            + f"got {[sorted(k) for k in key_sets]}"
        )

    # Priorities unique among non-default tiers (deterministic match order).
    priorities = [t.priority for t in tiers if not t.is_default]
    if len(priorities) != len(set(priorities)):
        raise TierValidationError("non-default tiers must have unique priorities")


def validate_era_no_overlap(
    session: Session,
    *,
    project: str,
    match_pattern: str,
    start_date: datetime | None,
    end_date: datetime | None,
    provider_pattern: str | None = None,
    serving_match: "ServingMatch | None" = None,
    exclude_model_id: int | None = None,
) -> None:
    """Reject overlapping eras in the same (project, match_pattern, serving
    selector) slot (ticket 04; selector slot per issue #307).

    One-era-active-per-slot is a data invariant: dominance resolution relies
    on at most one era per selector slot being active at any ``at_time``. A
    selector-qualified era may overlap the wildcard era of the same model —
    that is the "same model, two serving setups, each at its rate"
    configuration, and resolution orders the more specific selector first.
    """
    from sqlmodel import col

    stmt = select(ModelRowDB).where(
        ModelRowDB.project == project,
        ModelRowDB.match_pattern == match_pattern,
    )
    selector_values = (
        (
            serving_match.api_provider if serving_match is not None else None,
            serving_match.serving_host if serving_match is not None else None,
            serving_match.route if serving_match is not None else None,
            serving_match.service_tier if serving_match is not None else None,
        ),
    )
    for column, value in zip(
        (
            ModelRowDB.match_api_provider,
            ModelRowDB.match_serving_host,
            ModelRowDB.match_route,
            ModelRowDB.match_service_tier,
        ),
        selector_values[0],
        strict=True,
    ):
        if value is None:
            stmt = stmt.where(col(column).is_(None))
        else:
            stmt = stmt.where(col(column) == value)
    if exclude_model_id is not None:
        stmt = stmt.where(ModelRowDB.id != exclude_model_id)
    existing = list(session.exec(stmt).all())
    if not existing:
        return

    for other in existing:
        if _eras_overlap(start_date, end_date, other.start_date, other.end_date):
            slot = _slot_label(selector_values[0])
            raise TierValidationError(
                f"era window overlaps an existing era for {match_pattern!r}{slot} in "
                + f"project {project!r} (existing {other.start_date}..{other.end_date})"
            )


def _slot_label(selectors: tuple[str | None, ...]) -> str:
    parts = [
        f"{name}={value!r}"
        for name, value in zip(
            ("provider", "host", "route", "tier"), selectors, strict=True
        )
        if value is not None
    ]
    return f" ({', '.join(parts)})" if parts else ""


def _eras_overlap(
    a_start: datetime | None,
    a_end: datetime | None,
    b_start: datetime | None,
    b_end: datetime | None,
) -> bool:
    """Half-open [start, end) overlap. ``start IS NULL`` means -inf on the
    lower bound (legacy seed rows = always active on the lower bound)."""
    # A NULL start means "no lower bound" — treat as -inf for overlap math.
    a_lo = a_start if a_start is not None else datetime.min.replace(tzinfo=None)
    b_lo = b_start if b_start is not None else datetime.min.replace(tzinfo=None)
    # A NULL end means "open" — treat as +inf.
    a_hi = a_end if a_end is not None else datetime.max.replace(tzinfo=None)
    b_hi = b_end if b_end is not None else datetime.max.replace(tzinfo=None)

    # Normalize tz-awareness for comparison.
    return naive(a_lo) < naive(b_hi) and naive(b_lo) < naive(a_hi)


__all__ = [
    "TierValidationError",
    "validate_match_pattern",
    "validate_model_document",
    "validate_era_no_overlap",
]
