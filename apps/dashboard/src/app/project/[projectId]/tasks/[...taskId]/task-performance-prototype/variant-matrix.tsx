import type { PrototypeRun } from "./data";
import { summarizeRuns } from "./data";
import { DefinitionBadge, StatusMark } from "./shared";

const MODELS: PrototypeRun["model"][] = ["Claude Sonnet 4", "Claude Opus 4"];

export function MatrixVariant({ runs }: { runs: PrototypeRun[] }) {
  const executionRevisions = Array.from(new Set(runs.map((run) => run.execution)));
  const latest = runs[0];

  return (
    <div className="px-6 py-6">
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_260px]">
        <section>
          <div className="mb-4 flex items-end justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Controlled Comparison</div>
              <h2 className="mt-1 text-[18px] font-semibold tracking-tight">Execution × Model</h2>
            </div>
            <span className="text-xs text-muted-foreground">Cells retain definition boundaries</span>
          </div>

          <div className="overflow-x-auto border border-border">
            <table className="w-full min-w-[620px] border-collapse text-xs">
              <thead>
                <tr className="border-b border-border bg-card">
                  <th className="px-4 py-3 text-left font-semibold">Execution Revision</th>
                  {MODELS.map((model) => <th key={model} className="border-l border-border px-4 py-3 text-left font-semibold">{model.replace("Claude ", "")}</th>)}
                </tr>
              </thead>
              <tbody>
                {executionRevisions.map((execution) => (
                  <tr key={execution} className="border-b border-border last:border-0">
                    <td className="px-4 py-4 align-top">
                      <div className="font-mono font-semibold">{execution}</div>
                      <div className="mt-1 text-[10px] text-muted-foreground">{execution.startsWith("dirty") ? "Dirty workspace" : "Recorded source"}</div>
                    </td>
                    {MODELS.map((model) => {
                      const cellRuns = runs.filter((run) => run.execution === execution && run.model === model);
                      return <MatrixCell key={model} runs={cellRuns} />;
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <aside className="border border-border bg-card/30 p-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Selected Evidence</div>
          {latest ? (
            <>
              <div className="mt-5 flex items-center gap-3">
                <StatusMark status={latest.status} />
                <div><div className="text-sm font-semibold capitalize">{latest.status}</div><div className="text-[10px] text-muted-foreground">{latest.relativeTime}</div></div>
              </div>
              <dl className="mt-5 space-y-3 border-t border-border pt-4 text-xs">
                <Detail label="Definition"><DefinitionBadge run={latest} /></Detail>
                <Detail label="Execution"><span className="font-mono">{latest.execution}</span></Detail>
                <Detail label="Configuration"><span>{latest.model.replace("Claude ", "")} · {latest.effort}</span></Detail>
                <Detail label="Checks"><span className="font-mono">{latest.checksPassed}/{latest.checksTotal}</span></Detail>
                <Detail label="Cost"><span className="font-mono">${latest.cost.toFixed(2)}</span></Detail>
                <Detail label="Duration"><span className="font-mono">{latest.durationSeconds}s</span></Detail>
              </dl>
            </>
          ) : <div className="mt-5 text-xs text-muted-foreground">No evidence in this scope.</div>}
        </aside>
      </div>

      <section className="mt-8 border-t border-border pt-5">
        <div className="grid gap-5 sm:grid-cols-3">
          <Explanation number="01" title="Choose a row" body="Hold the execution source constant." />
          <Explanation number="02" title="Compare columns" body="See model behavior without mixing code changes." />
          <Explanation number="03" title="Respect definitions" body="A split badge warns when evaluation definitions differ." />
        </div>
      </section>
    </div>
  );
}

function MatrixCell({ runs }: { runs: PrototypeRun[] }) {
  if (runs.length === 0) return <td className="border-l border-border px-4 py-4 text-muted-foreground">No runs</td>;
  const summary = summarizeRuns(runs);
  const definitions = Array.from(new Set(runs.map((run) => run.definition)));
  return (
    <td className="border-l border-border px-4 py-4 align-top">
      <div className="flex items-baseline gap-2"><span className="font-mono text-base font-semibold tabular-nums">{summary.passRate}%</span><span className="text-[10px] text-muted-foreground">{summary.passed}/{summary.verdicts} verdicts</span></div>
      <div className="mt-2 flex gap-1">{runs.map((run) => <StatusMark key={run.id} status={run.status} size="sm" />)}</div>
      <div className="mt-2 text-[10px] text-muted-foreground">{summary.checkRate}% checks · ${summary.averageCost.toFixed(2)}/run</div>
      {definitions.length > 1 && <div className="mt-2 border-l-2 border-warning pl-2 text-[10px] text-warning">Mixed definitions: {definitions.join(", ")}</div>}
      {runs.some((run) => run.definition === "working") && <div className="mt-2 text-[10px] text-warning">Contains working definition</div>}
    </td>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-[10px] text-muted-foreground">{label}</dt><dd className="mt-1">{children}</dd></div>;
}

function Explanation({ number, title, body }: { number: string; title: string; body: string }) {
  return <div className="grid grid-cols-[28px_1fr] gap-2"><span className="font-mono text-xs text-muted-foreground">{number}</span><div><div className="text-xs font-semibold">{title}</div><div className="mt-1 text-xs text-muted-foreground">{body}</div></div></div>;
}
