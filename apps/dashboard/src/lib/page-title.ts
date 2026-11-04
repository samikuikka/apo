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

/** The name the trace header shows (trace name, else task id), shortened to
 * the task name when it is the task id, as it is on agent task runs. A short
 * id only when the trace has neither. */
export function traceTitle(run: {
  id: string;
  task_id?: string | null;
  scopeKey: string | null;
}): string {
  const name = run.scopeKey || run.task_id;
  if (!name) return `Trace ${run.id.slice(0, 8)}`;
  return detailTitle(name === run.task_id ? taskName(name) : name, "Trace");
}
