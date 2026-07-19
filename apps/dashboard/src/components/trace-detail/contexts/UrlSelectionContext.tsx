"use client";

import { createContext, useCallback, useMemo, ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { SelectionContext, type NavigationView } from "./SelectionContext";

interface SelectionContextValue {
  selectedRunId: string | null;
  projectId: string | null;
  selectedCallId: string | null;
  selectRun: (runId: string | null) => void;
  selectCall: (callId: string | null) => void;
  clearSelection: () => void;
  view: NavigationView;
  setView: (v: NavigationView) => void;
  detailTab: string;
  setDetailTab: (t: string) => void;
}

const VALID_VIEWS: NavigationView[] = ["tree", "timeline", "graph", "log"];

function parseView(value: string | null): NavigationView {
  if (value && VALID_VIEWS.includes(value as NavigationView)) {
    return value as NavigationView;
  }
  return "tree";
}

const UrlSelectionContext = createContext<SelectionContextValue | undefined>(
  undefined,
);

export function UrlSelectionProvider({
  children,
  runId,
  projectId = null,
}: {
  children: ReactNode;
  runId: string;
  projectId?: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedCallId = searchParams.get("observation");
  const view = parseView(searchParams.get("view"));
  const detailTab = searchParams.get("tab") ?? "";

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const params = new URLSearchParams(searchParams.toString());
      if (value) {
        params.set(key, value);
      } else {
        params.delete(key);
      }
      const qs = params.toString();
      router.replace(`${pathname}${qs ? `?${qs}` : ""}`, {
        scroll: false,
      });
    },
    [router, pathname, searchParams],
  );

  const selectCall = useCallback(
    (callId: string | null) => {
      updateParam("observation", callId);
    },
    [updateParam],
  );

  const selectRun = useCallback(
    (newRunId: string | null) => {
      if (newRunId === runId) {
        selectCall(null);
      }
    },
    [runId, selectCall],
  );

  const clearSelection = useCallback(() => {
    selectCall(null);
  }, [selectCall]);

  const setView = useCallback(
    (v: NavigationView) => {
      updateParam("view", v);
    },
    [updateParam],
  );

  const setDetailTab = useCallback(
    (t: string) => {
      updateParam("tab", t);
    },
    [updateParam],
  );

  const contextValue = useMemo(
    () => ({
      selectedRunId: runId,
      projectId,
      selectedCallId,
      selectRun,
      selectCall,
      clearSelection,
      view,
      setView,
      detailTab,
      setDetailTab,
    }),
    [runId, projectId, selectedCallId, selectRun, selectCall, clearSelection, view, setView, detailTab, setDetailTab],
  );

  return (
    <UrlSelectionContext.Provider value={contextValue}>
      <SelectionContext.Provider value={contextValue}>
        {children}
      </SelectionContext.Provider>
    </UrlSelectionContext.Provider>
  );
}
