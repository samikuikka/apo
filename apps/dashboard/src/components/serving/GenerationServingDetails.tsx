"use client";

import { Fragment } from "react";

import {
  formatTokPerS,
  servingIdentityLabel,
  type GenerationRates,
  type ServingIdentity,
} from "@/lib/serving-types";

export interface GenerationServingDetailsProps {
  identity: ServingIdentity | null;
  rates: GenerationRates | null;
}

/**
 * One generation call's serving evidence (issue #307): who served it and how
 * fast it decoded. Both props come straight from the observation detail API;
 * either may be null on old backends. Only reported values render, and a call
 * that reported nothing renders nothing.
 */
export function GenerationServingDetails({ identity, rates }: GenerationServingDetailsProps) {
  const label = identity ? servingIdentityLabel(identity) : "";
  const rows = [
    ...(identity ? identityRows(identity) : []),
    ...(rates ? rateRows(rates) : []),
  ];
  if (!label && rows.length === 0) return null;
  return (
    <section
      aria-label="Serving"
      className="space-y-1.5 border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold text-foreground">Serving</span>
        {label && (
          <span className="font-mono text-[12px] text-muted-foreground">{label}</span>
        )}
      </div>
      {rows.length > 0 && (
        <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-[11px]">
          {rows.map(([rowLabel, value]) => (
            <Fragment key={rowLabel}>
              <dt className="text-muted-foreground/70">{rowLabel}</dt>
              <dd className="truncate font-mono text-foreground">{value}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}

type Row = [label: string, value: string];

function reported(rows: [string, string | null | undefined][]): Row[] {
  return rows.filter((row): row is Row => typeof row[1] === "string" && row[1].length > 0);
}

function identityRows(identity: ServingIdentity): Row[] {
  // The shown model is the response model when reported, so a request model
  // that differs from it is a gateway fallback.
  const differs = (value: string | null | undefined) =>
    value && value !== identity.model ? value : null;
  return reported([
    ["Model", identity.model],
    ["API Provider", identity.api_provider],
    ["Serving Host", identity.serving_host],
    ["Route", identity.route],
    ["Requested Tier", identity.requested_service_tier],
    ["Served Tier", identity.service_tier],
    ["Request Model", differs(identity.request_model)],
    ["Response Model", differs(identity.response_model)],
  ]);
}

function rateRows(rates: GenerationRates): Row[] {
  return reported([
    [
      "Time To First Token",
      rates.time_to_first_token_ms != null ? `${Math.round(rates.time_to_first_token_ms)} ms` : null,
    ],
    [
      "Whole-Call Rate",
      rates.whole_call_output_tokens_per_second != null
        ? formatTokPerS(rates.whole_call_output_tokens_per_second)
        : null,
    ],
    [
      "Streaming Rate",
      rates.streaming_output_tokens_per_second != null
        ? formatTokPerS(rates.streaming_output_tokens_per_second)
        : null,
    ],
    [
      "Token Scope",
      rates.output_token_scope === "unknown"
        ? null
        : rates.output_token_scope === "text"
          ? "Text"
          : "All Output",
    ],
  ]);
}
