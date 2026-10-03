// PROTOTYPE — Variant C: alert inbox. Inverts the other two: the page leads
// with the signal (fired alerts derived from real batch runs), monitors are a
// compact rail. Built for the responder — "what broke, when, show me the run".

"use client";

import { useState } from "react";
import { BellOff, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  triggerSentence,
  whereSummary,
  type MonitorFire,
  type MonitorStub,
} from "./monitors-data";
import { MonitorStateChip, MonitorStateDot } from "./monitor-bits";

interface VariantCProps {
  projectId: string;
  monitors: MonitorStub[];
}

export default function VariantCInbox({ projectId, monitors }: VariantCProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState<Set<string>>(new Set());

  const selected = monitors.find((m) => m.id === selectedId) ?? null;
  const activeBreaches = monitors.filter((m) => m.breached);
  const fires = (selected ? selected.fires : monitors.flatMap((m) => m.fires))
    .slice()
    .sort((a, b) => (a.at < b.at ? 1 : -1));

  const ack = (id: string) =>
    setAcknowledged((prev) => new Set(prev).add(id));

  return (
    <div className="flex h-full min-h-0">
      <aside className="flex w-60 shrink-0 flex-col gap-1 border-r border-border p-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-semibold text-muted-foreground">
            Automations
          </p>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label="New automation"
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </div>
        <button
          type="button"
          onClick={() => setSelectedId(null)}
          className={`flex items-center gap-2 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent ${
            selectedId === null ? "bg-accent" : ""
          }`}
        >
          <span aria-hidden className="size-1.5 shrink-0 bg-foreground" />
          All alerts
          <span className="ml-auto font-mono text-[10px] tabular-nums text-muted-foreground">
            {fires.length}
          </span>
        </button>
        {monitors.map((monitor) => (
          <button
            key={monitor.id}
            type="button"
            onClick={() => setSelectedId(monitor.id)}
            className={`flex items-start gap-2 px-2 py-1.5 text-left transition-colors hover:bg-accent ${
              monitor.id === selectedId ? "bg-accent" : ""
            }`}
          >
            <MonitorStateDot monitor={monitor} />
            <span className="min-w-0">
              <span className="block truncate text-xs font-medium">
                {monitor.name}
              </span>
              <span className="block text-[10px] text-muted-foreground">
                {monitor.fires.length} alert
                {monitor.fires.length === 1 ? "" : "s"}
              </span>
            </span>
          </button>
        ))}
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 p-6">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-[18px] font-semibold tracking-tight">
                Alerts
              </h1>
              <p className="mt-1 text-xs text-muted-foreground">
                {selected
                  ? `${selected.name} — ${triggerSentence(selected)} · ${whereSummary(selected.where)}`
                  : "Everything the evaluator fired, newest first."}
              </p>
            </div>
            <Button type="button" variant="outline" className="h-8 text-xs">
              <BellOff className="size-3.5" aria-hidden />
              Mute All
            </Button>
          </header>

          {selected?.breached || (!selected && activeBreaches.length > 0) ? (
            <section aria-label="Active breaches" className="flex flex-col gap-2">
              {(selected ? [selected] : activeBreaches).map((monitor) => (
                <div
                  key={monitor.id}
                  className="border-l-2 border-l-destructive border border-border bg-card px-4 py-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-medium uppercase tracking-wide text-destructive">
                      Breaching now
                    </span>
                    <MonitorStateChip monitor={monitor} />
                  </div>
                  <p className="mt-1 text-[13px] font-medium">{monitor.name}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {triggerSentence(monitor)} · {whereSummary(monitor.where)}
                  </p>
                </div>
              ))}
            </section>
          ) : null}

          {fires.length === 0 ? (
            <p className="px-1 py-8 text-center text-xs text-muted-foreground">
              No alerts fired yet. The evaluator is watching.
            </p>
          ) : (
            <FireFeed projectId={projectId} fires={fires} acknowledged={acknowledged} onAck={ack} />
          )}
        </div>
      </div>
    </div>
  );
}

function FireFeed({
  projectId,
  fires,
  acknowledged,
  onAck,
}: {
  projectId: string;
  fires: MonitorFire[];
  acknowledged: Set<string>;
  onAck: (id: string) => void;
}) {
  const groups = new Map<string, MonitorFire[]>();
  for (const fire of fires) {
    const day = new Date(fire.at).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    });
    const bucket = groups.get(day) ?? [];
    bucket.push(fire);
    groups.set(day, bucket);
  }

  return (
    <div className="flex flex-col gap-4">
      {[...groups.entries()].map(([day, dayFires]) => (
        <section key={day} aria-label={day} className="flex flex-col gap-1.5">
          <p className="px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            {day}
          </p>
          {dayFires.map((fire) => {
            const isAcked = acknowledged.has(fire.id);
            return (
              <article
                key={fire.id}
                className={`border border-border bg-card px-3 py-2.5 ${
                  isAcked ? "opacity-50" : ""
                }`}
              >
                <div className="flex items-baseline justify-between gap-2 text-xs">
                  <span className="font-medium">{fire.headline}</span>
                  <time className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
                    {new Date(fire.at).toLocaleTimeString("en-US", {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {fire.detail}
                </p>
                <div className="mt-2 flex items-center gap-1">
                  <a
                    href={`/project/${projectId}/runs/${fire.batchRunId}`}
                    className="border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
                  >
                    View Run
                  </a>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-7 text-xs text-muted-foreground"
                    disabled={isAcked}
                    onClick={() => onAck(fire.id)}
                  >
                    {isAcked ? "Acknowledged" : "Acknowledge"}
                  </Button>
                </div>
              </article>
            );
          })}
        </section>
      ))}
    </div>
  );
}
