/**
 * Browser-tab titles for detail pages: the thing's name first, then what kind
 * of page it is ("nda-redline · Trace"). A narrow tab truncates from the end,
 * so the part that tells tabs apart has to lead; an id slice tells nobody
 * anything.
 */

/** A task's name as the catalog publishes it: the last segment of its
 * hierarchical id ("folder/nda-redline" → "nda-redline"). */
export function taskName(taskId: string): string {
  return taskId.split("/").pop() || taskId;
}

export function detailTitle(name: string | null | undefined, kind: string): string {
  const trimmed = name?.trim();
  return trimmed ? `${trimmed} · ${kind}` : kind;
}

/** Agent task traces are named `agent-task.<task id>` by the SDK unless the
 * runner gives a flow name, so the task name stands in for the default. Any
 * other trace keeps the name its header shows, and a short id is the last
 * resort. */
export function traceTitle(run: {
  id: string;
  task_id?: string | null;
  scopeKey: string | null;
}): string {
  const { task_id: taskId, scopeKey } = run;
  if (taskId && (!scopeKey || scopeKey === taskId || scopeKey === `agent-task.${taskId}`)) {
    return detailTitle(taskName(taskId), "Trace");
  }
  if (scopeKey) return detailTitle(scopeKey, "Trace");
  return `Trace ${run.id.slice(0, 8)}`;
}
