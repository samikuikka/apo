import { Activity, GitCommitHorizontal, ShieldCheck } from "lucide-react";
import type { PrototypeRun } from "./data";
import { summarizeRuns } from "./data";
import { DefinitionBadge, formatModel, StatusMark, statusColor } from "./shared";

export function PulseVariant({ runs }: { runs: PrototypeRun[] }) {
  const baselineRuns = runs.filter((run) => run.baseline);
  const currentConfiguration = baselineRuns.filter(
    (run) => run.model === "Claude Opus 4" && run.effort === "high",
  );
  const summary = summarizeRuns(currentConfiguration);
  const latest = runs[0];

  return (
    <div className="px-6 py-6">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Latest Evidence</div>
          <div className="mt-2 flex items-center gap-3">
            {latest && <StatusMark status={latest.status} />}
            <div>
              <div className="text-[18px] font-semibold tracking-tight capitalize">{latest?.status ?? "No runs"}</div>
              {latest && <div className="mt-0.5 text-xs text-muted-foreground">{latest.relativeTime} · {formatModel(latest.model)} · {latest.execution}</div>}
            </div>
          </div>
        </div>
        {latest && <DefinitionBadge run={latest} />}
      </div>

      <div className="grid border-y border-border md:grid-cols-4 md:divide-x md:divide-border">
        <Metric label="Run Verdicts" value={`${summary.passRate}%`} detail={`${summary.passed}/${summary.verdicts} passed`} />
        <Metric label="Execution Errors" value={`${summary.errors}`} detail={`${summary.total} attempts`} />
        <Metric label="Checks" value={`${summary.checkRate}%`} detail={`${summary.checksPassed}/${summary.checksTotal} passed`} />
        <Metric label="Average Cost" value={`$${summary.averageCost.toFixed(2)}`} detail="per attempt" />
      </div>

      <div className="mt-8 grid gap-8 lg:grid-cols-[minmax(0,1fr)_300px]">
        <section>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-semibold">Reliability History</h2>
            <span className="text-xs text-muted-foreground">Newest first · each square is one attempt</span>
          </div>
          <div className="border border-border">
            <div className="flex min-h-32 items-end gap-2 px-4 py-5">
              {runs.toReversed().map((run) => (
                <div key={run.id} className="group flex min-w-0 flex-1 flex-col items-center gap-2">
                  <span className="invisible whitespace-nowrap text-[10px] text-muted-foreground group-hover:visible">{run.checksPassed}/{run.checksTotal || "—"}</span>
                  <span className={`h-8 w-full max-w-8 ${statusColor(run.status)} ${run.definition === "working" ? "outline outline-1 outline-offset-2 outline-warning" : ""}`} />
                  <span className="max-w-full truncate font-mono text-[9px] text-muted-foreground">{run.execution.slice(0, 4)}</span>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4 border-t border-border px-4 py-2 text-[10px] text-muted-foreground">
              <Legend color="bg-success" label="Pass" />
              <Legend color="bg-destructive" label="Evaluation failure" />
              <Legend color="bg-warning" label="Execution error / working outline" />
            </div>
          </div>
        </section>

        <aside className="border-l border-border pl-6">
          <h2 className="text-sm font-semibold">What Changed</h2>
          <div className="mt-4 space-y-5">
            <Change icon={Activity} title="Working Definition" detail="2 attempts use unpublished a91d031" tone="warning" />
            <Change icon={ShieldCheck} title="Definition v4 Published" detail="3 checks added · current baseline" />
            <Change icon={GitCommitHorizontal} title="Execution b772ef1" detail="Application source changed 2 days ago" />
          </div>
        </aside>
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-semibold">Recent Evidence</h2>
        <div className="divide-y divide-border border-y border-border">
          {runs.slice(0, 6).map((run) => (
            <div key={run.id} className="grid grid-cols-[24px_1fr_auto] items-center gap-3 py-2.5 text-xs">
              <StatusMark status={run.status} size="sm" />
              <div className="min-w-0">
                <span className="font-mono text-foreground">{run.execution}</span>
                <span className="mx-2 text-muted-foreground">·</span>
                <span>{formatModel(run.model)} · {run.effort}</span>
              </div>
              <div className="flex items-center gap-3 text-muted-foreground">
                <DefinitionBadge run={run} />
                <span className="w-16 text-right">{run.relativeTime}</span>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="px-4 py-4 first:pl-0 last:pr-0"><div className="text-xs text-muted-foreground">{label}</div><div className="mt-1 font-mono text-[18px] font-semibold tabular-nums">{value}</div><div className="mt-0.5 text-[10px] text-muted-foreground">{detail}</div></div>;
}

function Legend({ color, label }: { color: string; label: string }) {
  return <span className="flex items-center gap-1.5"><span className={`h-2 w-2 ${color}`} />{label}</span>;
}

function Change({ icon: Icon, title, detail, tone }: { icon: typeof Activity; title: string; detail: string; tone?: "warning" }) {
  return <div className="flex gap-3"><Icon className={`mt-0.5 h-3.5 w-3.5 ${tone === "warning" ? "text-warning" : "text-muted-foreground"}`} /><div><div className="text-xs font-semibold">{title}</div><div className="mt-0.5 text-xs leading-5 text-muted-foreground">{detail}</div></div></div>;
}
