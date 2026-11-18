"use client";

import { useEffect, useState } from "react";
import {
  readTaskDefinitionSource,
  readTaskFile,
  type CheckResult,
  type TaskDefinitionRevisionSummary,
  type TaskFileContentResponse,
} from "@/lib/agent-task-api";
import { buildSourceCandidates } from "@/lib/check-source-candidates";

export interface WholeFileSourceState {
  source: TaskFileContentResponse | null;
  /** True while the on-demand fetch is in flight (source still unknown). */
  pending: boolean;
}

/**
 * Source feed for the whole-test-file disclosure. Runs with recorded checks
 * pass the stock {@link useCheckSource} result straight through; the one gap
 * is a run with ZERO recorded checks, where the stock hook skips its fetch
 * entirely. For those, this hook fetches on demand (only while the disclosure
 * is open): the pinned Task Definition when one exists, otherwise the legacy
 * project-source candidates in convention order.
 */
export function useWholeFileSource({
  open,
  checksSource,
  checks,
  taskDefinition,
  taskRunId,
  taskId,
  projectId,
  commitSha,
  sourceType,
}: {
  /** Fetch only while the disclosure is open; a reader who never opens it
   *  costs no request. */
  open: boolean;
  /** The stock hook's result for the same run (already fetched by the page). */
  checksSource: TaskFileContentResponse | null;
  checks: CheckResult[];
  taskDefinition?: TaskDefinitionRevisionSummary | null;
  taskRunId?: string | null;
  taskId: string;
  projectId?: string | null;
  commitSha?: string | null;
  sourceType?: string | null;
}): WholeFileSourceState {
  const definitionPath = taskDefinition?.files[0]?.path ?? null;
  // The stock hook only skips its fetch when zero checks were recorded; with
  // checks present its result (or its failure) is authoritative.
  const needsFetch = open && checksSource === null && checks.length === 0;
  const requestKey = [
    taskId,
    taskRunId ?? "",
    definitionPath ?? "",
    commitSha ?? "",
    projectId ?? "",
    sourceType ?? "",
  ].join("\u0001");
  const [state, setState] = useState<{
    key: string;
    source: TaskFileContentResponse | null;
    settled: boolean;
  }>({ key: "", source: null, settled: false });

  useEffect(() => {
    if (!needsFetch) return;
    // Already holding a settled result (success or failure) for this request.
    if (state.key === requestKey && state.settled) return;
    const controller = new AbortController();
    const load = async (): Promise<TaskFileContentResponse> => {
      if (definitionPath && taskRunId) {
        return readTaskDefinitionSource(taskRunId, definitionPath, controller.signal);
      }
      if (!projectId || sourceType === "published") {
        throw new Error("No source endpoint available for this run");
      }
      // Zero checks recorded means shouldAcceptSource has nothing to verify a
      // candidate against (no recorded source_file, no recognizable check
      // block), so convention order is the only signal: the first candidate
      // that loads is the eval.
      let lastError: unknown;
      for (const candidate of buildSourceCandidates(undefined, taskId)) {
        try {
          return await readTaskFile(
            taskId,
            candidate,
            projectId,
            commitSha ?? undefined,
            controller.signal,
          );
        } catch (error) {
          if (controller.signal.aborted) throw error;
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("Check source not found");
    };
    load()
      .then((source) => {
        if (!controller.signal.aborted) {
          setState({ key: requestKey, source, settled: true });
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ key: requestKey, source: null, settled: true });
        }
      });
    return () => controller.abort();
    // state is read only as a freshness guard; as a dependency it would
    // re-run the fetch after every result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    needsFetch,
    requestKey,
    definitionPath,
    taskRunId,
    taskId,
    projectId,
    commitSha,
    sourceType,
  ]);

  if (checksSource) return { source: checksSource, pending: false };
  if (state.key !== requestKey) return { source: null, pending: needsFetch };
  return { source: state.source, pending: !state.settled };
}
