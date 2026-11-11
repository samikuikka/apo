"use client";

import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  costCoverageLabel,
  formatRateSummary,
  scopeLabel,
  servingCompactLabel,
  servingIdentityLabel,
  type ServingGroup,
  type ServingIdentity,
  type ServingSummary as ServingSummaryData,
} from "@/lib/serving-types";

export interface ServingSummaryProps {
  summary: ServingSummaryData | null;
  /** Render the one-line table cell instead of the full breakdown. */
  compact?: boolean;
  /** Fires when a group's identity row is activated (run detail links the
   * tuple to evidence). Absent renders plain text. */
  onSelect?: (identity: ServingIdentity) => void;
}

/**
 * Observed serving evidence for one run or batch (issue #307): which setups
 * served the model calls, at what speed, with what cost coverage. Compact
 * mode is the runs-table cell; the default mode is the dense groups table
 * for run and batch detail. Null renders nothing (old backends).
 */
export function ServingSummary({ summary, compact = false, onSelect }: ServingSummaryProps) {
  if (!summary) return null;
  if (compact) return <CompactCell summary={summary} />;
  return <FullSummary summary={summary} onSelect={onSelect} />;
}

function CompactCell({ summary }: { summary: ServingSummaryData }) {
  return (
    <span
      className="block max-w-[180px] truncate font-mono text-[12px] text-muted-foreground"
      title={compactTitle(summary)}
    >
      {servingCompactLabel(summary)}
    </span>
  );
}

/** Hover text for the cell: the compact label plus call counts. */
function compactTitle(summary: ServingSummaryData): string {
  const parts = [servingCompactLabel(summary), `${summary.calls} calls`];
  if (summary.errored_calls > 0) parts.push(`${summary.errored_calls} errored`);
  if (summary.unknown_provider_calls > 0) parts.push(`${summary.unknown_provider_calls} unknown provider`);
  if (summary.unknown_host_calls > 0) parts.push(`${summary.unknown_host_calls} unknown host`);
  return parts.join(" \u00b7 ");
}

function FullSummary({
  summary,
  onSelect,
}: {
  summary: ServingSummaryData;
  onSelect?: (identity: ServingIdentity) => void;
}) {
  const coverage = costCoverageLabel(summary.cost_coverage);
  // No call reported who served it: a table of empty identities says nothing.
  if (summary.state === "unknown") {
    return (
      <section aria-label="Observed serving" className="space-y-1.5 text-xs text-muted-foreground">
        <p className="font-mono tabular-nums">
          {`${summary.calls} calls \u00b7 serving not reported`}
          {summary.errored_calls > 0 && (
            <span className="text-destructive">{` \u00b7 ${summary.errored_calls} errored`}</span>
          )}
        </p>
        {coverage && <p>Cost coverage: {coverage}</p>}
      </section>
    );
  }
  const hidden = summary.total_groups - summary.groups.length;
  const rowKeys = distinctRowKeys(summary.groups.map((group) => groupKey(group.identity)));
  return (
    <section aria-label="Observed serving" className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <StateBadge state={summary.state} />
        <span className="font-mono tabular-nums">
          <span className="text-foreground">{summary.calls}</span> calls
        </span>
        {summary.errored_calls > 0 && (
          <span className="font-mono tabular-nums text-destructive">
            {summary.errored_calls} errored
          </span>
        )}
        {summary.unknown_provider_calls > 0 && (
          <span className="font-mono tabular-nums">
            {summary.unknown_provider_calls} unknown provider
          </span>
        )}
        {summary.unknown_host_calls > 0 && (
          <span className="font-mono tabular-nums">
            {summary.unknown_host_calls} unknown host
          </span>
        )}
        {summary.aggregate_observations > 0 && (
          <span className="font-mono tabular-nums">
            {summary.aggregate_observations} aggregate
          </span>
        )}
        {summary.task_runs_total > 1 && (
          <span className="font-mono tabular-nums">
            {summary.task_runs_with_evidence}/{summary.task_runs_total} task runs with evidence
          </span>
        )}
      </div>

      <Table density="compact">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead>Serving</TableHead>
            <TableHead className="text-right">Calls</TableHead>
            <TableHead className="text-right">Errors</TableHead>
            <TableHead className="text-right">Whole-Call</TableHead>
            <TableHead className="text-right">Streaming</TableHead>
            <TableHead>Scopes</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {summary.groups.map((group, index) => (
            <GroupRow
              key={rowKeys[index]}
              group={group}
              onSelect={onSelect}
            />
          ))}
        </TableBody>
      </Table>

      {summary.groups_truncated && hidden > 0 && (
        <p className="text-xs text-muted-foreground">+{hidden} more setups</p>
      )}

      {coverage && <p className="text-xs text-muted-foreground">Cost coverage: {coverage}</p>}
    </section>
  );
}

function GroupRow({
  group,
  onSelect,
}: {
  group: ServingGroup;
  onSelect?: (identity: ServingIdentity) => void;
}) {
  const label = servingIdentityLabel(group.identity) || "Not reported";
  return (
    <TableRow className="border-border/60">
      <TableCell>
        <div className="min-w-0">
          {onSelect ? (
            <button
              type="button"
              onClick={() => onSelect(group.identity)}
              className="truncate text-left font-mono text-[12px] text-foreground underline-offset-2 hover:underline"
            >
              {label}
            </button>
          ) : (
            <span className="truncate font-mono text-[12px] text-foreground">{label}</span>
          )}
          {group.identity.model && (
            <span className="block truncate font-mono text-[11px] text-muted-foreground/70">
              {group.identity.model}
            </span>
          )}
        </div>
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] tabular-nums text-foreground">
        {group.calls}
      </TableCell>
      <TableCell
        className={cn(
          "text-right font-mono text-[12px] tabular-nums",
          group.errored_calls > 0 ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {group.errored_calls}
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
        {formatRateSummary(group.whole_call_rate)}
      </TableCell>
      <TableCell className="text-right font-mono text-[12px] tabular-nums text-muted-foreground">
        {formatRateSummary(group.streaming_rate)}
      </TableCell>
      <TableCell>
        <span className="flex flex-wrap gap-1">
          {group.rate_scopes.filter((scoped) => scoped.scope !== "unknown").map((scoped) => (
            <Badge key={scoped.scope} variant="secondary" className="h-5 px-1.5 text-[10px] font-normal">
              {scopeLabel(scoped.scope)}
              {scoped.whole_call_rate.samples > 0 && (
                <span className="text-muted-foreground">
                  {" \u00b7 "}
                  {scoped.whole_call_rate.samples}
                </span>
              )}
            </Badge>
          ))}
        </span>
      </TableCell>
    </TableRow>
  );
}

function StateBadge({ state }: { state: ServingSummaryData["state"] }) {
  // State, not decoration: only incomplete evidence gets a hue.
  const tone =
    state === "partial"
      ? "bg-warning/10 text-warning"
      : state === "mixed"
        ? "bg-muted text-muted-foreground"
        : "bg-muted text-foreground";
  return (
    <span className={cn("inline-flex h-5 items-center px-2 text-[11px] font-medium", tone)}>
      {state === "no_data"
        ? "No serving data"
        : state === "uniform"
          ? "Uniform"
          : state === "mixed"
            ? "Mixed"
            : "Partial"}
    </span>
  );
}

function groupKey(identity: ServingIdentity): string {
  return [
    identity.model ?? "",
    identity.api_provider ?? "",
    identity.serving_host ?? "",
    identity.route ?? "",
    identity.service_tier ?? "",
  ].join("|");
}

/** One stable key per group. The identity tuple is unique by contract; a
 * seen-before suffix keeps duplicate tuples (malformed data) from colliding
 * without keying rows by list position. */
function distinctRowKeys(baseKeys: string[]): string[] {
  const seen = new Map<string, number>();
  return baseKeys.map((base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}~${n}`;
  });
}
