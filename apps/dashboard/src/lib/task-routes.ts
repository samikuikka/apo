/**
 * Build the dashboard route to a task's detail page.
 *
 * Agent task IDs are hierarchical paths (e.g. "openai-agent/data-extraction")
 * so two folders can each define a task of the same name without colliding
 * (see backend `agent_task_discovery._parse_task_file`). The detail route is a
 * catch-all (`tasks/[...taskId]`), so each slash-separated segment of the id
 * must become its own path segment: we split on "/" then encode each segment
 * individually (a segment may legitimately contain spaces or other reserved
 * chars). Encoding the whole id at once would turn the slashes into %2F and
 * collapse it into a single segment, breaking navigation from the task list.
 */
export function taskDetailHref(projectId: string, taskId: string): string {
  const encodedTaskId = taskId
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/project/${projectId}/tasks/${encodedTaskId}`;
}
