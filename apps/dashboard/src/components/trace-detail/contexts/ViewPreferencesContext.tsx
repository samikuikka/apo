"use client";

import { createContext, use, useState, useCallback, useMemo, useEffect, ReactNode } from "react";

export interface ViewPreferences {
  showDuration: boolean;
  showCostTokens: boolean;
  showScores: boolean;
  showComments: boolean;
  colorCodeMetrics: boolean;
  minObservationLevel: "DEFAULT" | "DEBUG" | "WARNING" | "ERROR";
}

const STORAGE_KEY = "trace-view-preferences:v1";

const DEFAULT_PREFERENCES: ViewPreferences = {
  showDuration: true,
  showCostTokens: true,
  showScores: false,
  showComments: true,
  colorCodeMetrics: false,
  minObservationLevel: "DEFAULT",
};

function loadPreferences(): ViewPreferences {
  if (typeof window === "undefined") return DEFAULT_PREFERENCES;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_PREFERENCES;
    const parsed = JSON.parse(stored);
    return {
      showDuration: parsed.showDuration ?? DEFAULT_PREFERENCES.showDuration,
      showCostTokens: parsed.showCostTokens ?? DEFAULT_PREFERENCES.showCostTokens,
      showScores: parsed.showScores ?? DEFAULT_PREFERENCES.showScores,
      showComments: parsed.showComments ?? DEFAULT_PREFERENCES.showComments,
      colorCodeMetrics: parsed.colorCodeMetrics ?? DEFAULT_PREFERENCES.colorCodeMetrics,
      minObservationLevel: parsed.minObservationLevel ?? DEFAULT_PREFERENCES.minObservationLevel,
    };
  } catch {
    return DEFAULT_PREFERENCES;
  }
}

function savePreferences(prefs: ViewPreferences): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {}
}

interface ViewPreferencesContextValue {
  preferences: ViewPreferences;
  updatePreference: <K extends keyof ViewPreferences>(key: K, value: ViewPreferences[K]) => void;
}

const ViewPreferencesContext = createContext<ViewPreferencesContextValue | undefined>(undefined);

export { ViewPreferencesContext };

export function ViewPreferencesProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState<ViewPreferences>(loadPreferences);

  useEffect(() => {
    savePreferences(preferences);
  }, [preferences]);

  const updatePreference = useCallback(<K extends keyof ViewPreferences>(key: K, value: ViewPreferences[K]) => {
    setPreferences((prev) => ({ ...prev, [key]: value }));
  }, []);

  const contextValue = useMemo(() => ({ preferences, updatePreference }), [preferences, updatePreference]);

  return (
    <ViewPreferencesContext.Provider value={contextValue}>
      {children}
    </ViewPreferencesContext.Provider>
  );
}

export function useViewPreferences() {
  const context = use(ViewPreferencesContext);
  if (!context) {
    throw new Error("useViewPreferences must be used within ViewPreferencesProvider");
  }
  return context;
}
