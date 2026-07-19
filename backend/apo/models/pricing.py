# pyright: reportIncompatibleVariableOverride=false

"""SPEC-136 pricing data model + nested-document schemas.

Replaces the flat ``ModelDefinitionDB`` single-table system with a normalized
``(model, tier, usage_key) -> price`` model:

  models -> pricing_tiers -> prices

- ``models``: one row per (model era, project). Same ``match_pattern`` across
  eras; ``[start_date, end_date)`` selects the era.
- ``pricing_tiers``: a tier within a model. Exactly one tier per model has
  ``is_default=True``. Conditions are usage-only (ticket 05).
- ``prices``: the price for one ``(model, tier, usage_key)`` triple, stored as
  micro-USD per 1M tokens (INTEGER). E.g. ``2_500_000`` = $2.50/MTok.

Per-call storage (``cost_breakdown``, ``raw_usage``, provenance) lives on
``LoggedCallDB`` (see ``models/schemas.py``).
"""

from datetime import datetime, timezone
from typing import ClassVar

from sqlalchemy import Column, DateTime
from sqlalchemy.sql import func
from sqlmodel import Field, SQLModel

from .usage_keys import UsageKey

# The set of operators a TierCondition may use (ticket 05: threshold-only;
# eq/neq and arbitrary regex dropped).
TIER_OPERATORS: frozenset[str] = frozenset({"gt", "lt", "gte", "lte"})

__global__ = "__global__"


# ============================================================================
# DB tables (3-table shape)
# ============================================================================


class ModelRowDB(SQLModel, table=True):
    """One row per (model era, project).

    Same ``match_pattern`` across eras; ``start_date``/``end_date`` select the
    era. ``start_date IS NULL`` marks legacy seed rows (pre-windowing) so the
    temporal predicate matches them for any ``call.start_time``. See ticket 04.
    """

    __tablename__: ClassVar[str] = "models"

    id: int | None = Field(default=None, primary_key=True)
    project: str = Field(default=__global__, index=True)
    match_pattern: str = Field(index=True)
    provider: str = Field(index=True)
    display_name: str = Field(default="")

    # Time-window (ticket 04). Half-open [start_date, end_date); NULL end = open.
    start_date: datetime | None = Field(default=None, index=True)
    end_date: datetime | None = Field(default=None)

    # Pinned from JSON (ticket 07); the loader uses exact-equality vs DB for
    # idempotency, so this is NOT a server_default / onupdate clock.
    updated_at: str = Field(default="")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True), server_default=func.now()),
    )


class PricingTierDB(SQLModel, table=True):
    """A tier within a model. Exactly one tier per model has ``is_default=True``.

    Conditions are usage-only (never time). See ticket 05.
    """

    __tablename__: ClassVar[str] = "pricing_tiers"

    id: int | None = Field(default=None, primary_key=True)
    model_id: int = Field(foreign_key="models.id", index=True, ondelete="CASCADE")
    name: str = Field(default="default")
    is_default: bool = Field(default=False, index=True)
    priority: int = Field(default=0)  # ascending; first-all-pass wins
    # JSON column: list of {keys: [UsageKey,...], operator, threshold}.
    # NULL/[] => always matches (the default tier).
    conditions_json: str = Field(default="[]")


class PriceDB(SQLModel, table=True):
    """Price for one (model, tier, usage_key).

    micro-USD per 1M tokens (INTEGER). E.g. ``2_500_000`` = $2.50/MTok.
    One row per (tier, UsageKey) the model prices. See ticket 02.
    """

    __tablename__: ClassVar[str] = "prices"

    id: int | None = Field(default=None, primary_key=True)
    model_id: int = Field(foreign_key="models.id", index=True, ondelete="CASCADE")
    tier_id: int = Field(foreign_key="pricing_tiers.id", index=True, ondelete="CASCADE")
    usage_key: str = Field(index=True)  # UsageKey value
    price_per_1m: int = Field(default=0)  # micro-USD per 1M tokens (int)


# ============================================================================
# Nested-document schemas (API + JSON-defaults shape, ticket 07/10)
# ============================================================================


class TierCondition(SQLModel):
    """One condition on a tier.

    Sum the named keys, compare to ``threshold`` with ``operator``. See ticket
    05: threshold-only; eq/neq and arbitrary regex dropped.
    """

    keys: list[UsageKey]
    operator: str  # "gt" | "lt" | "gte" | "lte"
    threshold: int

    def model_post_init(self, __context: object) -> None:
        if self.operator not in TIER_OPERATORS:
            raise ValueError(
                f"invalid tier operator {self.operator!r}; allowed: {sorted(TIER_OPERATORS)}"
            )


class PriceMap(SQLModel):
    """Prices keyed by canonical UsageKey, in USD-per-1M (human-readable).

    Converted to micro-USD-per-1M INTEGER at load/write time
    (``round(usd_per_1m * 1_000_000)``). Omitted keys are unpriced for the tier.
    """

    input: float | None = None
    cache_read: float | None = None
    cache_write_5m: float | None = None
    cache_write_1h: float | None = None
    output: float | None = None
    reasoning: float | None = None

    def to_dict(self) -> dict[str, float]:
        """Return only the priced keys as {usage_key_value: usd_per_1m}."""
        out: dict[str, float] = {}
        for key in UsageKey:
            val = getattr(self, key.value)
            if val is not None:
                out[key.value] = float(val)
        return out


class TierDocument(SQLModel):
    """A tier within a ModelDocument (nested)."""

    name: str = "default"
    is_default: bool = False
    priority: int = 0
    conditions: list[TierCondition] = Field(default_factory=list)
    prices: PriceMap = Field(default_factory=PriceMap)


class ModelDocumentCreate(SQLModel):
    """Nested create/replace payload (API + identical to a JSON-defaults entry).

    Prices are USD-per-1M (human-readable). Same shape as a JSON-defaults entry
    (ticket 10: "API call = seed entry verbatim").
    """

    project: str = __global__
    match_pattern: str
    provider: str
    display_name: str = ""
    start_date: datetime | None = None
    end_date: datetime | None = None
    updated_at: str = ""  # pinned from JSON; empty for API writes
    pricing_tiers: list[TierDocument] = Field(default_factory=list)


class ModelDocument(ModelDocumentCreate):
    """A read-back model document with the assigned DB id + resolved era end."""

    id: int


class MatchResponse(SQLModel):
    """Response for GET /api/v1/models/match.

    ``cost_breakdown`` is keyed by UsageKey value -> micro-USD int (same as
    stored on a call). ``matched=False`` when no model-era resolves.
    """

    matched: bool = False
    model_id: int | None = None
    match_pattern: str | None = None
    provider: str | None = None
    display_name: str | None = None
    matched_tier_id: int | None = None
    matched_tier_name: str | None = None
    cost_breakdown: dict[str, int] | None = None
    total_cost: int | None = None  # micro-USD int
