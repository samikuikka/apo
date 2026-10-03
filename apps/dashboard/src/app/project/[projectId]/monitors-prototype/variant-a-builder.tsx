// PROTOTYPE — Variant A: respan-faithful monitor editor. A sentence-shaped
// trigger builder (When [metric] of task runs [op] [threshold] over [window]),
// Where filters, notification destinations, and the standout respan feature:
// a live alert preview rendered from sample data as you edit.

"use client";

import { useState } from "react";
import { ArrowLeft, ChevronDown, ChevronRight, Plus, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CHANNEL_LABELS,
  DEFAULT_OPERATORS,
  DEFAULT_THRESHOLDS,
  METRIC_TREE,
  MONITOR_METRICS,
  OPERATOR_LABELS,
  WHERE_FIELDS,
  blankMonitor,
  breaches,
  categoryOfMetric,
  formatMetricValue,
  formatThreshold,
  relativeTime,
  triggerSentence,
  whereSummary,
  type ChannelKind,
  type MonitorLifecycle,
  type MonitorMetricId,
  type MonitorOperator,
  type MonitorStub,
  type MonitorWindow,
  type ProjectSnapshot,
} from "./monitors-data";
import { MonitorStateChip } from "./monitor-bits";

const OPERATORS: MonitorOperator[] = ["lt", "gt", "gte"];
const WINDOWS: MonitorWindow[] = ["1h", "6h", "24h", "7d"];
const CHANNEL_KINDS: ChannelKind[] = ["slack", "webhook", "github_issue"];

const selectClass = "h-8 text-xs";

interface VariantAProps {
  projectId: string;
  monitors: MonitorStub[];
  snapshot: ProjectSnapshot;
}

type ListFilter = "all" | "breached" | MonitorLifecycle;

/** respan separates browsing from editing: the list page shows the
 * automations, the editor is its own surface — one page holding name,
 * what-to-watch, and the full trigger config together. Deploying a new
 * automation lands it back in the list. (apo's name for this concept is
 * Automations.) */
export default function VariantABuilder({
  monitors,
  snapshot,
}: VariantAProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ListFilter>("all");
  const [created, setCreated] = useState<MonitorStub[]>([]);
  const allMonitors = [...created, ...monitors];

  const selected =
    selectedId === null
      ? null
      : selectedId === "new"
        ? blankMonitor()
        : (allMonitors.find((m) => m.id === selectedId) ?? null);

  if (selected) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
        <Button
          type="button"
          variant="ghost"
          className="h-7 w-fit px-2 text-xs text-muted-foreground"
          onClick={() => setSelectedId(null)}
        >
          <ArrowLeft className="size-3.5" aria-hidden />
          Automations
        </Button>
        <MonitorEditor
          key={selectedId ?? selected.id}
          monitor={selected}
          snapshot={snapshot}
          onDeployed={(deployed) => {
            setCreated((prev) => [deployed, ...prev]);
            setSelectedId(null);
          }}
        />
      </div>
    );
  }

  const matches = (m: MonitorStub) => {
    if (filter === "all") return true;
    if (filter === "breached") return m.breached;
    return m.lifecycle === filter;
  };
  const visible = allMonitors.filter(matches);
  const count = (f: ListFilter) =>
    f === "all"
      ? allMonitors.length
      : f === "breached"
        ? allMonitors.filter((m) => m.breached).length
        : allMonitors.filter((m) => m.lifecycle === f).length;
  const FILTERS: ListFilter[] = ["all", "breached", "deployed", "paused", "draft"];

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold tracking-tight">
            Automations
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            Watch capability health over a window — alert when a threshold is
            crossed.
          </p>
        </div>
        <Button
          type="button"
          className="h-8 text-xs"
          onClick={() => setSelectedId("new")}
        >
          <Plus className="size-4" aria-hidden />
          New Automation
        </Button>
      </header>

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter automations">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`h-7 border px-2.5 text-xs capitalize transition-colors ${
              filter === f
                ? "border-foreground/60 bg-accent text-foreground"
                : "border-border text-muted-foreground hover:border-foreground/40"
            }`}
          >
            {f}
            <span className="ml-1.5 font-mono text-[10px] tabular-nums">
              {count(f)}
            </span>
          </button>
        ))}
      </div>

      <div className="divide-y divide-border border border-border bg-card">
        {visible.length === 0 ? (
          <p className="px-3 py-8 text-center text-xs text-muted-foreground">
            No monitors match this filter.
          </p>
        ) : (
          visible.map((monitor) => (
            <button
              key={monitor.id}
              type="button"
              onClick={() => setSelectedId(monitor.id)}
              className="grid w-full grid-cols-[minmax(0,1fr)_120px_150px_110px] items-center gap-4 px-3 py-2.5 text-left transition-colors hover:bg-accent/30"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">
                  {monitor.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {triggerSentence(monitor)} · {whereSummary(monitor.where)}
                </span>
                {monitor.channels.length > 0 ? (
                  <span className="mt-0.5 block truncate text-[10px] text-muted-foreground/70">
                    {monitor.channels.map((c) => CHANNEL_LABELS[c.kind]).join(" · ")}
                  </span>
                ) : null}
              </span>
              <span className="text-right font-mono text-[13px] tabular-nums">
                <span className={monitor.breached ? "text-destructive" : ""}>
                  {formatMetricValue(monitor.metric, monitor.currentValue)}
                </span>
                <span className="block text-[10px] text-muted-foreground">
                  of {formatThreshold(monitor.metric, monitor.threshold)}
                </span>
              </span>
              <span className="flex justify-end">
                <MonitorStateChip monitor={monitor} />
              </span>
              <span className="text-right text-xs text-muted-foreground">
                fired {relativeTime(monitor.fires[0]?.at ?? null)}
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function MonitorEditor({
  monitor,
  snapshot,
  onDeployed,
}: {
  monitor: MonitorStub;
  snapshot: ProjectSnapshot;
  onDeployed?: (deployed: MonitorStub) => void;
}) {
  const [name, setName] = useState(monitor.name);
  const [metric, setMetric] = useState<MonitorMetricId>(monitor.metric);
  const [openCategories, setOpenCategories] = useState<Set<string>>(
    () => new Set([categoryOfMetric(monitor.metric)]),
  );
  const [operator, setOperator] = useState<MonitorOperator>(monitor.operator);
  const [thresholdText, setThresholdText] = useState(() =>
    thresholdToText(monitor.metric, monitor.threshold),
  );
  const [window, setWindow] = useState<MonitorWindow>(monitor.window);
  const [where, setWhere] = useState(monitor.where);
  const [channels, setChannels] = useState(monitor.channels);
  const [deployed, setDeployed] = useState(monitor.lifecycle === "deployed");
  const [testNote, setTestNote] = useState<string | null>(null);

  const threshold = textToThreshold(metric, thresholdText);
  const currentValue = snapshot.currentValues[metric];
  const isBreached = breaches(operator, currentValue, threshold);
  const metricMeta = MONITOR_METRICS[metric];

  return (
    <section aria-label="Automation editor" className="border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex min-w-0 items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Untitled automation"
            aria-label="Automation name"
            className="h-8 w-64 text-sm font-semibold"
          />
          <MonitorStateChip
            monitor={{
              ...monitor,
              lifecycle: deployed ? monitor.lifecycle : monitor.lifecycle === "draft" ? "draft" : monitor.lifecycle,
              breached: deployed && isBreached,
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            className="h-8 text-xs"
            disabled={channels.length === 0}
            title={channels.length === 0 ? "Add a destination to deploy" : undefined}
            onClick={() => {
              // Deploying a brand-new automation lands it in the list —
              // the two views work together instead of dead-ending.
              if (!deployed && monitor.id === "new" && onDeployed) {
                onDeployed({
                  ...monitor,
                  id: `created-${Date.now()}`,
                  name: name.trim() || "Untitled automation",
                  metric,
                  operator,
                  threshold,
                  window,
                  where,
                  channels,
                  lifecycle: "deployed",
                });
                return;
              }
              setDeployed((d) => !d);
            }}
          >
            {deployed ? "Pause" : "Deploy"}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-5 px-4 py-4">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted-foreground">Trigger</p>
          <div className="flex flex-wrap items-center gap-1.5 text-[13px]">
            <span>When</span>
            <Select
              value={metric}
              onValueChange={(v) => {
                const next = v as MonitorMetricId;
                setMetric(next);
                setOpenCategories((prev) =>
                  new Set([...prev, categoryOfMetric(next)]),
                );
                // Units differ per metric — a pass-rate threshold makes no
                // sense as a dollar amount, so reset to the metric's defaults.
                setOperator(DEFAULT_OPERATORS[next]);
                setThresholdText(
                  thresholdToText(next, DEFAULT_THRESHOLDS[next]),
                );
              }}
            >
              <SelectTrigger className={`${selectClass} w-44`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {METRIC_TREE.map((group) => {
                  const open = openCategories.has(group.category);
                  return (
                    <div key={group.category}>
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() =>
                          setOpenCategories((prev) => {
                            const next = new Set(prev);
                            if (next.has(group.category)) {
                              next.delete(group.category);
                            } else {
                              next.add(group.category);
                            }
                            return next;
                          })
                        }
                        className="flex w-full cursor-pointer items-center gap-1 px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                      >
                        {open ? (
                          <ChevronDown className="size-3.5" aria-hidden />
                        ) : (
                          <ChevronRight className="size-3.5" aria-hidden />
                        )}
                        {group.category}
                      </button>
                      {open
                        ? group.metrics.map((id) => (
                            <SelectItem key={id} value={id} className="pl-7">
                              {MONITOR_METRICS[id].label}
                            </SelectItem>
                          ))
                        : null}
                    </div>
                  );
                })}
              </SelectContent>
            </Select>
            <span>of</span>
            <Select value="task_runs" onValueChange={() => undefined}>
              <SelectTrigger className={`${selectClass} w-28`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="task_runs">task runs</SelectItem>
              </SelectContent>
            </Select>
            <span>is</span>
            <Select value={operator} onValueChange={(v) => setOperator(v as MonitorOperator)}>
              <SelectTrigger className={`${selectClass} w-16`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPERATORS.map((op) => (
                  <SelectItem key={op} value={op}>
                    {OPERATOR_LABELS[op]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={thresholdText}
              onChange={(e) => setThresholdText(e.target.value)}
              className="h-8 w-20 font-mono text-xs tabular-nums"
              aria-label="Threshold"
            />
            <span>over</span>
            <Select value={window} onValueChange={(v) => setWindow(v as MonitorWindow)}>
              <SelectTrigger className={`${selectClass} w-20`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WINDOWS.map((w) => (
                  <SelectItem key={w} value={w}>
                    {w}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted-foreground">Where</p>
          {where.map((condition, index) => (
            <div key={index} className="flex flex-wrap items-center gap-1.5">
              {index > 0 ? <span className="text-xs text-muted-foreground">and</span> : null}
              <Select value={condition.field} onValueChange={() => undefined}>
                <SelectTrigger className={`${selectClass} w-36`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WHERE_FIELDS.map((field) => (
                    <SelectItem key={field} value={field}>
                      {field}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={condition.operator} onValueChange={() => undefined}>
                <SelectTrigger className={`${selectClass} w-28`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="=">=</SelectItem>
                  <SelectItem value="contains">contains</SelectItem>
                </SelectContent>
              </Select>
              <Input
                value={condition.value}
                onChange={() => undefined}
                className="h-8 w-44 font-mono text-xs"
                aria-label="Filter value"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Remove condition"
                onClick={() => setWhere((prev) => prev.filter((_, i) => i !== index))}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="ghost"
            className="h-7 w-fit text-xs text-muted-foreground"
            onClick={() =>
              setWhere((prev) => [
                ...prev,
                { field: "task", operator: "contains", value: "" },
              ])
            }
          >
            <Plus className="size-3.5" aria-hidden />
            Add condition
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-semibold text-muted-foreground">
            Notifications
          </p>
          {channels.map((channel, index) => (
            <div key={index} className="flex flex-wrap items-center gap-1.5 text-[13px]">
              <span>Send</span>
              <Select value={channel.kind} onValueChange={() => undefined}>
                <SelectTrigger className={`${selectClass} w-32`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CHANNEL_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {CHANNEL_LABELS[kind]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <span>to</span>
              <Input
                value={channel.target}
                onChange={() => undefined}
                className="h-8 w-56 font-mono text-xs"
                aria-label="Destination"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label="Remove destination"
                onClick={() =>
                  setChannels((prev) => prev.filter((_, i) => i !== index))
                }
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              className="h-7 w-fit text-xs text-muted-foreground"
              onClick={() =>
                setChannels((prev) => [...prev, { kind: "slack", target: "" }])
              }
            >
              <Plus className="size-3.5" aria-hidden />
              Add destination
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="h-7 w-fit text-xs text-muted-foreground"
              disabled={channels.length === 0}
              title={
                channels.length === 0 ? "Add a destination to test" : undefined
              }
              onClick={() =>
                setTestNote(
                  `Test alert sent to ${channels[0].target} — nothing was actually delivered (prototype).`,
                )
              }
            >
              <Zap className="size-3.5" aria-hidden />
              Send Test Alert
            </Button>
            {testNote ? (
              <span className="text-xs text-muted-foreground">{testNote}</span>
            ) : null}
          </div>
        </div>
      </div>

      <div className="border-t border-border bg-muted/20 px-4 py-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold">Alert Preview</p>
          <span className="border border-warning/40 px-1.5 py-0.5 text-[10px] font-medium text-warning">
            [PREVIEW] Sample data, not a live alert
          </span>
        </div>
        <div className="mt-3 max-w-md border border-border bg-background p-3">
          <p className="text-[13px]">
            <span className="font-semibold">apo</span>
            <span className="ml-2 text-[10px] text-muted-foreground">
              APP · just now
            </span>
          </p>
          <p className="mt-1.5 text-[13px] font-medium">{monitor.name}</p>
          <p className="mt-1 text-[13px]">
            {currentValue === null ? (
              "No runs in scope yet — the monitor is armed and waiting for data."
            ) : (
              <>
                {metricMeta.label} is{" "}
                <span
                  className={`font-mono ${isBreached ? "text-destructive" : ""}`}
                >
                  {formatMetricValue(metric, currentValue)}
                </span>{" "}
                —{" "}
                {isBreached
                  ? `${operator === "lt" ? "below the" : "above the"} ${formatThreshold(metric, threshold)} ${operator === "lt" ? "floor" : "limit"} over the last ${window}.`
                  : `within the ${formatThreshold(metric, threshold)} bound over the last ${window}. No alert.`}
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{snapshot.detail}</p>
          <span className="mt-2 inline-block border border-border px-2 py-1 text-xs">
            View Runs
          </span>
        </div>
      </div>
    </section>
  );
}

const PERCENT_METRIC_IDS: MonitorMetricId[] = [
  "suite_pass_rate",
  "checks_pass_rate",
  "error_rate",
];

function thresholdToText(metric: MonitorMetricId, threshold: number): string {
  if (PERCENT_METRIC_IDS.includes(metric)) return String(Math.round(threshold * 100));
  return String(threshold);
}

function textToThreshold(metric: MonitorMetricId, text: string): number {
  const parsed = Number(text);
  if (Number.isNaN(parsed)) return 0;
  return PERCENT_METRIC_IDS.includes(metric) ? parsed / 100 : parsed;
}
