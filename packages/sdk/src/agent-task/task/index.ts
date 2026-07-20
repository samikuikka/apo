export type {
  TaskDefinition,
  TaskConfig,
  TaskExecutionPreference,
  FileEntry,
} from "./types.ts";

export { defineTask, task, resetTaskRegistry } from "./defineTask.ts";
export { loadTask, type LoadedTask } from "./loadTask.ts";
export { TaskFiles } from "./TaskFiles.ts";
