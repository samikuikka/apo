# pyright: reportAny=false, reportExplicitAny=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false

"""SPEC-136 ticket 06: the shared cost-application seam.

Both ingestion paths (the canonical ``TraceProjector._apply_cost`` and the
legacy direct-writer ``process_call_create``/``process_call_update``) call into
``apply_cost_to_call``. The backend is the single normalizer: this function
normalizes the span's usage, then either freezes a SDK-provided cost verbatim
or computes the per-dimension breakdown.

Compute precedence: **provided wins verbatim, else compute.**
  - SDK cost provided -> freeze verbatim; provenance "provided". A provided
    breakdown map is frozen as-is (total = sum); a provided scalar is frozen
    as total with breakdown null.
  - Else -> compute_cost(...) and freeze breakdown + total; provenance "computed".
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Any

from sqlmodel import Session

from ...models.db import LoggedCallDB
from .compute import compute_cost

logger = logging.getLogger(__name__)


def apply_cost_to_call(
    session: Session,
    call: LoggedCallDB,
    *,
    attributes: dict[str, Any],
    provider: str | None = None,
    project: str,
    at_time: datetime,
) -> None:
    """Normalize usage + freeze cost onto ``call`` (in place).

    ``attributes`` is the OTel span's attribute map (or a legacy dict carrying
    the same usage keys). ``provider`` may be supplied directly; otherwise the
    normalizer detects it from the attributes + model name. ``project`` scopes
    pricing resolution; ``at_time`` selects the era (the call's start_time).

    Only mutates ``call``; does not commit. Swallows compute errors (cost is
    non-fatal to ingestion) but logs them at debug level.
    """
    from ..usage_normalization import normalize_usage  # local import; avoid cycle

    try:
        raw_usage = normalize_usage(attributes, provider, model_name=call.model or None)
    except Exception:  # normalization must never break ingestion
        logger.debug("usage normalization failed for call %s; skipping cost", call.id)
        return

    # Store the normalized raw usage (for re-pricing + debug), even on no-match.
    call.raw_usage = raw_usage or None

    # Provided-wins-verbatim: if the SDK supplied a cost, freeze it and stop.
    if call.provided_cost is not None:
        call.cost_provenance = "provided"
        if call.cost is None:
            call.cost = call.provided_cost
        # No breakdown from compute; a provided breakdown would have to be
        # supplied separately by the SDK (not currently plumbed). Breakdown
        # stays whatever the caller set (None unless the SDK gave one).
        return

    try:
        result = compute_cost(session, call.model, raw_usage, project, at_time)
    except Exception:
        logger.debug("cost compute failed for call %s; skipping cost", call.id)
        return

    if result is None:
        # No matching model-era: cost stays null, but raw_usage is still stored.
        call.cost_provenance = None
        return

    call.cost = result.total
    call.cost_breakdown = result.breakdown or None
    call.internal_model_id = result.model_id
    call.matched_tier_id = result.tier_id
    call.matched_tier_name = result.tier_name
    call.cost_provenance = "computed"


__all__ = ["apply_cost_to_call"]
