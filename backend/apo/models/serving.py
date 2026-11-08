# pyright: reportAny=false, reportExplicitAny=false

"""Serving identity, rates, and pricing-selector transport types.

One generation call reaches apo through an API provider (the service the
harness called), which may differ from the serving host (the organization
that actually executed inference), the route (the requested selection
policy), and the served service tier. These types carry that observed
identity, the speed evidence derived from it, and the serving selectors
that qualify a price row. Null always means unknown; unknown is never a
provider string.

Group key for summaries is ``(model, api_provider, serving_host, route,
service_tier)`` with nulls retained.
"""

from __future__ import annotations

from typing import Literal

from sqlmodel import Field, SQLModel

IdentityField = Literal[
    "instrumentation_provider",
    "api_provider",
    "serving_host",
    "route",
    "requested_service_tier",
    "service_tier",
    "request_model",
    "response_model",
]

# Byte bounds observed identity strings must respect. Model identifiers
# get the wider bound; every other identity field the narrower one.
MODEL_ID_MAX_BYTES = 255
IDENTITY_MAX_BYTES = 128


class IdentityEvidence(SQLModel):
    """Which attribute or documented adapter supplied an identity value."""

    source: str  # attribute key or documented convention adapter
    kind: Literal["reported", "configured", "convention"]


class ServingIdentity(SQLModel):
    model: str | None = None  # response model, else existing normalized model
    instrumentation_provider: str | None = None
    api_provider: str | None = None
    serving_host: str | None = None
    route: str | None = None
    requested_service_tier: str | None = None
    service_tier: str | None = None
    request_model: str | None = None
    response_model: str | None = None
    evidence: dict[IdentityField, IdentityEvidence] = Field(default_factory=dict)


class GenerationRates(SQLModel):
    time_to_first_token_ms: float | None = None
    whole_call_output_tokens_per_second: float | None = None
    streaming_output_tokens_per_second: float | None = None
    output_token_scope: Literal["text", "all_output", "unknown"] = "unknown"
    streaming_unavailable_reason: Literal[
        "missing_timing",
        "invalid_timing",
        "missing_usage",
        "scope_mismatch",
        "unknown_scope",
        "incomplete_call",
        "aggregate_only",
    ] | None = None


class RateSummary(SQLModel):
    median: float | None = None
    samples: int = 0


class ScopedRates(SQLModel):
    scope: Literal["text", "all_output", "unknown"]
    whole_call_rate: RateSummary = Field(default_factory=RateSummary)
    streaming_rate: RateSummary = Field(default_factory=RateSummary)


class ServingGroup(SQLModel):
    identity: ServingIdentity
    calls: int = 0
    errored_calls: int = 0
    whole_call_rate: RateSummary = Field(default_factory=RateSummary)
    streaming_rate: RateSummary = Field(default_factory=RateSummary)
    rate_scopes: list[ScopedRates] = Field(default_factory=list)


class CostCoverage(SQLModel):
    # Nullable sums in micro-USD; null = no eligible priced observations.
    reported: int | None = None
    qualified_estimate: int | None = None
    model_only_estimate: int | None = None
    unpriced_calls: int = 0
    ambiguous_calls: int = 0
    excluded_error_calls: int = 0
    aggregate_charge_observations: int = 0
    partial: bool = False


class ServingSummary(SQLModel):
    state: Literal["no_data", "unknown", "uniform", "mixed", "partial"]
    calls: int
    errored_calls: int
    unknown_provider_calls: int
    unknown_host_calls: int
    aggregate_observations: int
    groups: list[ServingGroup]
    total_groups: int
    groups_truncated: bool
    # Required, including zero on Task Runs; meaningful on Batch responses.
    task_runs_with_evidence: int
    task_runs_total: int
    cost_coverage: CostCoverage = Field(default_factory=CostCoverage)


class ServingMatch(SQLModel):
    """Price-row selector. Null fields are wildcards."""

    api_provider: str | None = None
    serving_host: str | None = None
    route: str | None = None
    service_tier: str | None = None


class ServingFilter(SQLModel):
    observed_models: list[str] = Field(default_factory=list)
    providers: list[str] = Field(default_factory=list)
    hosts: list[str] = Field(default_factory=list)
    routes: list[str] = Field(default_factory=list)
    service_tiers: list[str] = Field(default_factory=list)
    unknown: list[Literal["model", "provider", "host", "route", "service_tier"]] = (
        Field(default_factory=list)
    )
    mode: Literal["contains", "only"] = "contains"


__all__ = [
    "CostCoverage",
    "GenerationRates",
    "IdentityEvidence",
    "IdentityField",
    "IDENTITY_MAX_BYTES",
    "MODEL_ID_MAX_BYTES",
    "RateSummary",
    "ScopedRates",
    "ServingFilter",
    "ServingGroup",
    "ServingIdentity",
    "ServingMatch",
    "ServingSummary",
]
