"""Serving rollups: request accounting, rates, coverage, and filters.

The read side of serving identity. One generation call reached apo through
an API provider, was executed by a serving host, under a route and a
service tier; this module groups that evidence into the summaries the run,
batch, view, and comparison surfaces render, computes whole-call and
streaming output rates with their scope caveats, classifies cost coverage,
and answers the same-request filter predicate every surface shares.

Pure computations live above; the DB-facing helpers below them load call
rows in batched, project-scoped queries (never per-run N+1).

Error semantics mirror ``trace_backend``: a call whose ``level`` is
``ERROR`` counts in ``calls``/``errored_calls`` but never enters a rate
median and is excluded from cost totals (surfaced via
``CostCoverage.excluded_error_calls``), because a failed call's usage and
timing are not measurements.
"""

# pyright: reportAny=false, reportExplicitAny=false, reportArgumentType=false, reportUnusedCallResult=false

from __future__ import annotations

import math
import statistics
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timedelta
from typing import Literal

from sqlalchemy.orm import defer
from sqlmodel import Session, col, select

from ..models.db import LoggedCallDB
from ..models.serving import (
    CostCoverage,
    GenerationRates,
    RateSummary,
    ScopedRates,
    ServingFilter,
    ServingGroup,
    ServingIdentity,
    ServingSummary,
)

# Inline summaries cap: the bounded ``serving`` object on run/batch rows.
# The breakdown endpoint pages the complete set instead of truncating.
INLINE_GROUP_CAP = 20

ServingScope = Literal["text", "all_output", "unknown"]

# (model, api_provider, serving_host, route, service_tier), nulls retained.
ServingGroupKey = tuple[str | None, str | None, str | None, str | None, str | None]

# Dimension names of a ServingFilter paired with the call attribute each
# reads. ``model`` matches the grouping key's model (observed model, else
# the legacy normalized model).
def _call_model(call: LoggedCallDB) -> str | None:
    return call.observed_model or call.model or None


def _call_api_provider(call: LoggedCallDB) -> str | None:
    return call.api_provider


def _call_serving_host(call: LoggedCallDB) -> str | None:
    return call.serving_host


def _call_route(call: LoggedCallDB) -> str | None:
    return call.route


def _call_service_tier(call: LoggedCallDB) -> str | None:
    return call.service_tier


_DIMENSION_GETTERS: Mapping[str, Callable[[LoggedCallDB], str | None]] = {
    "model": _call_model,
    "provider": _call_api_provider,
    "host": _call_serving_host,
    "route": _call_route,
    "service_tier": _call_service_tier,
}

UnavailableReason = Literal[
    "missing_timing",
    "invalid_timing",
    "missing_usage",
    "scope_mismatch",
    "unknown_scope",
    "incomplete_call",
    "aggregate_only",
]

# Heavy payload columns the read side never touches; deferring them keeps
# a page of summaries from loading megabytes of call bodies.
_CALL_DEFERS = (
    defer(LoggedCallDB.input),
    defer(LoggedCallDB.messages),
    defer(LoggedCallDB.output),
    defer(LoggedCallDB.tool_parameters),
    defer(LoggedCallDB.tool_result),
    defer(LoggedCallDB.meta),
    defer(LoggedCallDB.cost_breakdown),
    defer(LoggedCallDB.serving_evidence),
    defer(LoggedCallDB.matched_serving),
)


# ---------------------------------------------------------------------------
# Request accounting
# ---------------------------------------------------------------------------


def is_request_evidence(call: LoggedCallDB) -> bool:
    """Does this row carry per-request serving evidence?

    A row with explicit ``request_accounting="request"`` is one physical API
    request. Rows with null accounting are pre-feature data: a GENERATION
    with a model was one call in practice, so it counts as request evidence
    (and flags the summary ``partial`` through the unknown-accounting rule
    rather than vanishing). Aggregate wrappers are never requests.
    """
    if call.request_accounting == "request":
        return True
    if call.request_accounting is None:
        return call.observation_type == "GENERATION" and bool(
            (call.observed_model or call.model or "").strip()
        )
    return False


def is_aggregate_observation(call: LoggedCallDB) -> bool:
    return call.request_accounting == "aggregate"


def _observed_model(call: LoggedCallDB) -> str | None:
    return call.observed_model or call.model or None


def group_key(call: LoggedCallDB) -> ServingGroupKey:
    """The serving identity tuple a call groups under, nulls retained."""
    return (
        _observed_model(call),
        call.api_provider,
        call.serving_host,
        call.route,
        call.service_tier,
    )


def _group_sort_key(key: ServingGroupKey) -> tuple[tuple[int, str], ...]:
    """Lexicographic tuple order with null sorting first."""
    return tuple((0, "") if value is None else (1, value) for value in key)


def _is_errored(call: LoggedCallDB) -> bool:
    return call.level == "ERROR"


# ---------------------------------------------------------------------------
# Rates
# ---------------------------------------------------------------------------


def _reasoning_tokens(call: LoggedCallDB) -> int | None:
    # ``raw_usage`` is typed dict[str, int], but hand-written rows exist;
    # reading through ``object`` keeps the runtime guard meaningful.
    value: object = (call.raw_usage or {}).get("reasoning")
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _output_tokens(call: LoggedCallDB) -> int | None:
    """The rate numerator: completion tokens, plus reasoning when the
    reported scope says the output count includes it."""
    if call.completion_tokens is None:
        return None
    total = call.completion_tokens
    if call.output_token_scope == "all_output":
        reasoning = _reasoning_tokens(call)
        if reasoning is not None:
            total += reasoning
    return total


def _first_content_time(start: datetime, ttft_ms: float) -> datetime:
    # The offset is elapsed milliseconds from span start, never an absolute
    # timestamp; convert once, here.
    return start + timedelta(milliseconds=ttft_ms)


def generation_rates(call: LoggedCallDB) -> GenerationRates:
    """Whole-call and streaming output rates for one generation call.

    ``s`` is the call start (``created_at``), ``e`` its terminal end, ``f``
    the first generated content (``s`` plus the elapsed offset in
    ``time_to_first_token_ms``). The whole-call rate is output tokens over
    the full duration; the streaming rate divides by the decode window
    after first content. Both need a complete successful (non-ERROR) call
    with a known token count; streaming additionally needs a valid offset
    window and a token scope that provably describes the same stream the
    timing measured, because a text-only timing window must not be paired
    with reasoning-inclusive token counts. TTFT stays whenever the offset
    is a finite nonnegative number, even when the rates are unavailable.
    """
    scope: ServingScope = (
        call.output_token_scope
        if call.output_token_scope in ("text", "all_output")
        else "unknown"
    )
    rates = GenerationRates(output_token_scope=scope)
    ttft = call.time_to_first_token_ms
    ttft_valid = ttft is not None and math.isfinite(ttft) and ttft >= 0
    if ttft_valid:
        assert ttft is not None
        rates.time_to_first_token_ms = ttft

    if call.request_accounting == "aggregate":
        # A multi-request wrapper has no single-call timing or usage that
        # describes one physical request.
        rates.streaming_unavailable_reason = "aggregate_only"
        return rates
    if _is_errored(call):
        rates.streaming_unavailable_reason = "incomplete_call"
        return rates

    start = call.created_at
    end = call.end_time
    duration_ok = end is not None and end > start
    tokens = _output_tokens(call)
    if tokens is not None and duration_ok:
        assert end is not None
        rates.whole_call_output_tokens_per_second = tokens / (
            (end - start).total_seconds()
        )

    reason = _streaming_unavailable_reason(
        call, start=start, end=end, duration_ok=duration_ok, tokens=tokens, ttft_valid=ttft_valid
    )
    if reason is None:
        assert end is not None and ttft is not None and tokens is not None
        first = _first_content_time(start, ttft)
        rates.streaming_output_tokens_per_second = tokens / (
            (end - first).total_seconds()
        )
    rates.streaming_unavailable_reason = reason
    return rates


def _streaming_unavailable_reason(
    call: LoggedCallDB,
    *,
    start: datetime,
    end: datetime | None,
    duration_ok: bool,
    tokens: int | None,
    ttft_valid: bool,
) -> UnavailableReason | None:
    ttft = call.time_to_first_token_ms
    if not ttft_valid or ttft is None:
        return "missing_timing"
    if not duration_ok or end is None:
        return "invalid_timing"
    first = _first_content_time(start, ttft)
    if first < start or first >= end:
        return "invalid_timing"
    if tokens is None:
        return "missing_usage"
    output_scope = call.output_token_scope
    content_scope = call.first_content_scope
    if output_scope not in ("text", "all_output") or content_scope not in (
        "text",
        "all_output",
    ):
        return "unknown_scope"
    if output_scope != content_scope:
        return "scope_mismatch"
    return None


# ---------------------------------------------------------------------------
# Summaries
# ---------------------------------------------------------------------------


def _rate_summary(values: Sequence[float]) -> RateSummary:
    """Median over the eligible per-call values, never over group medians."""
    if not values:
        return RateSummary(median=None, samples=0)
    return RateSummary(median=statistics.median(values), samples=len(values))


class _GroupAccumulator:
    """Per-tuple request counts plus per-scope rate buckets."""

    def __init__(self) -> None:
        self.calls: int = 0
        self.errored_calls: int = 0
        # scope -> {"whole": [values], "stream": [values]}
        self.scopes: dict[ServingScope, dict[Literal["whole", "stream"], list[float]]] = {}

    def add(self, call: LoggedCallDB) -> None:
        self.calls += 1
        if _is_errored(call):
            self.errored_calls += 1
            return
        scope: ServingScope = (
            call.output_token_scope
            if call.output_token_scope in ("text", "all_output")
            else "unknown"
        )
        bucket = self.scopes.setdefault(scope, {"whole": [], "stream": []})
        rates = generation_rates(call)
        if rates.whole_call_output_tokens_per_second is not None:
            bucket["whole"].append(rates.whole_call_output_tokens_per_second)
        if rates.streaming_output_tokens_per_second is not None:
            bucket["stream"].append(rates.streaming_output_tokens_per_second)

    def scoped_rates(self) -> list[ScopedRates]:
        ordered: list[ServingScope] = [
            scope for scope in ("text", "all_output", "unknown") if scope in self.scopes
        ]
        return [
            ScopedRates(
                scope=scope,
                whole_call_rate=_rate_summary(self.scopes[scope]["whole"]),
                streaming_rate=_rate_summary(self.scopes[scope]["stream"]),
            )
            for scope in ordered
        ]

    def whole_call_rate(self) -> RateSummary:
        # Never mix scopes in one median: a combined median exists only
        # when every eligible call reported the same scope.
        buckets = [b["whole"] for b in self.scopes.values() if b["whole"]]
        if len(self.scopes_scoped_with("whole")) > 1:
            return RateSummary(median=None, samples=sum(len(b) for b in buckets))
        if len(buckets) == 1:
            return _rate_summary(buckets[0])
        return RateSummary(median=None, samples=0)

    def streaming_rate(self) -> RateSummary:
        buckets = [b["stream"] for b in self.scopes.values() if b["stream"]]
        if len(self.scopes_scoped_with("stream")) > 1:
            return RateSummary(median=None, samples=sum(len(b) for b in buckets))
        if len(buckets) == 1:
            return _rate_summary(buckets[0])
        return RateSummary(median=None, samples=0)

    def scopes_scoped_with(self, which: Literal["whole", "stream"]) -> set[ServingScope]:
        return {scope for scope, bucket in self.scopes.items() if bucket[which]}


def _group_identity(key: ServingGroupKey) -> ServingIdentity:
    """Grouping fields only. Per-call evidence, instrumentation flavor,
    requested tier, and request/response model belong to individual
    observations and must not be taken from an arbitrary first call."""
    model, api_provider, serving_host, route, service_tier = key
    return ServingIdentity(
        model=model,
        api_provider=api_provider,
        serving_host=serving_host,
        route=route,
        service_tier=service_tier,
    )


def serving_groups(calls: Sequence[LoggedCallDB]) -> list[ServingGroup]:
    """All serving groups over request-evidence calls, fully ordered.

    Order: descending call count, then the lexicographic identity tuple
    with nulls first. Inline consumers slice to ``INLINE_GROUP_CAP``; the
    breakdown endpoint pages this complete list.
    """
    requests = [call for call in calls if is_request_evidence(call)]
    accumulators: dict[ServingGroupKey, _GroupAccumulator] = {}
    for call in requests:
        accumulators.setdefault(group_key(call), _GroupAccumulator()).add(call)
    ordered_keys = sorted(
        accumulators, key=lambda key: (-accumulators[key].calls, _group_sort_key(key))
    )
    return [
        ServingGroup(
            identity=_group_identity(key),
            calls=accumulators[key].calls,
            errored_calls=accumulators[key].errored_calls,
            whole_call_rate=accumulators[key].whole_call_rate(),
            streaming_rate=accumulators[key].streaming_rate(),
            rate_scopes=accumulators[key].scoped_rates(),
        )
        for key in ordered_keys
    ]


def empty_serving_summary() -> ServingSummary:
    """The single-run ``no_data`` summary.

    A run with no linked trace (or no evidence at all) reports ``no_data``;
    null is reserved for responses built without trace access at all.
    """
    return summarize_calls([])


def summarize_calls(
    calls: Sequence[LoggedCallDB],
    *,
    task_runs_total: int = 1,
    task_runs_with_evidence: int | None = None,
) -> ServingSummary:
    """Group a run's (or a batch's concatenated) call rows into a summary.

    Request evidence is ``request_accounting="request"`` rows plus legacy
    pre-feature rows (null accounting, GENERATION, non-empty model);
    aggregate wrappers are counted only in ``aggregate_observations``.
    Errored requests count in ``calls``/``errored_calls`` and never enter
    a rate median. State precedence: ``no_data`` (no request or aggregate
    evidence at all), ``unknown`` (requests exist and every one reports
    neither provider nor host), ``partial`` (any aggregate or unknown
    accounting, any request with a known model but missing provider or
    host, or batch coverage below ``task_runs_total``), then ``uniform``
    for exactly one identity tuple and ``mixed`` otherwise. Coverage
    counts are authoritative; state is a display aid.

    ``task_runs_with_evidence`` defaults to the single-run 0/1 answer; a
    batch passes its own child-coverage counts.
    """
    requests = [call for call in calls if is_request_evidence(call)]
    aggregates = [call for call in calls if is_aggregate_observation(call)]
    groups = serving_groups(calls)
    total_groups = len(groups)
    shown = groups[:INLINE_GROUP_CAP]

    if task_runs_with_evidence is None:
        task_runs_with_evidence = 1 if (requests or aggregates) else 0

    errored = sum(1 for call in requests if _is_errored(call))
    unknown_provider = sum(1 for call in requests if call.api_provider is None)
    unknown_host = sum(1 for call in requests if call.serving_host is None)

    distinct_keys = {group_key(call) for call in requests}
    any_unknown_accounting = any(call.request_accounting is None for call in requests)
    any_missing_identity = any(
        _observed_model(call) is not None
        and (call.api_provider is None or call.serving_host is None)
        for call in requests
    )

    if not requests and not aggregates:
        state: Literal["no_data", "unknown", "uniform", "mixed", "partial"] = "no_data"
    elif requests and unknown_provider == len(requests) and unknown_host == len(requests):
        # A wholly unknown request set stays unknown even with several
        # model names in it.
        state = "unknown"
    elif (
        aggregates
        or any_unknown_accounting
        or any_missing_identity
        or task_runs_with_evidence < task_runs_total
    ):
        state = "partial"
    elif len(distinct_keys) == 1:
        state = "uniform"
    else:
        state = "mixed"

    return ServingSummary(
        state=state,
        calls=len(requests),
        errored_calls=errored,
        unknown_provider_calls=unknown_provider,
        unknown_host_calls=unknown_host,
        aggregate_observations=len(aggregates),
        groups=shown,
        total_groups=total_groups,
        groups_truncated=total_groups > len(shown),
        task_runs_with_evidence=task_runs_with_evidence,
        task_runs_total=task_runs_total,
        cost_coverage=cost_coverage(calls),
    )


# ---------------------------------------------------------------------------
# Cost coverage
# ---------------------------------------------------------------------------


def _effective_cost(call: LoggedCallDB) -> int | None:
    """The single effective total (micro-USD), as the run rollup reads it."""
    return call.cost if call.cost is not None else call.provided_cost


def cost_coverage(calls: Sequence[LoggedCallDB]) -> CostCoverage:
    """Classify the existing effective-cost fields by estimate quality.

    Sums are nullable: null means no eligible priced observation of that
    class existed, zero means priced observations summed to zero. Calls
    with a legacy computed cost and no new quality marker classify as
    model-only estimates without repricing. Errored calls are excluded
    from every sum and counted in ``excluded_error_calls``, mirroring the
    run rollup's error exclusion (its usage totals skip errored calls and
    consumers present them as partial). Aggregate rows never enter the
    request sums; an aggregate carrying a charge is counted in
    ``aggregate_charge_observations`` so a gateway-reported wrapper charge
    stays visible without being divided among hosts.
    """
    reported: list[int] = []
    qualified: list[int] = []
    model_only: list[int] = []
    unpriced_calls = 0
    ambiguous_calls = 0
    excluded_error_calls = 0
    aggregate_charges = 0

    for call in calls:
        if is_aggregate_observation(call):
            if _effective_cost(call) is not None:
                aggregate_charges += 1
            continue
        if not is_request_evidence(call):
            continue
        if _is_errored(call):
            excluded_error_calls += 1
            continue
        cost = _effective_cost(call)
        quality = call.pricing_quality
        if call.cost_provenance == "unpriced":
            if quality == "ambiguous":
                ambiguous_calls += 1
            else:
                unpriced_calls += 1
            continue
        if cost is None:
            # No price resolved and no explicit marker: the run rollup
            # skips it from totals, so coverage reports nothing priced.
            continue
        if quality == "reported" or call.cost_provenance == "provided":
            reported.append(cost)
        elif quality == "qualified":
            qualified.append(cost)
        else:
            # "model_only" plus legacy computed costs with no marker.
            model_only.append(cost)

    return CostCoverage(
        reported=sum(reported) if reported else None,
        qualified_estimate=sum(qualified) if qualified else None,
        model_only_estimate=sum(model_only) if model_only else None,
        unpriced_calls=unpriced_calls,
        ambiguous_calls=ambiguous_calls,
        excluded_error_calls=excluded_error_calls,
        aggregate_charge_observations=aggregate_charges,
        partial=bool(
            unpriced_calls
            or ambiguous_calls
            or excluded_error_calls
            or aggregate_charges
        ),
    )


# ---------------------------------------------------------------------------
# Filters (shared by run lists, saved views, and comparisons)
# ---------------------------------------------------------------------------


def _dimension_values(serving_filter: ServingFilter) -> dict[str, tuple[list[str], bool]]:
    """Value lists and unknown-operator flags per dimension name."""
    return {
        "model": (
            [v.lower() for v in serving_filter.observed_models],
            "model" in serving_filter.unknown,
        ),
        "provider": (
            [v.lower() for v in serving_filter.providers],
            "provider" in serving_filter.unknown,
        ),
        "host": (
            [v.lower() for v in serving_filter.hosts],
            "host" in serving_filter.unknown,
        ),
        "route": (
            [v.lower() for v in serving_filter.routes],
            "route" in serving_filter.unknown,
        ),
        "service_tier": (
            [v.lower() for v in serving_filter.service_tiers],
            "service_tier" in serving_filter.unknown,
        ),
    }


def filter_is_active(serving_filter: ServingFilter) -> bool:
    """Does the filter constrain anything?

    An all-empty filter would match every request in ``contains`` mode;
    callers use this to skip the call-row fetch entirely.
    """
    values = _dimension_values(serving_filter)
    return any(selection or unknown for selection, unknown in values.values())


def call_matches_filter(call: LoggedCallDB, serving_filter: ServingFilter) -> bool:
    """Same-request predicate: values OR within a dimension, dimensions AND.

    The comparison is case-insensitive (a hand-edited URL must not silently
    empty the list, matching the other list filters). ``unknown`` selects
    null as one more OR value inside its dimension; it is an operator, not
    a provider string. A dimension with neither values nor the unknown
    operator is unconstrained. So a filter for OpenRouter + Baseten cannot
    match an OpenRouter/Fireworks request plus an unrelated direct Baseten
    request: both values must hold on the same call.
    """
    for dimension, (values, unknown) in _dimension_values(serving_filter).items():
        if not values and not unknown:
            continue
        actual = _DIMENSION_GETTERS[dimension](call)
        if actual is None:
            # ``unknown`` selects null as one more OR value in this
            # dimension; without it, null never matches a value list.
            if not unknown:
                return False
        elif actual.lower() not in values:
            return False
    return True


def run_matches_filter(
    calls: Sequence[LoggedCallDB],
    serving_filter: ServingFilter,
    mode: Literal["contains", "only"] = "contains",
) -> bool:
    """Does a run's request set satisfy the filter under ``mode``?

    ``contains``: at least one request-evidence call matches. ``only``:
    at least one request exists, every request matches, all grouping
    tuples are identical, and there is no unknown/aggregate accounting
    among the run's generations (a wrapper or legacy accounting cannot
    certify "only"). Only mode additionally requires known model, API
    provider, and host on every request; an unknown route or tier is
    allowed only while that dimension is unconstrained.
    """
    requests = [call for call in calls if is_request_evidence(call)]
    if mode == "contains":
        return any(call_matches_filter(call, serving_filter) for call in requests)

    if not requests:
        return False
    generations = [call for call in calls if call.observation_type == "GENERATION"]
    if any(call.request_accounting != "request" for call in generations):
        return False
    if any(not call_matches_filter(call, serving_filter) for call in requests):
        return False
    if len({group_key(call) for call in requests}) != 1:
        return False
    constrained = _dimension_values(serving_filter)
    for call in requests:
        if (
            _observed_model(call) is None
            or call.api_provider is None
            or call.serving_host is None
        ):
            return False
        if call.route is None and (constrained["route"][0] or constrained["route"][1]):
            return False
        if call.service_tier is None and (
            constrained["service_tier"][0] or constrained["service_tier"][1]
        ):
            return False
    return True


# ---------------------------------------------------------------------------
# DB-facing helpers (batched, project-scoped)
# ---------------------------------------------------------------------------


def load_call_rows(
    session: Session,
    *,
    project: str,
    run_ids: Sequence[str],
) -> dict[str, list[LoggedCallDB]]:
    """All call rows for the given trace run ids, grouped by run id.

    One query; heavy payload columns stay deferred. ``project`` scopes the
    lookup because trace ids may collide across projects (surrogate-PK
    design) and another project's copy of a trace must never leak into
    this one's summary or filter.
    """
    unique_ids = list(dict.fromkeys(run_ids))
    if not unique_ids:
        return {}
    rows = session.exec(
        select(LoggedCallDB)
        .options(*_CALL_DEFERS)
        .where(
            col(LoggedCallDB.run_id).in_(unique_ids),
            col(LoggedCallDB.project) == project,
        )
    ).all()
    grouped: dict[str, list[LoggedCallDB]] = {}
    for row in rows:
        if row.run_id is not None:
            grouped.setdefault(row.run_id, []).append(row)
    return grouped


def serving_summaries_for_runs(
    session: Session,
    run_ids_by_project: Mapping[str, Sequence[str]],
) -> dict[str, ServingSummary]:
    """Bounded single-run summaries keyed by trace run id.

    One call-row query per distinct project over the whole run-id set
    (never per-run). Runs with no trace or no evidence get ``no_data``.
    """
    summaries: dict[str, ServingSummary] = {}
    for project, run_ids in run_ids_by_project.items():
        grouped = load_call_rows(session, project=project, run_ids=run_ids)
        for run_id in run_ids:
            summaries[run_id] = summarize_calls(grouped.get(run_id, []))
    return summaries


def batch_serving_summary(
    session: Session,
    *,
    project: str,
    trace_run_ids: Sequence[str],
    task_runs_total: int,
) -> ServingSummary:
    """One summary over every child task run's traces.

    The batch summary describes all children, matching or not. Medians are
    computed over the concatenated eligible calls, never over the
    children's medians.
    """
    grouped = load_call_rows(session, project=project, run_ids=trace_run_ids)
    all_calls = [call for run_id in trace_run_ids for call in grouped.get(run_id, [])]
    with_evidence = sum(
        1 for run_id in trace_run_ids if has_serving_evidence(grouped.get(run_id, []))
    )
    return summarize_calls(
        all_calls,
        task_runs_total=task_runs_total,
        task_runs_with_evidence=with_evidence,
    )


def has_serving_evidence(calls: Sequence[LoggedCallDB]) -> bool:
    """Any request or aggregate serving evidence in this call set?"""
    return any(is_request_evidence(call) or is_aggregate_observation(call) for call in calls)


__all__ = [
    "INLINE_GROUP_CAP",
    "batch_serving_summary",
    "empty_serving_summary",
    "call_matches_filter",
    "cost_coverage",
    "filter_is_active",
    "generation_rates",
    "group_key",
    "has_serving_evidence",
    "is_aggregate_observation",
    "is_request_evidence",
    "load_call_rows",
    "run_matches_filter",
    "serving_groups",
    "serving_summaries_for_runs",
    "summarize_calls",
]
