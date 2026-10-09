"use client";

import { useEffect, useState } from "react";

export interface UsePersistentStringSetResult {
  /** Stored ids. Starts empty and hydrates on mount, so SSR and the first client render agree. */
  values: Set<string>;
  /** Toggle one id's membership and persist the result. */
  toggle: (key: string) => void;
}

/**
 * A Set of string ids persisted to localStorage under `storageKey`.
 *
 * Follows the `usePersistentTablePreferences` pattern: localStorage is
 * browser-only, so the set starts empty and hydrates in a mount effect —
 * the server render and first client render agree on the empty default,
 * and stored values appear right after hydration. A `null` storageKey
 * disables persistence; the set then lives in memory for the session only.
 */
export function usePersistentStringSet(
  storageKey: string | null,
): UsePersistentStringSetResult {
  // `hydrated` gates the save effect so the empty pre-hydration set can
  // never clobber the stored value (both effects run on the same mount
  // pass; only the hydration one sets state). `loadedKey` extends that
  // gate to key changes: when storageKey changes on a live component, the
  // save effect would otherwise run once with the previous task's values
  // under the new key, before the hydration state lands.
  const [state, setState] = useState<{
    hydrated: boolean;
    loadedKey: string | null;
    values: Set<string>;
  }>(() => ({ hydrated: false, loadedKey: null, values: new Set<string>() }));

  useEffect(() => {
    if (!storageKey) return;
    setState({ hydrated: true, loadedKey: storageKey, values: loadSet(storageKey) });
  }, [storageKey]);

  useEffect(() => {
    if (!storageKey || !state.hydrated || state.loadedKey !== storageKey) return;
    if (state.values.size === 0) {
      // Nothing to remember — drop the key rather than storing an empty
      // array, so merely visiting a page never leaves an orphan behind.
      try {
        localStorage.removeItem(storageKey);
      } catch {}
      return;
    }
    saveSet(storageKey, state.values);
  }, [state, storageKey]);

  const toggle = (key: string) => {
    setState((prev) => {
      const next = new Set(prev.values);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, values: next };
    });
  };

  return { values: state.values, toggle };
}

// ── localStorage helpers ─────────────────────────────────────────────────

function loadSet(storageKey: string): Set<string> {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return new Set<string>();
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
    return new Set(
      parsed.filter((v): v is string => typeof v === "string" && v.length > 0),
    );
  } catch {
    // Corrupt payload — drop the key and fall back to the default.
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    return new Set<string>();
  }
}

function saveSet(storageKey: string, values: Set<string>): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...values]));
  } catch {
    // Quota exceeded / private mode — the set stays in-memory for this session.
  }
}
