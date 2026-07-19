import { type AgentTaskSummary } from "@/lib/agent-task-api";

export type FolderNode = {
  id: string;
  tasks: AgentTaskSummary[];
};

export function groupTasksByFolder(tasks: AgentTaskSummary[]): FolderNode[] {
  const groups: Record<string, AgentTaskSummary[]> = {};
  for (const task of tasks) {
    const folder = task.folder_path || "(root)";
    if (!groups[folder]) groups[folder] = [];
    groups[folder].push(task);
  }
  return Object.entries(groups).map(([name, folderTasks]) => ({
    id: name,
    tasks: folderTasks,
  }));
}
