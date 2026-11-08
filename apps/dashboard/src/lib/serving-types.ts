// Observed serving identity, speed, and coverage wire types (issue #307).
//
// Field names mirror the backend transport exactly (snake_case, as the
// backend SQLModel response models serialize them), so components consume
// fetch responses directly with no client-side reshaping. Null always means
// unknown; unknown is never a provider string.

import { formatCostMicro } from "./format";

/** Which attribute or documented adapter supplied an identity value. */
export interface IdentityEvidence {
  source: string;
  kind: "reported" | "configured" | "convention";
}

/** The identity dimensions an evidence entry can be attached to. */
export type IdentityField =
  | "instrumentation_provider"
  | "api_provider"
  | "serving_host"
  | "route"
  | "requested_service_tier"
  | "service_tier"
  | "request_model"
  | "response_model";

/** One generation call's observed serving identity. */
export interface ServingIdentity {
  /** Response model when reported, else the normalized model. */
  model: string | null;
  instrumentation_provider?: string | null;
  api_provider: string | null;
  serving_host: string | null;
  route: string | null;
  requested_service_tier?: string | null;
  service_tier: string | null;
  request_model?: string | null;
  response_model?: string | null;
  evidence?: Partial<Record<IdentityField, IdentityEvidence>> | null;
}

/** Speed evidence for one generation call. */
export interface GenerationRates {
  time_to_first_token_ms: number | null;
  whole_call_output_tokens_per_second: number | null;
  streaming_output_tokens_per_second: number | null;
  output_token_scope: "text" | "all_output" | "unknown";
  streaming_unavailable_reason:
    | "missing_timing"
    | "invalid_timing"
    | "missing_usage"
    | "scope_mismatch"
    | "unknown_scope"
    | "incomplete_call"
    | "aggregate_only"
    | null;
}

/** A median plus the sample count that produced it. */
export interface RateSummary {
  median: number | null;
  samples: number;
}

/** Rates for one token scope inside a group. */
export interface ScopedRates {
  scope: "text" | "all_output" | "unknown";
  whole_call_rate: RateSummary;
  streaming_rate: RateSummary;
}

/** All calls grouped under one identity tuple. */
export interface ServingGroup {
  identity: ServingIdentity;
  calls: number;
  errored_calls: number;
  whole_call_rate: RateSummary;
  streaming_rate: RateSummary;
  rate_scopes: ScopedRates[];
}

/** How much of a run's eligible cost total each pricing quality covers. */
export interface CostCoverage {
  /** Nullable sums in micro-USD; null = no eligible priced observations. */
  reported: number | null;
  qualified_estimate: number | null;
  model_only_estimate: number | null;
  unpriced_calls: number;
  ambiguous_calls: number;
  excluded_error_calls: number;
  aggregate_charge_observations: number;
  partial: boolean;
}

/** Bounded serving summary attached to run and batch responses. */
export interface ServingSummary {
  state: "no_data" | "unknown" | "uniform" | "mixed" | "partial";
  calls: number;
  errored_calls: number;
  unknown_provider_calls: number;
  unknown_host_calls: number;
  aggregate_observations: number;
  groups: ServingGroup[];
  total_groups: number;
  groups_truncated: boolean;
  /** Child coverage; 0/1 on Task Runs, real counts on Batch responses. */
  task_runs_with_evidence: number;
  task_runs_total: number;
  cost_coverage?: CostCoverage;
}

/** The paged complete group set from the breakdown endpoints. */
export interface ServingBreakdownPage {
  groups: ServingGroup[];
  total_groups: number;
  offset: number;
  limit: number;
}

/** Price-row selector; null fields are wildcards. */
export interface ServingMatch {
  api_provider: string | null;
  serving_host: string | null;
  route: string | null;
  service_tier: string | null;
}

/** One dimension the unknown operator can select null in. */
export type ServingUnknownDimension = "model" | "provider" | "host" | "route" | "service_tier";

/** The full same-request serving filter (saved views, comparisons). */
export interface ServingFilter {
  observed_models: string[];
  providers: string[];
  hosts: string[];
  routes: string[];
  service_tiers: string[];
  unknown: ServingUnknownDimension[];
  mode: "contains" | "only";
}

/** Serving list-filter dimensions as the API helpers take them. */
export interface ServingFilterParams {
  /** Repeatable observed serving-model values. */
  observedModel?: string[];
  /** Repeatable API-provider values (the existing `provider` dimension). */
  provider?: string[];
  /** Repeatable serving-host values. */
  host?: string[];
  /** Repeatable serving-route values. */
  route?: string[];
  /** Repeatable served-tier values. */
  serviceTier?: string[];
  /** Dimensions whose null value is selected in addition to any values. */
  servingUnknown?: ServingUnknownDimension[];
  /** `contains` (default): one matching request; `only`: every request. */
  servingMode?: "contains" | "only";
}

/** Serialize the serving filter dimensions into list-query params, joining
 * multi-values with commas the way every other multi-value dimension on the
 * runs list does (the backend accepts both forms). */
export function servingFilterQuery(
  params: ServingFilterParams | undefined,
): Record<string, string | undefined> {
  if (!params) return {};
  const join = (values?: string[]): string | undefined =>
    values && values.length > 0 ? values.join(",") : undefined;
  const unknown = params.servingUnknown;
  return {
    observed_model: join(params.observedModel),
    provider: join(params.provider),
    host: join(params.host),
    route: join(params.route),
    service_tier: join(params.serviceTier),
    serving_unknown: join(unknown as string[] | undefined),
    serving_mode: params.servingMode,
  };
}

/** Parse comma-joined filter values from a URLSearchParams entry. */
export function parseServingFilterValues(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

// Format helpers

/** The identity tuple as one label, skipping unreported dimensions:
 * `"fireworks · priority"`, `"openrouter · baseten · nitro"`. Empty string
 * when nothing was reported. */
export function servingIdentityLabel(identity: ServingIdentity): string {
  return [
    identity.api_provider,
    identity.serving_host,
    identity.route,
    identity.service_tier,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" \u00b7 ");
}

/** tok/s with one decimal under 100 and integers above: the precision a
 * host comparison can actually read. */
export function formatTokPerS(value: number): string {
  return `${value < 100 ? value.toFixed(1) : Math.round(value)} tok/s`;
}

/** A rate cell: `"121 tok/s \u00b7 3"` with its sample count, or an em dash
 * when no median exists. */
export function formatRateSummary(rate: RateSummary): string {
  if (rate.median == null) return "\u2014";
  const base = formatTokPerS(rate.median);
  return rate.samples > 0 ? `${base} \u00b7 ${rate.samples}` : base;
}

/** Display name for a token scope. */
export function scopeLabel(scope: "text" | "all_output" | "unknown"): string {
  if (scope === "text") return "Text";
  if (scope === "all_output") return "All Output";
  return "Unknown Scope";
}

/** The one-line cost-coverage summary: what each pricing quality covered
 * and how many calls were left out. Empty string when nothing to say. */
export function costCoverageLabel(coverage: CostCoverage | null | undefined): string {
  if (!coverage) return "";
  const parts: string[] = [];
  if (coverage.reported != null) parts.push(`reported ${formatCostMicro(coverage.reported)}`);
  if (coverage.qualified_estimate != null) {
    parts.push(`qualified ${formatCostMicro(coverage.qualified_estimate)}`);
  }
  if (coverage.model_only_estimate != null) {
    parts.push(`model-only ${formatCostMicro(coverage.model_only_estimate)}`);
  }
  if (coverage.unpriced_calls > 0) parts.push(`${coverage.unpriced_calls} unpriced`);
  if (coverage.ambiguous_calls > 0) parts.push(`${coverage.ambiguous_calls} ambiguous`);
  if (coverage.aggregate_charge_observations > 0) {
    parts.push(`${coverage.aggregate_charge_observations} aggregate`);
  }
  if (coverage.excluded_error_calls > 0) {
    parts.push(`${coverage.excluded_error_calls} errored excluded`);
  }
  return parts.join(" \u00b7 ");
}

/** Plain-English reason a streaming rate is absent. */
export const STREAMING_REASON_LABELS: Record<
  NonNullable<GenerationRates["streaming_unavailable_reason"]>,
  string
> = {
  missing_timing: "no first-content timing",
  invalid_timing: "invalid timing window",
  missing_usage: "no output usage",
  scope_mismatch: "token and timing scopes differ",
  unknown_scope: "token scope unknown",
  incomplete_call: "call did not complete",
  aggregate_only: "aggregate wrapper",
};

/** Human label for the human-unfriendly wire reasons. */
export function streamingReasonLabel(
  reason: GenerationRates["streaming_unavailable_reason"],
): string | null {
  if (reason == null) return null;
  return STREAMING_REASON_LABELS[reason] ?? reason;
}

/** The compact one-line serving cell for a run/batch row:
 * uniform -> the identity label; mixed -> "Mixed \u00b7 N setups"; unknown ->
 * "Unknown"; no_data -> "No data"; partial -> the dominant shape with its
 * qualifier. Empty string when the summary carries no readable state. */
export function servingCompactLabel(summary: ServingSummary): string {
  const hidden = totalSetupCount(summary);
  switch (summary.state) {
    case "no_data":
      return "No data";
    case "unknown":
      return "Unknown";
    case "uniform": {
      const label = summary.groups[0] ? servingIdentityLabel(summary.groups[0].identity) : "";
      return label || "Unknown";
    }
    case "mixed":
      return `Mixed \u00b7 ${hidden} setups`;
    case "partial": {
      // Coverage is incomplete, but a single visible identity is still the
      // most useful thing the cell can say.
      const one =
        hidden === 1 && summary.groups[0]
          ? servingIdentityLabel(summary.groups[0].identity)
          : "";
      if (one) return `${one} \u00b7 Partial`;
      return hidden > 1 ? `Partial \u00b7 ${hidden} setups` : "Partial";
    }
  }
}

/** Distinct setups including the ones truncated out of the inline groups. */
export function totalSetupCount(summary: ServingSummary): number {
  if (summary.total_groups > 0) return summary.total_groups;
  return summary.groups.length;
}

/** Build a ServingIdentity from the flat per-call fields the observation
 * detail API carries. Pure relabeling: nothing is inferred, and unreported
 * dimensions stay null. */
export function servingIdentityFromCallFields(
  call: ServingCallFields,
): ServingIdentity | null {
  const identity: ServingIdentity = {
    model: call.observed_model ?? call.model ?? null,
    instrumentation_provider: call.instrumentation_provider ?? null,
    api_provider: call.api_provider ?? null,
    serving_host: call.serving_host ?? null,
    route: call.route ?? null,
    requested_service_tier: call.requested_service_tier ?? null,
    service_tier: call.service_tier ?? null,
    request_model: call.request_model ?? null,
    response_model: call.response_model ?? null,
    evidence: null,
  };
  const reported = servingIdentityLabel(identity) || identity.model;
  return reported ? identity : null;
}

/** The flat serving fields the observation detail response carries
 * (additive; absent on old backends). Structural, so any response shaped
 * like this maps without importing trace-detail types here. */
export interface ServingCallFields {
  model?: string | null;
  observed_model?: string | null;
  instrumentation_provider?: string | null;
  api_provider?: string | null;
  serving_host?: string | null;
  route?: string | null;
  requested_service_tier?: string | null;
  service_tier?: string | null;
  request_model?: string | null;
  response_model?: string | null;
}

/** Build the rate view for one call from the flat per-call timing fields.
 * The rate medians live only in summaries; a single call carries TTFT and
 * its token scope, which is what this surfaces. Null when the call reported
 * neither. */
export function generationRatesFromCallFields(call: {
  time_to_first_token_ms?: number | null;
  output_token_scope?: string | null;
}): GenerationRates | null {
  const scope =
    call.output_token_scope === "text" || call.output_token_scope === "all_output"
      ? call.output_token_scope
      : "unknown";
  if (call.time_to_first_token_ms == null && scope === "unknown") return null;
  return {
    time_to_first_token_ms: call.time_to_first_token_ms ?? null,
    whole_call_output_tokens_per_second: null,
    streaming_output_tokens_per_second: null,
    output_token_scope: scope,
    streaming_unavailable_reason: null,
  };
}
