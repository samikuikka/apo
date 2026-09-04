import { useCallback, useEffect, useState } from "react";
import { getCallDetail } from "@/lib/traces-api";
import type { LoggedCall } from "./contexts";

/**
 * Resolve the call shown in the detail pane when the trace was fetched slim.
 *
 * Slim trace fetches omit every call's input/output/tool payload (agentic
 * traces would otherwise ship the whole accumulated conversation once per
 * generation). This hook fetches the selected call's full payload once,
 * caches it for the lifetime of the tab, and falls back to the slim call
 * (previews/metadata) while loading or on failure — the pane stays usable,
 * just without the heavy payload.
 */
const fullCallCache = new Map<string, LoggedCall>();

export function useCallPayload(
  runId: string,
  projectId: string | undefined,
  call: LoggedCall,
  slim: boolean,
): { call: LoggedCall; loading: boolean; error: string | null; retry: () => void } {
  const cacheKey = `${projectId ?? ""}:${runId}:${call.id}`;
  const cached = slim ? fullCallCache.get(cacheKey) : undefined;
  // Bumped to re-run the fetch (retry) and to re-render once a fetch lands
  // in the module cache — `cached` alone is not reactive state.
  const [nonce, setNonce] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!slim || fullCallCache.has(cacheKey)) return;
    const controller = new AbortController();
    setError(null);
    getCallDetail(runId, call.id, projectId, controller.signal)
      .then((full) => {
        fullCallCache.set(cacheKey, full);
        setNonce((n) => n + 1);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Failed to load call payload");
      });
    return () => controller.abort();
    // `call.id` is embodied in cacheKey; `cached` is deliberately absent —
    // it becomes defined only when the fetch this effect owns resolves.
  }, [cacheKey, runId, call.id, projectId, slim, nonce]);

  const retry = useCallback(() => {
    setError(null);
    setNonce((n) => n + 1);
  }, []);

  if (!slim || cached) {
    return { call: cached ?? call, loading: false, error: null, retry };
  }
  return { call, loading: !error, error, retry };
}
