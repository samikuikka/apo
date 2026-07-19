"use client";

import { FileCode, FileJson, FileText, Folder, File } from "lucide-react";
import type { TaskFileEntry } from "@/lib/agent-task-api";

interface TaskFileListProps {
  files: TaskFileEntry[];
  selectedPath: string | null;
  onSelect: (path: string) => void;
}

function getFileIcon(entry: TaskFileEntry) {
  if (entry.type === "directory") return <Folder className="h-4 w-4 text-muted-foreground" />;
  const ext = entry.extension?.toLowerCase();
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx" || ext === ".py") {
    return <FileCode className="h-4 w-4 text-muted-foreground" />;
  }
  if (ext === ".json") return <FileJson className="h-4 w-4 text-muted-foreground" />;
  if (ext === ".md" || ext === ".txt") return <FileText className="h-4 w-4 text-muted-foreground" />;
  return <File className="h-4 w-4 text-muted-foreground" />;
}

function formatFileSize(bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface GroupedFiles {
  directories: { entry: TaskFileEntry; children: TaskFileEntry[] }[];
  rootFiles: TaskFileEntry[];
}

function groupFiles(files: TaskFileEntry[]): GroupedFiles {
  const directories: { entry: TaskFileEntry; children: TaskFileEntry[] }[] = [];
  const rootFiles: TaskFileEntry[] = [];
  const dirMap = new Map<string, TaskFileEntry[]>();

  for (const entry of files) {
    if (entry.type === "directory") {
      dirMap.set(entry.path, []);
    }
  }

  for (const entry of files) {
    if (entry.type === "directory") continue;
    const parentDir = entry.path.includes("/") ? entry.path.split("/").slice(0, -1).join("/") : null;
    if (parentDir && dirMap.has(parentDir)) {
      dirMap.get(parentDir)!.push(entry);
    } else {
      rootFiles.push(entry);
    }
  }

  for (const entry of files) {
    if (entry.type === "directory") {
      directories.push({ entry, children: dirMap.get(entry.path) ?? [] });
    }
  }

  return { directories, rootFiles };
}

export function TaskFileList({ files, selectedPath, onSelect }: TaskFileListProps) {
  const { directories, rootFiles } = groupFiles(files);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/60 bg-muted/30">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Files
        </span>
        <span className="text-[10px] text-muted-foreground">
          {files.filter((f) => f.type === "file").length} files
        </span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {directories.map(({ entry, children }) => (
          <div key={entry.path}>
            <div className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground bg-muted/20">
              <Folder className="h-3.5 w-3.5" />
              <span className="font-medium">{entry.name}/</span>
            </div>
            {children.map((child) => (
              <button
                key={child.path}
                type="button"
                onClick={() => onSelect(child.path)}
                className={`w-full flex items-center gap-2 pl-7 pr-3 py-1.5 text-xs hover:bg-muted/40 transition-colors ${
                  selectedPath === child.path
                    ? "bg-muted/80 border-l-2 border-primary"
                    : "border-l-2 border-transparent"
                }`}
              >
                {getFileIcon(child)}
                <span className="truncate font-mono">{child.name}</span>
                <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
                  {formatFileSize(child.size_bytes)}
                </span>
              </button>
            ))}
          </div>
        ))}
        {rootFiles.map((entry) => (
          <button
            key={entry.path}
            type="button"
            onClick={() => onSelect(entry.path)}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs hover:bg-muted/40 transition-colors ${
              selectedPath === entry.path
                ? "bg-muted/80 border-l-2 border-primary"
                : "border-l-2 border-transparent"
            }`}
          >
            {getFileIcon(entry)}
            <span className="truncate font-mono">{entry.name}</span>
            <span className="ml-auto text-[10px] text-muted-foreground shrink-0">
              {formatFileSize(entry.size_bytes)}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
