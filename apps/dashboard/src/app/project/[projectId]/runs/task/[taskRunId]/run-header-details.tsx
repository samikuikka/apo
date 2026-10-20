"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { TriggerInline } from "@/components/trigger-badge";
import type { AgentTaskRunTrigger } from "@/lib/agent-task-api";

export interface RunHeaderHostFact {
  label: string;
  calls: number;
}

/** Run-header facts, pre-resolved by the page. The header stays a dumb
 * renderer so the quiet line and the details card can never disagree
 * about what the run actually was. */
export interface RunHeaderFacts {
  taskPathFull: string;
  taskPathTail: string;
  adapterName: string | null;
  /** Configured model — what the adapter was told to run. */
  configuredModel: string | null;
  /** Configured effort; null when the adapter reported none. */
  effort: string | null;
  /** primary_model when it diverged from the configured one (gateway
   * fallback, or no configuration at all on pre-config runs). The drift
   * notice strip owns the loud treatment; this is the quiet reference
   * value. */
  observedModel: string | null;
  hosts: RunHeaderHostFact[];
  trigger: AgentTaskRunTrigger | null;
  /** Who asked for the batch, resolved from their credential — distinct
   * from the free-text trigger actor, which a caller chose themselves. */
  requestedBy: string | null;
  batchRunId: string;
  batchHref: string;
  startedAt: string | null;
}

const utcFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** "2h ago"-style stamp for the quiet line; the full UTC timestamp rides
 * in tooltips and the details card. */
function formatRelativeTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const mins = Math.floor(ms / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return `${Math.floor(days / 7)}w ago`;
}

function formatFull(iso: string | null): string {
  return iso ? `${utcFormatter.format(new Date(iso))} UTC` : "—";
}

/** The header keeps three or four headline facts visible; everything else
 * is reference material behind the Details toggle. */
export function RunHeaderMetadata({ facts }: { facts: RunHeaderFacts }) {
  const [open, setOpen] = useState(false);

  const lineItems: { key: string; node: ReactNode }[] = [
    {
      key: "path",
      node: (
        <span className="font-mono" title={facts.taskPathFull}>
          {facts.taskPathTail}
        </span>
      ),
    },
  ];
  // Pre-config runs never reported a configured model; the observed one is
  // the model the run actually served, so the line falls back to it.
  const lineModel = facts.configuredModel ?? facts.observedModel;
  if (lineModel) {
    lineItems.push({
      key: "model",
      node: (
        <span
          className="font-mono text-foreground/80"
          title={facts.effort ? `effort ${facts.effort} (adapter-reported)` : undefined}
        >
          {lineModel}
        </span>
      ),
    });
  }
  lineItems.push(
    {
      key: "trigger",
      node: facts.trigger?.source ? (
        <TriggerInline trigger={facts.trigger} />
      ) : (
        <span>batch</span>
      ),
    },
    {
      key: "started",
      node: (
        <span title={formatFull(facts.startedAt)} suppressHydrationWarning>
          {formatRelativeTime(facts.startedAt)}
        </span>
      ),
    },
  );

  return (
    <div className="mt-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {lineItems.map((item, i) => (
          <span key={item.key} className="inline-flex items-center gap-3">
            {i > 0 && <span className="text-muted-foreground/50">·</span>}
            {item.node}
          </span>
        ))}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="inline-flex items-center gap-1 border border-border bg-card px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground hover:text-foreground"
        >
          Details
          <span className="text-muted-foreground/60" aria-hidden>
            {open ? "▾" : "▸"}
          </span>
        </button>
      </div>

      {open && (
        <div className="mt-3 max-w-3xl border border-border bg-card px-4 py-3">
          <div className="grid gap-x-8 gap-y-4 sm:grid-cols-3">
            <ModelSection facts={facts} />
            <OriginSection facts={facts} />
            <TaskSection facts={facts} />
          </div>
        </div>
      )}
    </div>
  );
}

function ModelSection({ facts }: { facts: RunHeaderFacts }) {
  if (!facts.configuredModel && !facts.observedModel && facts.hosts.length === 0) {
    return null;
  }
  return (
    <DetailsSection title="Model">
      <GroupRow label="Configured">
        {facts.configuredModel ?? (
          <span className="text-muted-foreground">not reported</span>
        )}
      </GroupRow>
      <GroupRow label="Effort">
        {facts.effort ?? <span className="text-muted-foreground">not reported</span>}
        <span className="ml-2 font-sans text-[10px] text-muted-foreground/60">
          adapter-reported
        </span>
      </GroupRow>
      {facts.observedModel && (
        <GroupRow
          label="Observed"
          // The drift pointer only holds when something was configured to
          // drift from; pre-config runs show the observed model with no
          // notice behind it.
          title={
            facts.configuredModel
              ? "differs from the configured model — see drift notice below"
              : undefined
          }
        >
          {facts.observedModel}
        </GroupRow>
      )}
      {facts.hosts.length > 0 && (
        <GroupRow label="Hosts" title={facts.hosts.map((h) => h.label).join(" · ")}>
          <HostsValue hosts={facts.hosts} />
        </GroupRow>
      )}
    </DetailsSection>
  );
}

function OriginSection({ facts }: { facts: RunHeaderFacts }) {
  return (
    <DetailsSection title="Origin">
      {facts.adapterName && <GroupRow label="Adapter">{facts.adapterName}</GroupRow>}
      {facts.trigger?.source && (
        <GroupRow label="Trigger">
          <TriggerInline trigger={facts.trigger} />
        </GroupRow>
      )}
      {facts.requestedBy && <GroupRow label="Requested by">{facts.requestedBy}</GroupRow>}
      <GroupRow label="Batch">
        <Link
          href={facts.batchHref}
          className="hover:text-foreground hover:underline"
          title={facts.batchRunId}
        >
          {facts.batchRunId}
        </Link>
      </GroupRow>
    </DetailsSection>
  );
}

function TaskSection({ facts }: { facts: RunHeaderFacts }) {
  return (
    <DetailsSection title="Task">
      <GroupRow label="Path" title={facts.taskPathFull}>
        {facts.taskPathFull}
      </GroupRow>
      <GroupRow
        label="Started"
        title={facts.startedAt ? formatRelativeTime(facts.startedAt) : undefined}
      >
        {formatFull(facts.startedAt)}
      </GroupRow>
    </DetailsSection>
  );
}

function DetailsSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
        {title}
      </h3>
      {children}
    </section>
  );
}

function GroupRow({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-mono text-xs text-foreground" title={title}>
        {children}
      </span>
    </div>
  );
}

function HostsValue({ hosts }: { hosts: RunHeaderHostFact[] }) {
  return (
    <>
      {hosts.map((host, i) => (
        <span key={host.label}>
          {i > 0 && <span className="text-muted-foreground/50"> · </span>}
          {host.label}
          <span className="text-muted-foreground"> ×{host.calls}</span>
        </span>
      ))}
    </>
  );
}
