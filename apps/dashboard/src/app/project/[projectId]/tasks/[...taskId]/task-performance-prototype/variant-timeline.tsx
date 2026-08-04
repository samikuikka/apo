import type { PrototypeRun } from "./data";
import { DefinitionBadge, formatModel, StatusMark } from "./shared";

export function TimelineVariant({ runs }: { runs: PrototypeRun[] }) {
  const groups = groupByDefinition(runs);

  return (
    <div className="grid min-h-[680px] lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="border-r border-border px-5 py-6">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Definition History</div>
        <div className="mt-5 space-y-1">
          {groups.map(([definition, groupRuns], index) => (
            <div key={definition} className={`border-l-2 px-3 py-3 ${index === 0 ? "border-foreground bg-card" : "border-border"}`}>
              <div className="flex items-center justify-between text-xs font-semibold">
                <span>{definition === "working" ? "Working" : `Definition ${definition}`}</span>
                <span className="font-mono text-[10px] text-muted-foreground">{groupRuns.length}</span>
              </div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">{groupRuns[0]?.definitionDigest}</div>
              <div className="mt-2 text-[10px] text-muted-foreground">
                {definition === "v4" ? "Published baseline" : definition === "working" ? "Not published" : "Superseded"}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <div className="px-6 py-6">
        <div className="flex items-end justify-between border-b border-border pb-5">
          <div>
            <div className="text-xs text-muted-foreground">Chronological Evidence</div>
            <h2 className="mt-1 text-[18px] font-semibold tracking-tight">See every boundary</h2>
          </div>
          <div className="text-right text-xs text-muted-foreground">
            <div>{runs.length} attempts</div>
            <div className="mt-1">Definition → execution → configuration</div>
          </div>
        </div>

        <div className="mt-6 space-y-8">
          {groups.map(([definition, groupRuns]) => (
            <section key={definition}>
              <div className="mb-3 flex items-center gap-3">
                <DefinitionBadge run={groupRuns[0]} />
                <span className="h-px flex-1 bg-border" />
                <span className="text-[10px] text-muted-foreground">{groupRuns.length} attempts</span>
              </div>
              <div className="space-y-5">
                {groupByExecution(groupRuns).map(([execution, executionRuns]) => (
                  <div key={execution} className="grid grid-cols-[120px_1fr] gap-4">
                    <div>
                      <div className="font-mono text-xs text-foreground">{execution}</div>
                      <div className="mt-1 text-[10px] text-muted-foreground">Execution Revision</div>
                    </div>
                    <div className="space-y-2 border-l border-border pl-4">
                      {groupByConfiguration(executionRuns).map(([configuration, configurationRuns]) => (
                        <div key={configuration} className="grid grid-cols-[150px_1fr_auto] items-center gap-3 border border-border bg-card/40 px-3 py-2.5">
                          <div>
                            <div className="text-xs font-semibold">{formatModel(configurationRuns[0].model)}</div>
                            <div className="text-[10px] text-muted-foreground">{configurationRuns[0].effort} effort</div>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {configurationRuns.map((run) => <StatusMark key={run.id} status={run.status} size="sm" />)}
                          </div>
                          <div className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">
                            {configurationRuns.map((run) => `${run.checksPassed}/${run.checksTotal || "—"}`).join(" · ")}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

function groupByDefinition(runs: PrototypeRun[]) {
  const order: PrototypeRun["definition"][] = ["working", "v4", "v3"];
  const groups: Array<readonly [PrototypeRun["definition"], PrototypeRun[]]> = [];
  for (const definition of order) {
    const matchingRuns = runs.filter((run) => run.definition === definition);
    if (matchingRuns.length > 0) groups.push([definition, matchingRuns]);
  }
  return groups;
}

function groupByExecution(runs: PrototypeRun[]) {
  return Map.groupBy(runs, (run) => run.execution).entries().toArray();
}

function groupByConfiguration(runs: PrototypeRun[]) {
  return Map.groupBy(runs, (run) => `${run.model}:${run.effort}`).entries().toArray();
}
