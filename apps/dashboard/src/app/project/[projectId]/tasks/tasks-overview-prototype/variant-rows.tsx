import type { PrototypeTaskOverview } from "./data";
import { HistoryStrip, MetricCell, ScopeBar, TaskIdentity } from "./shared";

export function RowsVariant({ tasks }: { tasks: PrototypeTaskOverview[] }) {
  return (
    <div>
      <div className="px-6 pb-4 pt-5">
        <h2 className="text-[18px] font-semibold tracking-tight">Every Task, All Useful Context</h2>
        <p className="mt-1 text-xs text-muted-foreground">No page modes: baseline, history, and model evidence remain visible together.</p>
      </div>
      <ScopeBar />
      <div className="divide-y divide-border border-b border-border">
        <div className="grid grid-cols-[minmax(220px,1.3fr)_120px_minmax(220px,1fr)_130px_130px] gap-4 px-6 py-2 text-[10px] uppercase tracking-wide text-muted-foreground"><span>Task</span><span>Baseline</span><span>Recent History</span><span>Opus 4</span><span>Sonnet 4</span></div>
        {tasks.map((task) => (
          <div key={task.id} className="grid grid-cols-[minmax(220px,1.3fr)_120px_minmax(220px,1fr)_130px_130px] items-center gap-4 px-6 py-4 hover:bg-card/40">
            <TaskIdentity task={task} />
            <MetricCell metrics={task.baseline} />
            <div><HistoryStrip history={task.history} /><div className="mt-2 text-[10px] text-muted-foreground">Amber divider = definition changed</div></div>
            <MetricCell metrics={task.models.opus} compact />
            <MetricCell metrics={task.models.sonnet} compact />
          </div>
        ))}
      </div>
      <div className="px-6 py-3 text-xs text-muted-foreground">This variant optimizes scanning, but asks every row to explain several concepts at once.</div>
    </div>
  );
}
