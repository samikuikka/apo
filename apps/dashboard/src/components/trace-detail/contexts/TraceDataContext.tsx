"use client";

/**
 * TraceDataContext - Manages trace data for the shared trace detail surface.
 *
 * The run-named exports remain as compatibility aliases while the dashboard
 * shifts toward a trace-first public API.
 */

import { createContext, use, useMemo, useCallback, useRef, useState, ReactNode } from "react";
import { computeCumulativeMetrics, type CumulativeMetrics } from "@/lib/cumulative-metrics";

export interface TraceMetric {
  metric_name: string;
  metric_type: "quality" | "aggregate";
  score: number;
  reasoning?: string;
  meta?: Record<string, unknown>;
  created_at: string;
}

export interface Trace {
  id: string;
  project: string;
  task_id?: string;
  scopeKey: string | null;
  version?: string;
  user_id?: string;
  session_id?: string | null;
  environment?: string;
  created_at: string;
  completed_at?: string;
  duration_ms?: number;
  call_count: number;
  bookmarked?: boolean;
  is_public?: boolean;
  task_run_id?: string | null;
}

export interface LoggedCall {
  id: string;
  step_index: number | null;
  step_name: string | null;
  model: string;
  created_at: string;
  latency_ms?: number | null;
  cost?: number | null;
  input: any;
  output: any;
  task_id: string | null;
  parent_call_id?: string | null;
  call_type?: string;
  level?: string;

  // Token counts
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;

  // Session and context
  session_id?: string | null;
  environment?: string;
  version?: string | null;
  tags?: string[];

  // Langfuse-inspired enhancements
  completion_start_time?: string | null;
  end_time?: string | null;
  observation_type?: string;
  status_message?: string | null;
  time_to_first_token_ms?: number | null;
  metadata?: Record<string, unknown> | null;

  // Prompt management
  prompt_id?: string | null;
  prompt_version?: number | null;

  // Cost breakdown
  provided_cost?: number | null;
  calculated_cost?: number | null;

  // Model tracking
  provided_model_name?: string | null;
  internal_model_id?: string | null;

  // Tool details (for TOOL observation type)
  tool_name?: string | null;
  tool_parameters?: Record<string, unknown> | null;
  tool_result?: Record<string, unknown> | null;

  // Corrected output for diff view
  corrected_output?: string | null;
}

export type TraceObservation = LoggedCall;

export interface TraceDetail {
  run: Trace;
  metrics: TraceMetric[];
  calls: LoggedCall[];
}

export const LARGE_TRACE_THRESHOLD = 100;
export const GRAPH_DISABLED_THRESHOLD = 500;
export const SIMPLIFIED_TREE_THRESHOLD = 1000;

interface TraceDataContextValue {
  run: TraceDetail | null;
  isLoading: boolean;
  error: string | null;
  refreshRun?: () => void;
  cumulativeMetrics: Map<string, CumulativeMetrics>;
  prefetchedCalls: Set<string>;
  prefetchObservation: (callId: string) => void;
  isPrefetched: (callId: string) => boolean;
  callCount: number;
  isLargeTrace: boolean;
  isGraphDisabled: boolean;
  isSimplifiedTree: boolean;
}

export const TraceDataContext = createContext<TraceDataContextValue | undefined>(undefined);

export function TraceDataProvider({
  children,
  run,
  isLoading,
  error,
  refreshRun,
}: {
  children: ReactNode;
  run: TraceDetail | null;
  isLoading: boolean;
  error: string | null;
  refreshRun?: () => void;
}) {
  const [prefetchedCalls, setPrefetchedCalls] = useState<Set<string>>(new Set());
  const callMapRef = useRef<Map<string, LoggedCall>>(new Map());

  const cumulativeMetrics = useMemo(
    () => (run ? computeCumulativeMetrics(run.calls) : new Map<string, CumulativeMetrics>()),
    [run],
  );

  const callCount = run?.calls.length ?? 0;
  const isLargeTrace = callCount > LARGE_TRACE_THRESHOLD;
  const isGraphDisabled = callCount > GRAPH_DISABLED_THRESHOLD;
  const isSimplifiedTree = callCount > SIMPLIFIED_TREE_THRESHOLD;

  useMemo(() => {
    if (!run) {
      // Rebuilding the call lookup map as a memo side-channel when run changes.
      // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
      callMapRef.current = new Map();
      return;
    }
    const map = new Map<string, LoggedCall>();
    for (const call of run.calls) {
      map.set(call.id, call);
    }
    // See above — derived map cache rebuilt only when run changes.
    // react-doctor-disable-next-line react-doctor/no-ref-current-in-render
    callMapRef.current = map;
  }, [run]);

  const prefetchObservation = useCallback((callId: string) => {
    setPrefetchedCalls((prev) => {
      if (prev.has(callId)) return prev;
      const next = new Set(prev);
      next.add(callId);
      return next;
    });
  }, []);

  const isPrefetched = useCallback((callId: string) => {
    return prefetchedCalls.has(callId);
  }, [prefetchedCalls]);

  const contextValue = useMemo(() => ({
    run,
    isLoading,
    error,
    refreshRun,
    cumulativeMetrics,
    prefetchedCalls,
    prefetchObservation,
    isPrefetched,
    callCount,
    isLargeTrace,
    isGraphDisabled,
    isSimplifiedTree,
  }), [run, isLoading, error, refreshRun, cumulativeMetrics, prefetchedCalls, prefetchObservation, isPrefetched, callCount, isLargeTrace, isGraphDisabled, isSimplifiedTree]);

  return (
    <TraceDataContext.Provider value={contextValue}>
      {children}
    </TraceDataContext.Provider>
  );
}

export function useTraceData(): TraceDataContextValue {
  const context = use(TraceDataContext);
  if (!context) {
    throw new Error("useTraceData must be used within TraceDataProvider");
  }
  return context;
}
