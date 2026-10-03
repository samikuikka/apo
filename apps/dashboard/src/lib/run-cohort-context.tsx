"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import {
  EMPTY_RUN_COHORT,
  type RunCohort,
} from "@/lib/run-cohort";

interface RunCohortStore {
  cohort: RunCohort;
  setCohort: (cohort: RunCohort) => void;
  /** The saved view the cohort came from, or null for Main / hand-set filters. */
  viewId: string | null;
  setViewId: (viewId: string | null) => void;
}

const RunCohortContext = createContext<RunCohortStore | null>(null);

/** Lets a page publish its cohort to navigation rendered by the same shell. */
export function RunCohortProvider({ children }: { children: ReactNode }) {
  const [cohort, setCohortState] = useState<RunCohort>(EMPTY_RUN_COHORT);
  const [viewId, setViewIdState] = useState<string | null>(null);
  const setCohort = useCallback((next: RunCohort) => {
    setCohortState((previous) =>
      previous.model === next.model &&
      previous.effort === next.effort &&
      previous.since === next.since
        ? previous
        : next,
    );
  }, []);
  const setViewId = useCallback((next: string | null) => {
    setViewIdState((previous) => (previous === next ? previous : next));
  }, []);
  const value = useMemo(
    () => ({ cohort, setCohort, viewId, setViewId }),
    [cohort, setCohort, viewId, setViewId],
  );
  return (
    <RunCohortContext.Provider value={value}>
      {children}
    </RunCohortContext.Provider>
  );
}

/** The cohort published by the current page, or an empty one outside a shell. */
export function useRunCohort(): RunCohort {
  return useContext(RunCohortContext)?.cohort ?? EMPTY_RUN_COHORT;
}

/** The saved-view identity published alongside the cohort, if any. */
export function useRunCohortViewId(): string | null {
  return useContext(RunCohortContext)?.viewId ?? null;
}

/** Publish a cohort (and its originating view) while the page is mounted. */
export function usePublishRunCohort(cohort: RunCohort, viewId: string | null = null): void {
  // Depend on the stable setters, not the store object: the store's identity
  // changes whenever the cohort state does, and re-running this effect would
  // set that state again — an infinite publish/republish render loop.
  const { setCohort, setViewId } = useContext(RunCohortContext) ?? {};
  const { model, effort, since, provider } = cohort;
  useEffect(() => {
    if (!setCohort || !setViewId) return;
    setCohort({ model, effort, since, provider });
    setViewId(viewId);
    return () => {
      setCohort(EMPTY_RUN_COHORT);
      setViewId(null);
    };
  }, [model, effort, since, provider, viewId, setCohort, setViewId]);
}
