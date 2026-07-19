"use client";

/**
 * SelectionContext - Manages selected run/call state for trace detail panel
 *
 * Based on Langfuse's SelectionContext pattern.
 * Tracks which run and call are currently selected for viewing in the detail panel.
 * Also tracks active navigation view and detail tab so they can be URL-synced.
 */

import { createContext, use, useState, useCallback, useMemo, ReactNode } from "react";

export type NavigationView = "tree" | "timeline" | "graph" | "log";

interface SelectionContextValue {
  // Selected run ID (opens detail panel)
  selectedRunId: string | null;
  // Project the selection belongs to. Forwarded to detail/adjacent fetches so
  // the backend scopes the lookup to the right project instead of "default".
  projectId: string | null;
  // Selected call ID (shows call details within detail panel)
  selectedCallId: string | null;
  // Actions
  selectRun: (runId: string | null) => void;
  selectCall: (callId: string | null) => void;
  clearSelection: () => void;
  // Navigation view (tree/timeline/graph/log)
  view: NavigationView;
  setView: (v: NavigationView) => void;
  // Detail panel tab
  detailTab: string;
  setDetailTab: (t: string) => void;
}

const SelectionContext = createContext<SelectionContextValue | undefined>(undefined);
export { SelectionContext };

export function SelectionProvider({
  children,
  projectId = null,
}: {
  children: ReactNode;
  projectId?: string | null;
}) {
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<string | null>(null);
  const [view, setView] = useState<NavigationView>("tree");
  const [detailTab, setDetailTab] = useState("");

  const selectRun = useCallback((runId: string | null) => {
    setSelectedRunId(runId);
    // Clear call selection when switching runs
    setSelectedCallId(null);
  }, []);

  const selectCall = useCallback((callId: string | null) => {
    setSelectedCallId(callId);
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedRunId(null);
    setSelectedCallId(null);
  }, []);

  const contextValue = useMemo(() => ({
    selectedRunId,
    projectId,
    selectedCallId,
    selectRun,
    selectCall,
    clearSelection,
    view,
    setView,
    detailTab,
    setDetailTab,
  }), [selectedRunId, projectId, selectedCallId, selectRun, selectCall, clearSelection, view, detailTab]);

  return (
    <SelectionContext.Provider value={contextValue}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useSelection() {
  const context = use(SelectionContext);
  if (!context) {
    throw new Error("useSelection must be used within SelectionProvider");
  }
  return context;
}
