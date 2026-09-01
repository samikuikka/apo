"use client";

import { useCallback, useEffect, useState } from "react";
import {
  readTaskFile,
  readTaskDefinitionSource,
  type CheckResult,
  type TaskFileContentResponse,
  type TaskDefinitionRevisionSummary,
} from "@/lib/agent-task-api";
import { resolveCheckBlock } from "@/lib/extract-check-block";
import {
  buildSourceCandidates,
  shouldAcceptSource,
} from "@/lib/check-source-candidates";

/**
 * Load the source behind a run's recorded checks: the pinned Task
 * Definition when one exists, otherwise the legacy project-source
 * candidates. Returns the loaded source, or null while unavailable.
 */
export function useCheckSource({
  checks,
  taskDefinition,
  taskRunId,
  taskId,
  projectId,
  commitSha,
  sourceType,
}: {
  checks: CheckResult[];
  taskDefinition?: TaskDefinitionRevisionSummary | null;
  taskRunId?: string | null;
  taskId: string;
  projectId?: string | null;
  commitSha?: string | null;
  sourceType?: string | null;
}): TaskFileContentResponse | null {
  const recordedSourceFile = checks.find((check) => check.source_file)?.source_file;
  const checkIds = checks.map((check) => check.id).join("\u0000");

  // The check-source fetch is fully described by this key (pinned definition
  // path, commit, checks, recorded source, …). Results are tagged with it so
  // the render can hide stale data on the first frame after the request
  // changes, instead of flashing it until an effect resets the state.
  const definitionPath = taskDefinition?.files[0]?.path ?? null;
  const sourceRequestKey = [
    taskId,
    taskRunId ?? null,
    definitionPath,
    checkIds,
    commitSha ?? null,
    projectId ?? null,
    recordedSourceFile ?? null,
    sourceType,
  ].join("\u0001");
  const [sourceState, setSourceState] = useState<{
    key: string;
    data: TaskFileContentResponse | null;
    error: string | null;
  }>({ key: "", data: null, error: null });

  const loadCheckSource = useCallback(
    async (
      candidates: string[],
      signal: AbortSignal,
    ): Promise<TaskFileContentResponse> => {
      if (!projectId) {
        throw new Error("Project context required to load check source");
      }
      let lastError: unknown;
      for (const candidate of candidates) {
        try {
          const source = await readTaskFile(
            taskId,
            candidate,
            projectId,
            commitSha ?? undefined,
            signal,
          );
          const containsKnownCheck = checks.some((check) =>
            resolveCheckBlock(source.content, { id: check.id, anchorFrom: [check] }) !== null
          );
          if (
            shouldAcceptSource({
              candidate,
              recordedSourceFile,
              containsKnownCheck,
              isLastCandidate: candidate === candidates[candidates.length - 1],
            })
          ) {
            return source;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          lastError = error;
        }
      }
      if (lastError instanceof Error) throw lastError;
      throw new Error("Could not load check source — no .eval.ts, task.ts, or checks.ts found");
    },
    [taskId, projectId, commitSha, checks, recordedSourceFile],
  );

  useEffect(() => {
    if (checks.length === 0) return;
    // Already holding a successful result for this exact request.
    if (sourceState.key === sourceRequestKey && sourceState.data !== null) return;
    // When a Task Definition is pinned, load source through the
    // Run-bound endpoint instead of the retired project-source resolver.
    if (taskDefinition && taskRunId && taskDefinition.files[0]) {
      const controller = new AbortController();
      readTaskDefinitionSource(taskRunId, taskDefinition.files[0].path, controller.signal)
        .then((source) => {
          if (!controller.signal.aborted) {
            setSourceState({ key: sourceRequestKey, data: source, error: null });
          }
        })
        .catch((err) => {
          if (!controller.signal.aborted) {
            setSourceState({ key: sourceRequestKey, data: null, error: err instanceof Error ? err.message : "Failed to load definition source" });
          }
        });
      return () => controller.abort();
    }
    // No definition: fall back to the legacy project-source path (or skip
    // for published catalogs where source is metadata-only).
    if (!projectId || sourceType === "published") return;
    const controller = new AbortController();

    void loadCheckSource(
      buildSourceCandidates(recordedSourceFile, taskId),
      controller.signal,
    )
      .then((data: TaskFileContentResponse) => {
        if (controller.signal.aborted) return;
        setSourceState({ key: sourceRequestKey, data, error: null });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setSourceState({
          key: sourceRequestKey,
          data: null,
          error: error instanceof Error
            ? error.message
            : "Check source could not be loaded",
        });
      });

    return () => {
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    checkIds,
    checks.length,
    commitSha,
    projectId,
    recordedSourceFile,
    sourceType,
    taskId,
  ]);

  // Only expose a result while it belongs to the current request key.
  return sourceState.key === sourceRequestKey ? sourceState.data : null;
}
