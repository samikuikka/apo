# pyright: reportAny=false, reportExplicitAny=false

"""Serving summaries: rate math, scope separation, states, cost coverage, filters.

Pure-computation coverage for the shared serving read side: whole-call vs
streaming output rates from one timing contract, mixed-scope groups kept
separate instead of averaged into a misleading median, honest no_data /
unknown / partial / uniform / mixed states, cost-coverage classification of
the existing effective-cost fields, and the same-request filter predicate
list routes, saved views, and comparisons all share.
"""

from datetime import datetime, timedelta, timezone

from apo.models.db import LoggedCallDB
from apo.models.serving import ServingFilter
from apo.services.serving import (
    INLINE_GROUP_CAP,
    call_matches_filter,
    cost_coverage,
    generation_rates,
    run_matches_filter,
    summarize_calls,
)

_START = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _call(
    span: str,
    *,
    model: str = "example-model",
    observed_model: str | None = None,
    api_provider: str | None = None,
    serving_host: str | None = None,
    route: str | None = None,
    service_tier: str | None = None,
    accounting: str | None = "request",
    observation_type: str = "GENERATION",
    start: datetime = _START,
    duration_s: float = 2.0,
    ttft_ms: float | None = None,
    completion_tokens: int | None = 100,
    reasoning_tokens: int | None = None,
    output_scope: str | None = None,
    content_scope: str | None = None,
    level: str = "DEFAULT",
    cost: int | None = None,
    provided_cost: int | None = None,
    pricing_quality: str | None = None,
    cost_provenance: str | None = None,
) -> LoggedCallDB:
    return LoggedCallDB(
        id=span,
        run_id="trace-1",
        project="p",
        task_id="",
        input={},
        messages=[],
        output={},
        created_at=start,
        end_time=start + timedelta(seconds=duration_s),
        model=model,
        observed_model=observed_model,
        api_provider=api_provider,
        serving_host=serving_host,
        route=route,
        service_tier=service_tier,
        request_accounting=accounting,
        observation_type=observation_type,
        time_to_first_token_ms=ttft_ms,
        completion_tokens=completion_tokens,
        raw_usage={"reasoning": reasoning_tokens} if reasoning_tokens is not None else None,
        output_token_scope=output_scope,
        first_content_scope=content_scope,
        level=level,
        cost=cost,
        provided_cost=provided_cost,
        pricing_quality=pricing_quality,
        cost_provenance=cost_provenance,
    )


class TestGenerationRates:
    def test_spec_example_whole_streaming_and_ttft(self) -> None:
        """n=100, duration 2s, compatible 500ms first-content offset:
        whole-call 50 tok/s, streaming 100/1.5 ~ 66.667, TTFT 500ms."""
        rates = generation_rates(
            _call(
                "s1",
                ttft_ms=500.0,
                output_scope="text",
                content_scope="text",
            )
        )
        assert rates.time_to_first_token_ms == 500.0
        assert rates.whole_call_output_tokens_per_second == 50.0
        assert rates.streaming_output_tokens_per_second is not None
        assert abs(rates.streaming_output_tokens_per_second - 200 / 3) < 1e-9
        assert rates.streaming_unavailable_reason is None
        assert rates.output_token_scope == "text"

    def test_reasoning_added_to_numerator_only_for_all_output(self) -> None:
        text = generation_rates(
            _call("s-text", ttft_ms=500.0, output_scope="text", content_scope="text", reasoning_tokens=40)
        )
        all_output = generation_rates(
            _call("s-all", ttft_ms=500.0, output_scope="all_output", content_scope="all_output", reasoning_tokens=40)
        )
        assert text.whole_call_output_tokens_per_second == 50.0
        # 100 completion + 40 reasoning over the same 2s window.
        assert all_output.whole_call_output_tokens_per_second == 70.0

    def test_scope_mismatch_keeps_whole_call_rate_only(self) -> None:
        """Reasoning-inclusive tokens with text-only timing: whole-call
        available, streaming refused with scope_mismatch."""
        rates = generation_rates(
            _call("s-mismatch", ttft_ms=500.0, output_scope="all_output", content_scope="text")
        )
        assert rates.whole_call_output_tokens_per_second is not None
        assert rates.streaming_output_tokens_per_second is None
        assert rates.streaming_unavailable_reason == "scope_mismatch"

    def test_unknown_scope_refuses_streaming(self) -> None:
        rates = generation_rates(_call("s-unknown-scope", ttft_ms=500.0))
        assert rates.streaming_unavailable_reason == "unknown_scope"
        assert rates.streaming_output_tokens_per_second is None
        assert rates.whole_call_output_tokens_per_second == 50.0

    def test_missing_ttft_keeps_whole_call_rate(self) -> None:
        rates = generation_rates(_call("s-no-ttft"))
        assert rates.time_to_first_token_ms is None
        assert rates.whole_call_output_tokens_per_second == 50.0
        assert rates.streaming_unavailable_reason == "missing_timing"

    def test_ttft_at_or_after_end_is_invalid(self) -> None:
        rates = generation_rates(
            _call("s-late", ttft_ms=2000.0, output_scope="text", content_scope="text")
        )
        # The offset itself is finite and nonnegative, so TTFT is kept.
        assert rates.time_to_first_token_ms == 2000.0
        assert rates.streaming_unavailable_reason == "invalid_timing"

    def test_zero_output_is_zero_not_missing(self) -> None:
        rates = generation_rates(
            _call("s-zero", completion_tokens=0, ttft_ms=500.0, output_scope="text", content_scope="text")
        )
        assert rates.whole_call_output_tokens_per_second == 0.0
        assert rates.streaming_output_tokens_per_second == 0.0

    def test_missing_usage_is_null_not_zero(self) -> None:
        rates = generation_rates(
            _call("s-missing-n", completion_tokens=None, ttft_ms=500.0, output_scope="text", content_scope="text")
        )
        assert rates.whole_call_output_tokens_per_second is None
        assert rates.streaming_output_tokens_per_second is None
        assert rates.streaming_unavailable_reason == "missing_usage"

    def test_errored_call_keeps_ttft_but_has_no_rates(self) -> None:
        rates = generation_rates(
            _call("s-error", level="ERROR", ttft_ms=500.0, output_scope="text", content_scope="text")
        )
        assert rates.time_to_first_token_ms == 500.0
        assert rates.whole_call_output_tokens_per_second is None
        assert rates.streaming_output_tokens_per_second is None
        assert rates.streaming_unavailable_reason == "incomplete_call"

    def test_aggregate_wrapper_never_rated(self) -> None:
        rates = generation_rates(
            _call("s-agg", accounting="aggregate", ttft_ms=500.0, output_scope="text", content_scope="text")
        )
        assert rates.streaming_unavailable_reason == "aggregate_only"
        assert rates.whole_call_output_tokens_per_second is None

    def test_zero_or_negative_duration_has_no_whole_rate(self) -> None:
        rates = generation_rates(
            _call("s-flat", duration_s=0.0, ttft_ms=500.0, output_scope="text", content_scope="text")
        )
        assert rates.whole_call_output_tokens_per_second is None
        assert rates.streaming_output_tokens_per_second is None
        assert rates.streaming_unavailable_reason == "invalid_timing"


class TestSummarizeStates:
    def test_no_data_when_no_evidence_at_all(self) -> None:
        summary = summarize_calls([_call("s-tool", observation_type="TOOL", accounting=None)])
        assert summary.state == "no_data"
        assert summary.calls == 0
        assert summary.total_groups == 0
        assert summary.task_runs_with_evidence == 0
        assert summary.task_runs_total == 1

    def test_unknown_when_every_request_lacks_provider_and_host(self) -> None:
        summary = summarize_calls(
            [
                _call("s-a", model="model-a"),
                _call("s-b", model="model-b"),
            ]
        )
        # Wholly unknown stays unknown even with multiple model names.
        assert summary.state == "unknown"
        assert summary.unknown_provider_calls == 2
        assert summary.unknown_host_calls == 2

    def test_uniform_for_one_identity_tuple(self) -> None:
        summary = summarize_calls(
            [
                _call("s-a", api_provider="openrouter", serving_host="baseten"),
                _call("s-b", api_provider="openrouter", serving_host="baseten"),
            ]
        )
        assert summary.state == "uniform"
        assert summary.calls == 2
        assert summary.total_groups == 1
        assert summary.groups_truncated is False

    def test_mixed_for_multiple_identity_tuples(self) -> None:
        summary = summarize_calls(
            [
                _call("s-a", api_provider="openrouter", serving_host="baseten"),
                _call("s-b", api_provider="fireworks", serving_host="fireworks"),
            ]
        )
        assert summary.state == "mixed"
        assert summary.total_groups == 2

    def test_partial_for_legacy_null_accounting(self) -> None:
        summary = summarize_calls(
            [
                _call("s-legacy", accounting=None, api_provider="fireworks", serving_host="fireworks"),
            ]
        )
        # Pre-feature row: counted as request evidence, but the summary
        # stays honest that accounting was unknown.
        assert summary.state == "partial"
        assert summary.calls == 1

    def test_partial_for_known_model_missing_host(self) -> None:
        summary = summarize_calls(
            [_call("s-no-host", api_provider="openrouter", serving_host=None)]
        )
        assert summary.state == "partial"
        assert summary.unknown_host_calls == 1

    def test_partial_for_aggregate_observation(self) -> None:
        summary = summarize_calls(
            [
                _call("s-req", api_provider="openrouter", serving_host="baseten"),
                _call("s-wrapper", accounting="aggregate"),
            ]
        )
        assert summary.state == "partial"
        assert summary.calls == 1
        assert summary.aggregate_observations == 1

    def test_partial_for_batch_undercoverage(self) -> None:
        summary = summarize_calls(
            [_call("s-a", api_provider="openrouter", serving_host="baseten")],
            task_runs_total=2,
            task_runs_with_evidence=1,
        )
        assert summary.state == "partial"
        assert summary.task_runs_with_evidence == 1
        assert summary.task_runs_total == 2

    def test_group_identity_carries_grouping_fields_only(self) -> None:
        summary = summarize_calls(
            [
                _call(
                    "s-a",
                    observed_model="served-model",
                    api_provider="openrouter",
                    serving_host="baseten",
                    route="nitro",
                    service_tier="priority",
                )
            ]
        )
        identity = summary.groups[0].identity
        assert identity.model == "served-model"
        assert identity.api_provider == "openrouter"
        assert identity.serving_host == "baseten"
        assert identity.route == "nitro"
        assert identity.service_tier == "priority"
        # Per-call details must not be taken from an arbitrary first call.
        assert identity.instrumentation_provider is None
        assert identity.requested_service_tier is None
        assert identity.request_model is None
        assert identity.response_model is None
        assert identity.evidence == {}


class TestSummarizeRates:
    def _rated(
        self, span: str, tokens: int, duration_s: float, scope: str | None = None
    ) -> LoggedCallDB:
        return _call(
            span,
            completion_tokens=tokens,
            duration_s=duration_s,
            output_scope=scope,
            content_scope=scope,
            ttft_ms=500.0,
            api_provider="openrouter",
            serving_host="baseten",
        )

    def test_median_comes_from_eligible_calls_only(self) -> None:
        summary = summarize_calls(
            [
                self._rated("s-50", 100, 2.0),
                self._rated("s-25", 100, 4.0),
                # Errored call in the SAME group: counted, never in the median.
                _call(
                    "s-err",
                    level="ERROR",
                    completion_tokens=9999,
                    duration_s=1.0,
                    api_provider="openrouter",
                    serving_host="baseten",
                ),
            ]
        )
        assert summary.calls == 3
        assert summary.errored_calls == 1
        group = summary.groups[0]
        assert group.calls == 3
        assert group.errored_calls == 1
        assert group.whole_call_rate.median == 37.5
        assert group.whole_call_rate.samples == 2

    def test_mixed_scopes_get_separate_medians_and_null_combined(self) -> None:
        summary = summarize_calls(
            [
                self._rated("s-text-50", 100, 2.0, scope="text"),
                self._rated("s-text-25", 100, 4.0, scope="text"),
                self._rated("s-all-70", 140, 2.0, scope="all_output"),
            ]
        )
        group = summary.groups[0]
        # Combining a text numerator with an all-output numerator in one
        # median would be a lie; the combined median stays null while the
        # per-scope entries carry the real medians.
        assert group.whole_call_rate.median is None
        assert group.whole_call_rate.samples == 3
        by_scope = {scoped.scope: scoped for scoped in group.rate_scopes}
        assert set(by_scope) == {"text", "all_output"}
        assert by_scope["text"].whole_call_rate.median == 37.5
        assert by_scope["text"].whole_call_rate.samples == 2
        assert by_scope["all_output"].whole_call_rate.median == 70.0
        assert by_scope["all_output"].whole_call_rate.samples == 1

    def test_unknown_scope_bucket_is_exposed(self) -> None:
        summary = summarize_calls([self._rated("s-legacy", 100, 2.0, scope=None)])
        group = summary.groups[0]
        assert [scoped.scope for scoped in group.rate_scopes] == ["unknown"]
        assert group.rate_scopes[0].whole_call_rate.median == 50.0
        # One scope only: the group-level median exists.
        assert group.whole_call_rate.median == 50.0

    def test_inline_groups_cap_at_twenty_ordered_by_calls_then_tuple(self) -> None:
        calls = [
            _call(
                f"s-{i:02d}",
                model=f"model-{i:02d}",
                api_provider="openrouter",
                serving_host="baseten",
            )
            for i in range(21)
        ]
        # model-00 gets a second call: it must lead by call count.
        calls.append(_call("s-00b", model="model-00", api_provider="openrouter", serving_host="baseten"))
        summary = summarize_calls(calls)
        assert summary.total_groups == 21
        assert len(summary.groups) == INLINE_GROUP_CAP
        assert summary.groups_truncated is True
        assert summary.groups[0].identity.model == "model-00"
        assert summary.groups[0].calls == 2
        # Ties break on the lexicographic tuple with nulls first.
        assert [g.identity.model for g in summary.groups[1:3]] == ["model-01", "model-02"]


class TestCostCoverage:
    def test_sums_split_by_quality_with_nulls_when_empty(self) -> None:
        coverage = cost_coverage([_call("s-free")])
        assert coverage.reported is None
        assert coverage.qualified_estimate is None
        assert coverage.model_only_estimate is None
        assert coverage.partial is False

    def test_reported_qualified_and_model_only_split(self) -> None:
        coverage = cost_coverage(
            [
                _call("s-rep", cost=100, pricing_quality="reported"),
                _call("s-provided", provided_cost=50, cost_provenance="provided"),
                _call("s-qual", cost=10, pricing_quality="qualified"),
                _call("s-model", cost=1, pricing_quality="model_only"),
                # Legacy computed cost without the new marker.
                _call("s-legacy", cost=5, cost_provenance="computed"),
            ]
        )
        assert coverage.reported == 150
        assert coverage.qualified_estimate == 10
        assert coverage.model_only_estimate == 6
        assert coverage.partial is False

    def test_unpriced_and_ambiguous_counts_set_partial(self) -> None:
        coverage = cost_coverage(
            [
                _call("s-qual", cost=10, pricing_quality="qualified"),
                _call("s-unpriced", cost_provenance="unpriced", pricing_quality="unpriced"),
                _call("s-ambig", cost_provenance="unpriced", pricing_quality="ambiguous"),
            ]
        )
        assert coverage.unpriced_calls == 1
        assert coverage.ambiguous_calls == 1
        assert coverage.partial is True

    def test_errored_calls_excluded_and_counted(self) -> None:
        coverage = cost_coverage(
            [
                _call("s-ok", cost=10, pricing_quality="qualified"),
                _call("s-err", level="ERROR", cost=999, pricing_quality="qualified"),
            ]
        )
        assert coverage.qualified_estimate == 10
        assert coverage.excluded_error_calls == 1
        assert coverage.partial is True

    def test_aggregate_charge_counted_never_summed(self) -> None:
        coverage = cost_coverage(
            [
                _call("s-req", cost=10, pricing_quality="qualified"),
                _call("s-wrapper", accounting="aggregate", cost=500, pricing_quality="reported"),
            ]
        )
        # A gateway wrapper charge may contribute once to the run total but
        # never to inferred per-host request sums.
        assert coverage.qualified_estimate == 10
        assert coverage.reported is None
        assert coverage.aggregate_charge_observations == 1
        assert coverage.partial is True

    def test_cost_falls_back_to_provided_when_unset(self) -> None:
        coverage = cost_coverage(
            [_call("s-prov", provided_cost=42, pricing_quality="reported")]
        )
        assert coverage.reported == 42


def _filter(
    **kwargs: object,
) -> ServingFilter:
    return ServingFilter.model_validate(kwargs)


class TestCallFilter:
    def test_openrouter_baseten_requires_one_call(self) -> None:
        """A filter for OpenRouter + Baseten must not match an
        OpenRouter/Fireworks request plus an unrelated direct-Baseten
        request: dimensions AND on the same call."""
        serving_filter = _filter(providers=["openrouter"], hosts=["baseten"])
        wrong_pair = [
            _call("s-or-fw", api_provider="openrouter", serving_host="fireworks"),
            _call("s-direct", api_provider=None, serving_host="baseten"),
        ]
        assert not any(call_matches_filter(call, serving_filter) for call in wrong_pair)
        right = _call("s-or-bs", api_provider="openrouter", serving_host="baseten")
        assert call_matches_filter(right, serving_filter)

    def test_values_or_within_a_dimension(self) -> None:
        serving_filter = _filter(hosts=["baseten", "fireworks"])
        assert call_matches_filter(_call("s-bs", serving_host="baseten"), serving_filter)
        assert call_matches_filter(_call("s-fw", serving_host="fireworks"), serving_filter)
        assert not call_matches_filter(_call("s-or", serving_host="octo"), serving_filter)

    def test_unknown_selects_null_as_extra_or_value(self) -> None:
        serving_filter = _filter(hosts=["baseten"], unknown=["host"])
        assert call_matches_filter(_call("s-bs", serving_host="baseten"), serving_filter)
        assert call_matches_filter(_call("s-null", serving_host=None), serving_filter)
        assert not call_matches_filter(_call("s-fw", serving_host="fireworks"), serving_filter)

    def test_observed_models_matches_grouping_model(self) -> None:
        serving_filter = _filter(observed_models=["served-model"])
        assert call_matches_filter(
            _call("s-obs", model="requested-model", observed_model="served-model"), serving_filter
        )
        assert not call_matches_filter(_call("s-legacy", model="requested-model"), serving_filter)

    def test_matching_is_case_insensitive(self) -> None:
        serving_filter = _filter(providers=["OpenRouter"])
        assert call_matches_filter(_call("s-case", api_provider="openrouter"), serving_filter)

    def test_empty_filter_matches_everything(self) -> None:
        assert call_matches_filter(_call("s-any"), _filter())


class TestRunFilter:
    def _uniform(self, span: str = "s-run", **overrides: object) -> LoggedCallDB:
        base: dict[str, object] = {
            "api_provider": "openrouter",
            "serving_host": "baseten",
            "route": "nitro",
        }
        base.update(overrides)
        return _call(span, **base)  # pyright: ignore[reportArgumentType]

    def test_contains_needs_any_matching_call(self) -> None:
        serving_filter = _filter(providers=["openrouter"], hosts=["baseten"])
        split = [
            _call("s-or-fw", api_provider="openrouter", serving_host="fireworks"),
            _call("s-direct", api_provider=None, serving_host="baseten"),
        ]
        assert run_matches_filter(split, serving_filter, "contains") is False
        combined = [_call("s-or-bs", api_provider="openrouter", serving_host="baseten")]
        assert run_matches_filter(combined, serving_filter, "contains") is True

    def test_only_accepts_complete_uniform_run(self) -> None:
        serving_filter = _filter()
        calls = [
            self._uniform("s-a"),
            self._uniform("s-b"),
        ]
        assert run_matches_filter(calls, serving_filter, "only") is True

    def test_only_rejects_mixed_tuples(self) -> None:
        calls = [
            self._uniform("s-a", serving_host="baseten"),
            self._uniform("s-b", serving_host="fireworks"),
        ]
        assert run_matches_filter(calls, _filter(), "only") is False

    def test_only_rejects_unknown_provider_or_host(self) -> None:
        assert run_matches_filter([self._uniform(api_provider=None)], _filter(), "only") is False
        assert run_matches_filter([self._uniform(serving_host=None)], _filter(), "only") is False

    def test_only_rejects_unknown_or_aggregate_accounting(self) -> None:
        legacy = [self._uniform(accounting=None)]
        assert run_matches_filter(legacy, _filter(), "only") is False
        with_wrapper = [self._uniform(), _call("s-w", accounting="aggregate")]
        assert run_matches_filter(with_wrapper, _filter(), "only") is False

    def test_only_requires_route_only_when_constrained(self) -> None:
        no_route = [self._uniform(route=None)]
        assert run_matches_filter(no_route, _filter(), "only") is True
        assert run_matches_filter(no_route, _filter(routes=["nitro"]), "only") is False

    def test_only_requires_every_call_to_match(self) -> None:
        calls = [
            self._uniform("s-a"),
            self._uniform("s-b", api_provider="fireworks", serving_host="fireworks"),
        ]
        assert run_matches_filter(calls, _filter(providers=["openrouter"]), "only") is False

    def test_empty_run_never_matches(self) -> None:
        assert run_matches_filter([], _filter(), "contains") is False
        assert run_matches_filter([], _filter(), "only") is False
