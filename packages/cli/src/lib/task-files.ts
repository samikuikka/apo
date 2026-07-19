import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import {
  findTaskMetaById,
  type TaskMeta,
} from "./task-meta.ts";
import type {
  TaskFileContentResponse,
  TaskFileEntry,
  TaskFileListResponse,
} from "./agent-task-types.ts";
import { lstatSync } from "fs";

const MAX_FILE_SIZE = 1_000_000;

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".py": "python",
  ".md": "markdown",
  ".json": "json",
  ".diff": "diff",
  ".patch": "diff",
  ".txt": "text",
  ".css": "css",
  ".html": "html",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".sh": "bash",
  ".sql": "sql",
};

export function listLocalTaskFiles(
  taskRoot: string,
  taskId: string,
): TaskFileListResponse {
  const task = requireTaskMeta(taskRoot, taskId);
  const entries = walkTaskFiles(task.path);
  return {
    task_id: task.id,
    task_path: task.path,
    files: entries,
  };
}

export function readLocalTaskFile(
  taskRoot: string,
  taskId: string,
  filePath: string,
): TaskFileContentResponse {
  const task = requireTaskMeta(taskRoot, taskId);
  const absolutePath = join(task.path, filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const stat = statSync(absolutePath);
  if (stat.isDirectory()) {
    throw new Error("Path is a directory, not a file");
  }
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error("File too large to display");
  }

  const content = readFileSync(absolutePath, "utf-8");
  const language = detectLanguage(filePath);
  const lines =
    content.length === 0
      ? 0
      : content.split("\n").length;

  return {
    name: filePath.split("/").at(-1) ?? filePath,
    path: filePath,
    content,
    size_bytes: stat.size,
    language,
    lines,
  };
}

function requireTaskMeta(taskRoot: string, taskId: string): TaskMeta {
  const task = findTaskMetaById(taskRoot, taskId);
  if (!task) {
    throw new Error(`Task not found: ${taskId}`);
  }
  return task;
}

function walkTaskFiles(taskPath: string): TaskFileEntry[] {
  const entries: TaskFileEntry[] = [];
  walkDirectory(taskPath, taskPath, entries);

  const directories = entries
    .filter((entry) => entry.type === "directory")
    .sort((left, right) => left.path.localeCompare(right.path));
  const files = entries
    .filter((entry) => entry.type === "file")
    .sort((left, right) => left.path.localeCompare(right.path));

  return [...directories, ...files];
}

function walkDirectory(
  rootPath: string,
  currentPath: string,
  entries: TaskFileEntry[],
): void {
  for (const name of readdirSync(currentPath).sort()) {
    if (name.startsWith(".")) {
      continue;
    }

    const absolutePath = join(currentPath, name);
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(absolutePath);
    } catch {
      continue;
    }

    if (stat.isSymbolicLink()) {
      continue;
    }

    const relativePath = normalizeRelativePath(relative(rootPath, absolutePath));

    if (stat.isDirectory()) {
      entries.push({
        name,
        path: relativePath,
        type: "directory",
        size_bytes: null,
        extension: null,
      });
      walkDirectory(rootPath, absolutePath, entries);
      continue;
    }

    entries.push({
      name,
      path: relativePath,
      type: "file",
      size_bytes: stat.size,
      extension: getExtension(relativePath),
    });
  }
}

function detectLanguage(filePath: string): string {
  const extension = getExtension(filePath);
  if (!extension) {
    return "text";
  }
  return EXTENSION_LANGUAGE_MAP[extension.toLowerCase()] ?? "text";
}

function getExtension(filePath: string): string | null {
  const name = filePath.split("/").at(-1) ?? filePath;
  const dotIndex = name.lastIndexOf(".");
  if (dotIndex <= 0) {
    return null;
  }
  return name.slice(dotIndex);
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.split("\\").join("/");
}
