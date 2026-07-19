"use client";

import { useReducer, useCallback, useEffect } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  listTaskFiles,
  readTaskFile,
  type TaskFileEntry,
  type TaskFileListResponse,
  type TaskFileContentResponse,
} from "@/lib/agent-task-api";
import { TaskFileList } from "./task-file-list";
import { TaskFileViewer } from "./task-file-viewer";

interface TaskFileBrowserProps {
  taskId: string;
  taskRoot?: string | null;
  projectId?: string | null;
  commitSha?: string | null;
}

type FileBrowserState = {
  files: TaskFileEntry[];
  loading: boolean;
  error: string | null;
  selectedPath: string | null;
  fileContent: TaskFileContentResponse | null;
  viewerError: string | null;
};

type FileBrowserAction =
  | { type: "FETCH_START" }
  | { type: "FETCH_SUCCESS"; files: TaskFileEntry[] }
  | { type: "FETCH_ERROR"; error: string }
  | { type: "SELECT_FILE"; path: string }
  | { type: "VIEWER_SUCCESS"; content: TaskFileContentResponse }
  | { type: "VIEWER_ERROR"; error: string };

function fileBrowserReducer(state: FileBrowserState, action: FileBrowserAction): FileBrowserState {
  switch (action.type) {
    case "FETCH_START":
      return { ...state, loading: true, error: null };
    case "FETCH_SUCCESS":
      return { ...state, files: action.files, loading: false };
    case "FETCH_ERROR":
      return { ...state, error: action.error, loading: false };
    case "SELECT_FILE":
      return { ...state, selectedPath: action.path, fileContent: null, viewerError: null };
    case "VIEWER_SUCCESS":
      return { ...state, fileContent: action.content };
    case "VIEWER_ERROR":
      return { ...state, viewerError: action.error };
  }
}

export function TaskFileBrowser({
  taskId,
  taskRoot,
  projectId,
  commitSha,
}: TaskFileBrowserProps) {
  const [state, dispatch] = useReducer(fileBrowserReducer, {
    files: [],
    loading: true,
    error: null,
    selectedPath: null,
    fileContent: null,
    viewerError: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function fetchFiles() {
      try {
        dispatch({ type: "FETCH_START" });
        const response: TaskFileListResponse = await listTaskFiles(
          taskId,
          taskRoot,
          projectId,
          commitSha,
        );
        if (!cancelled) {
          dispatch({ type: "FETCH_SUCCESS", files: response.files });
        }
      } catch (e: unknown) {
        if (!cancelled) {
          dispatch({ type: "FETCH_ERROR", error: e instanceof Error ? e.message : "Failed to load files" });
        }
      }
    }

    fetchFiles();
    return () => {
      cancelled = true;
    };
  }, [taskId, taskRoot, projectId, commitSha]);

  const handleSelect = useCallback(
    async (path: string) => {
      dispatch({ type: "SELECT_FILE", path });

      try {
        const content = await readTaskFile(
          taskId,
          path,
          taskRoot,
          projectId,
          commitSha,
        );
        dispatch({ type: "VIEWER_SUCCESS", content });
      } catch (e: unknown) {
        dispatch({ type: "VIEWER_ERROR", error: e instanceof Error ? e.message : "Failed to load file" });
      }
    },
    [taskId, taskRoot, projectId, commitSha]
  );

  if (state.error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Error</AlertTitle>
        <AlertDescription>{state.error}</AlertDescription>
      </Alert>
    );
  }

  if (state.loading) {
    return (
      <div className="flex items-center justify-center min-h-[400px] text-sm text-muted-foreground">
        Loading files...
      </div>
    );
  }

  return (
    <div className="flex max-h-[600px] min-h-[400px] rounded-lg border border-border bg-card overflow-hidden">
      <div className="w-[280px] shrink-0 border-r border-border/60 overflow-hidden">
        <TaskFileList files={state.files} selectedPath={state.selectedPath} onSelect={handleSelect} />
      </div>
      <div className="flex-1 overflow-hidden flex flex-col">
        <TaskFileViewer file={state.fileContent} error={state.viewerError} />
      </div>
    </div>
  );
}
