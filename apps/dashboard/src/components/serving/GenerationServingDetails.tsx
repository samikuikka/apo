"use client";

import { cn } from "@/lib/utils";
import {
  formatTokPerS,
  servingIdentityLabel,
  streamingReasonLabel,
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
 * either may be null on old backends, and null renders nothing.
 */
export function GenerationServingDetails({ identity, rates }: GenerationServingDetailsProps) {
  if (!identity && !rates) return null;
  return (
    <section
      aria-label="Serving"
      className="space-y-1.5 border border-border bg-card p-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-xs font-semibold text-foreground">Serving</span>
        {identity && (
          <span className="font-mono text-[12px] text-muted-foreground">
            {servingIdentityLabel(identity) || "Unknown"}
          </span>
        )}
      </div>
      <dl className="grid grid-cols-[auto_1fr] items-baseline gap-x-3 gap-y-1 text-[11px]">
        {identity && <IdentityRows identity={identity} />}
        {rates && <RatesRows rates={rates} />}
      </dl>
    </section>
  );
}

/** One label/value row; the value renders as an em dash when unreported. */
function Row({
  label,
  value,
  mono = true,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground/70">{label}</dt>
      <dd className={cn("truncate text-foreground", mono && "font-mono")}>{value ?? "\u2014"}</dd>
    </>
  );
}

function IdentityRows({ identity }: { identity: ServingIdentity }) {
  return (
    <>
      {identity.model && <Row label="Model" value={identity.model} />}
      <Row label="API Provider" value={identity.api_provider} />
      <Row label="Serving Host" value={identity.serving_host} />
      <Row label="Route" value={identity.route} />
      <Row label="Requested Tier" value={identity.requested_service_tier} />
      <Row label="Served Tier" value={identity.service_tier} />
      {identity.request_model && <Row label="Request Model" value={identity.request_model} />}
      {identity.response_model && <Row label="Response Model" value={identity.response_model} />}
    </>
  );
}

function RatesRows({ rates }: { rates: GenerationRates }) {
  const streamingReason = streamingReasonLabel(rates.streaming_unavailable_reason);
  return (
    <>
      {rates.time_to_first_token_ms != null && (
        <Row
          label="Time To First Token"
          value={`${Math.round(rates.time_to_first_token_ms)} ms`}
        />
      )}
      {rates.whole_call_output_tokens_per_second != null && (
        <Row
          label="Whole-Call Rate"
          value={formatTokPerS(rates.whole_call_output_tokens_per_second)}
        />
      )}
      {rates.streaming_output_tokens_per_second != null && (
        <Row
          label="Streaming Rate"
          value={formatTokPerS(rates.streaming_output_tokens_per_second)}
        />
      )}
      {rates.output_token_scope !== "unknown" && (
        <Row
          label="Token Scope"
          value={rates.output_token_scope === "text" ? "Text" : "All Output"}
        />
      )}
      {streamingReason && (
        <Row label="Streaming Unavailable" value={streamingReason} mono={false} />
      )}
    </>
  );
}
