"""SPEC-136 pricing services: resolution, compute, validation, JSON loader.

Public API:
  - ``resolve_model_era`` — find the active model-era row for (model, project, time)
  - ``match_tier`` — pick the tier for (model, usage)
  - ``compute_cost`` — the single compute function (ingestion + reprice + match)
  - ``json_conditions`` — serialize TierConditions for DB storage
  - ``load_default_prices`` — the JSON-defaults loader (ticket 07)
"""

from __future__ import annotations

import json

from ...models.pricing import TierCondition
from .compute import ComputedCost, compute_cost
from .loader import load_default_prices
from .resolution import load_tier_prices, match_tier, resolve_model_era
from .validation import (
    TierValidationError,
    validate_era_no_overlap,
    validate_match_pattern,
    validate_model_document,
)


def json_conditions(conditions: list[TierCondition]) -> str:
    """Serialize a list of TierConditions into the DB JSON column shape.

    Inverse of ``resolution._parse_conditions``.
    """
    return json.dumps(
        [
            {
                "keys": [k.value for k in c.keys],
                "operator": c.operator,
                "threshold": c.threshold,
            }
            for c in conditions
        ]
    )


def json_conditions(conditions: list[TierCondition]) -> str:
    """Serialize a list of TierConditions into the DB JSON column shape.

    Inverse of ``resolution._parse_conditions``.
    """
    return json.dumps(
        [
            {
                "keys": [k.value for k in c.keys],
                "operator": c.operator,
                "threshold": c.threshold,
            }
            for c in conditions
        ]
    )


__all__ = [
    "ComputedCost",
    "TierValidationError",
    "compute_cost",
    "json_conditions",
    "load_default_prices",
    "load_tier_prices",
    "match_tier",
    "resolve_model_era",
    "validate_era_no_overlap",
    "validate_match_pattern",
    "validate_model_document",
]
