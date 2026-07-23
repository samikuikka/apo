"use client";

import { useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { CopyIdPopover } from "./CopyIdPopover";
import { RunCostBreakdownTooltip } from "./DimensionBreakdownTooltip";
import { DimensionMixBar } from "./DimensionMixBar";
import { CallDetailTabs } from "./CallDetailTabs";
import { useSelection } from "./contexts/SelectionContext";
import { formatCostMicro } from "@/lib/format";

export interface TraceDetailTabsProps {
  run: any;
}

const VALID_RUN_TABS = new Set(["preview", "metadata", "tokens", "costs"]);

function Section({
  title,
  children,
  action,
}: {
  title: string;
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <section className="border-t border-border/60 pt-3 first:border-t-0 first:pt-0">
      <header className="flex items-start justify-between gap-3 pb-2">
        <div className="text-sm font-medium text-foreground">{title}</div>
        {action}
      </header>
      <div>{children}</div>
    </section>
  );
}

function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <div className="text-[11px] text-muted-foreground">
        {label}
      </div>
      <div className="text-right text-sm text-foreground">{value}</div>
    </div>
  );
}

function MetricRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border/60 py-2 last:border-b-0">
      <div className="text-[11px] text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-sm tabular-nums text-foreground">{value}</div>
      {hint ? <div className="hidden text-[11px] text-muted-foreground md:block">{hint}</div> : null}
    </div>
  );
}

export function TraceDetailTabs({ run }: TraceDetailTabsProps) {
  const calls = useMemo(() => run.calls || [], [run.calls]);
  const { detailTab, setDetailTab } = useSelection();
  const activeTab = VALID_RUN_TABS.has(detailTab) ? detailTab : "preview";
  const [previewMode, setPreviewMode] = useState<"preview" | "json">("preview");

  // Trace-level I/O (Langfuse-style). Falls back to first/last call when the
  // trace itself didn't record aggregate input/output.
  const firstCall = calls[0];
  const lastCall = calls[calls.length - 1];
  const traceInput = run.run.input ?? firstCall?.input ?? null;
  const traceOutput = run.run.output ?? lastCall?.output ?? null;

  const totalCost = useMemo(
    () => calls.reduce((sum: number, c: any) => sum + (c.cost || 0), 0),
    [calls],
  );
  const totalLatency = useMemo(
    () => calls.reduce((sum: number, c: any) => sum + (c.latency_ms || 0), 0),
    [calls],
  );
  const avgLatency = calls.length > 0 ? totalLatency / calls.length : 0;

  const promptTokens = useMemo(
    () => calls.reduce((sum: number, c: any) => sum + (c.prompt_tokens || 0), 0),
    [calls],
  );
  const completionTokens = useMemo(
    () => calls.reduce((sum: number, c: any) => sum + (c.completion_tokens || 0), 0),
    [calls],
  );
  const totalTokens = promptTokens + completionTokens;

  const modelBreakdown = useMemo(
    () =>
      Object.entries(
        calls.reduce(
          (
            acc: Record<string, { count: number; tokens: number; cost: number; breakdown: Record<string, number> }>,
            c: any,
          ) => {
            const model = c.model || "unknown";
            if (!acc[model]) {
              acc[model] = { count: 0, tokens: 0, cost: 0, breakdown: {} };
            }
            acc[model].count += 1;
            acc[model].tokens += c.total_tokens || 0;
            acc[model].cost += c.cost || 0;
            // Aggregate per-dimension breakdown for the mix bar (SPEC-136 ticket 11).
            if (c.cost_breakdown) {
              for (const [key, val] of Object.entries(c.cost_breakdown as Record<string, number>)) {
                acc[model].breakdown[key] = (acc[model].breakdown[key] ?? 0) + val;
              }
            }
            return acc;
          },
          {},
        ),
      ) as Array<[string, { count: number; tokens: number; cost: number; breakdown: Record<string, number> }]>,
    [calls],
  );

  return (
    <Tabs value={activeTab} onValueChange={setDetailTab} className="flex h-full min-h-0 flex-col">
      <TabsList variant="line" className="shrink-0 gap-5 border-b border-border px-1">
        <TabsTrigger value="preview">Preview</TabsTrigger>
        <TabsTrigger value="metadata">Metadata</TabsTrigger>
        <TabsTrigger value="tokens">Tokens</TabsTrigger>
        <TabsTrigger value="costs">Costs</TabsTrigger>
      </TabsList>

      <TabsContent value="preview" className="min-h-0 flex-1 overflow-auto p-3">
        <div className="space-y-4 pr-1">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              onClick={() => setPreviewMode("preview")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px]",
                previewMode === "preview" ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
            >
              Formatted
            </button>
            <button
              type="button"
              onClick={() => setPreviewMode("json")}
              className={cn(
                "rounded px-2 py-0.5 text-[11px]",
                previewMode === "json" ? "bg-muted text-foreground" : "text-muted-foreground",
              )}
            >
              JSON
            </button>
          </div>
          {traceInput != null ? (
            <CallDetailTabs data={traceInput} title="Input" viewMode={previewMode} />
          ) : (
            <p className="text-xs text-muted-foreground">No input recorded for this trace.</p>
          )}
          {traceOutput != null ? (
            <CallDetailTabs data={traceOutput} title="Output" viewMode={previewMode} />
          ) : (
            <p className="text-xs text-muted-foreground">No output recorded for this trace.</p>
          )}
        </div>
      </TabsContent>

      <TabsContent value="metadata" className="min-h-0 flex-1 overflow-auto p-3">
        <div className="space-y-4 pr-1">
          <Section title="Trace metadata">
            <div>
              <MetadataRow label="Run ID" value={<CopyIdPopover ids={[{ label: "Run ID", value: run.run.id }]}><span className="font-mono cursor-pointer">{run.run.id}</span></CopyIdPopover>} />
              <MetadataRow label="Project" value={<span className="font-mono">{run.run.project}</span>} />
              <MetadataRow label="Task" value={run.run.task_id ?? "—"} />
              <MetadataRow label="Calls" value={String(calls.length)} />
              <MetadataRow label="Duration" value={run.run.duration_ms != null ? `${run.run.duration_ms}ms` : "—"} />
              <MetadataRow
                label="Started"
                value={
                  run.run.created_at
                    ? new Date(run.run.created_at).toLocaleString("en-US", { timeZone: "UTC" })
                    : "—"
                }
              />
              <MetadataRow
                label="Completed"
                value={
                  run.run.completed_at
                    ? new Date(run.run.completed_at).toLocaleString("en-US", { timeZone: "UTC" })
                    : "—"
                }
              />
              {run.run.environment ? <MetadataRow label="Environment" value={<span className="inline-flex items-center rounded-sm border border-border/70 bg-muted/10 px-1.5 py-0.5 text-[11px]">{run.run.environment}</span>} /> : null}
              {run.run.tags?.length ? <MetadataRow label="Tags" value={<div className="flex flex-wrap gap-1 justify-end">{run.run.tags.map((tag: string) => <span key={tag} className="inline-flex items-center rounded-sm border border-border/70 bg-muted/10 px-1.5 py-0.5 text-[11px]">{tag}</span>)}</div>} /> : null}
              {run.run.session_id ? <MetadataRow label="Session" value={<span className="font-mono text-xs">{run.run.session_id}</span>} /> : null}
              {run.run.user_id ? <MetadataRow label="User" value={<span className="font-mono text-xs">{run.run.user_id}</span>} /> : null}
              {run.run.primary_model ? <MetadataRow label="Primary Model" value={<span className="font-mono text-xs">{run.run.primary_model}</span>} /> : null}
              {run.run.version ? <MetadataRow label="Version" value={<span className="font-mono text-xs">{run.run.version}</span>} /> : null}
              {run.run.external_id ? <MetadataRow label="External ID" value={<span className="font-mono text-xs">{run.run.external_id}</span>} /> : null}
            </div>
          </Section>
        </div>
      </TabsContent>

      <TabsContent value="tokens" className="min-h-0 flex-1 overflow-auto p-3">
        <div className="space-y-4 pr-1">
          <Section title="Token totals">
            <div>
              <MetricRow label="Prompt" value={promptTokens.toLocaleString()} />
              <MetricRow label="Completion" value={completionTokens.toLocaleString()} />
              <MetricRow label="Total" value={totalTokens.toLocaleString()} />
            </div>
          </Section>

          <Section title="Model token usage">
            <div>
              {modelBreakdown.map(([model, stats]) => (
                <div
                  key={model}
                  className="flex items-center justify-between gap-4 border-b border-border/60 py-3 last:border-b-0"
                >
                  <div className="min-w-0">
                    <div className="truncate font-mono text-xs text-foreground">{model}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {stats.count} call{stats.count === 1 ? "" : "s"}
                    </div>
                  </div>
                  <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    <div>{stats.tokens.toLocaleString()} tokens</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </TabsContent>

      <TabsContent value="costs" className="min-h-0 flex-1 overflow-auto p-3">
        <div className="space-y-4 pr-1">
          <Section title="Cost totals">
            <div>
              <MetricRow
                label="Total cost"
                value={totalCost > 0 ? (
                  <RunCostBreakdownTooltip calls={calls}>
                    <span className="font-mono text-sm tabular-nums text-foreground">{formatCostMicro(totalCost)}</span>
                  </RunCostBreakdownTooltip>
                ) : "—"}
              />
              <MetricRow
                label="Avg / call"
                value={calls.length > 0 ? formatCostMicro(totalCost / calls.length) : "—"}
              />
              <MetricRow
                label="Avg latency"
                value={avgLatency > 0 ? `${avgLatency.toFixed(0)}ms` : "—"}
              />
            </div>
          </Section>

          <Section title="Model cost breakdown">
            <div>
              {modelBreakdown.map(([model, stats]) => (
                <div
                  key={model}
                  className="flex items-center justify-between gap-4 border-b border-border/60 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-xs text-foreground">{model}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {stats.count} call{stats.count === 1 ? "" : "s"}
                    </div>
                    {Object.keys(stats.breakdown).length > 0 && (
                      <DimensionMixBar breakdown={stats.breakdown} />
                    )}
                  </div>
                  <div className="text-right font-mono text-xs tabular-nums text-muted-foreground">
                    <div>{stats.cost > 0 ? formatCostMicro(stats.cost) : "—"}</div>
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </TabsContent>
    </Tabs>
  );
}
