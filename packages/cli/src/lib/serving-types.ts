/** Wire types for the serving identity attached to run list/detail
 * responses (issue #307). Field names mirror the backend's snake_case
 * JSON so `--json` output passes through untouched; null always means
 * unknown, never a provider string. */

export type ServingState = "no_data" | "unknown" | "uniform" | "mixed" | "partial";

export type ServingScope = "text" | "all_output" | "unknown";

export type IdentityField =
  | "instrumentation_provider"
  | "api_provider"
  | "serving_host"
  | "route"
  | "requested_service_tier"
  | "service_tier"
  | "request_model"
  | "response_model";

export type IdentityEvidence = {
  source: string;
  kind: "reported" | "configured" | "convention";
};

/** The observed serving setup one call ran through. Group summaries carry
 * the grouping fields only; per-call evidence lives on trace observations. */
export type ServingIdentity = {
  model?: string | null;
  instrumentation_provider?: string | null;
  api_provider?: string | null;
  serving_host?: string | null;
  route?: string | null;
  requested_service_tier?: string | null;
  service_tier?: string | null;
  request_model?: string | null;
  response_model?: string | null;
  evidence?: Record<IdentityField, IdentityEvidence>;
};

/** One scope's whole-call and streaming medians with sample counts; a
 * group mixing scopes reports no combined median and splits these. */
export type RateSummary = {
  median: number | null;
  samples: number;
};

export type ScopedRates = {
  scope: ServingScope;
  whole_call_rate: RateSummary;
  streaming_rate: RateSummary;
};

export type ServingGroup = {
  identity: ServingIdentity;
  calls: number;
  errored_calls: number;
  whole_call_rate: RateSummary;
  streaming_rate: RateSummary;
  rate_scopes: ScopedRates[];
};

/** Cost totals classified by estimate quality. Nullable sums are micro-USD;
 * null means no eligible priced observation of that class existed. */
export type CostCoverage = {
  reported: number | null;
  qualified_estimate: number | null;
  model_only_estimate: number | null;
  unpriced_calls: number;
  ambiguous_calls: number;
  excluded_error_calls: number;
  aggregate_charge_observations: number;
  partial: boolean;
};

export type ServingSummary = {
  state: ServingState;
  calls: number;
  errored_calls: number;
  unknown_provider_calls: number;
  unknown_host_calls: number;
  aggregate_observations: number;
  groups: ServingGroup[];
  total_groups: number;
  groups_truncated: boolean;
  task_runs_with_evidence: number;
  task_runs_total: number;
  cost_coverage: CostCoverage;
};
