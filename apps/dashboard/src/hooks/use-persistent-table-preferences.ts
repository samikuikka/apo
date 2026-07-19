"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface PersistentTablePreferences {
  columnVisibility?: Record<string, boolean>;
  columnSizing?: Record<string, number>;
  columnPinning?: {
    left?: string[];
    right?: string[];
  };
  columnOrder?: string[];
}

export interface UsePersistentTablePreferencesOptions {
  storageKey: string;
  defaults: PersistentTablePreferences;
}

export interface UsePersistentTablePreferencesResult {
  preferences: PersistentTablePreferences;
  setColumnVisibility: React.Dispatch<
    React.SetStateAction<Record<string, boolean>>
  >;
  setColumnSizing: React.Dispatch<
    React.SetStateAction<Record<string, number>>
  >;
  setColumnPinning: React.Dispatch<
    React.SetStateAction<{ left?: string[]; right?: string[] }>
  >;
  setColumnOrder: React.Dispatch<React.SetStateAction<string[]>>;
  resetPreferences: () => void;
}

// Module-level cache so getSnapshot returns a referentially-stable value
// between storage events (required by React's useSyncExternalStore).
const storageCache = new Map<string, PersistentTablePreferences | null>();
const storageListeners = new Set<(key: string) => void>();

function readStorage(key: string): PersistentTablePreferences | null {
  if (storageCache.has(key)) return storageCache.get(key)!;
  const result = loadPreferences(key);
  storageCache.set(key, result);
  return result;
}

function notifyStorageChange(key: string) {
  storageCache.delete(key);
  for (const listener of storageListeners) listener(key);
}

/**
 * Unifies column visibility, sizing, and pinning persistence for a dashboard
 * table behind a single localStorage key.
 *
 * Reads from localStorage via a module-level cache that's invalidated on
 * `storage` events (cross-tab sync). The server renders with defaults (no
 * localStorage access), then the client hydrates with stored values on mount.
 */
export function usePersistentTablePreferences(
  options: UsePersistentTablePreferencesOptions,
): UsePersistentTablePreferencesResult {
  const { storageKey, defaults } = options;
  const defaultsRef = useRef(defaults);
  // Written via useEffect (not in the render body) so render stays pure.
  useEffect(() => {
    defaultsRef.current = defaults;
  });

  // Hydrate from localStorage on mount (SSR-safe — localStorage is browser-only).
  const [hydrated, setHydrated] = useState(false);
  const [stored, setStored] = useState<PersistentTablePreferences | null>(null);

  useEffect(() => {
    // localStorage is browser-only — must defer to mount for SSR safety
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setStored(readStorage(storageKey));
    // react-doctor-disable-next-line react-doctor/no-adjust-state-on-prop-change
    setHydrated(true);
    const listener = (key: string) => {
      if (key === storageKey) setStored(readStorage(storageKey));
    };
    storageListeners.add(listener);
    const storageHandler = (e: StorageEvent) => {
      if (e.key === storageKey) notifyStorageChange(storageKey);
    };
    window.addEventListener("storage", storageHandler);
    return () => {
      storageListeners.delete(listener);
      window.removeEventListener("storage", storageHandler);
    };
  }, [storageKey]);

  // Local overrides applied on top of the stored snapshot.
  const [overrides, setOverrides] = useState<PersistentTablePreferences>({});

  const preferences = useMemo(
    () => ({ ...defaultsRef.current, ...stored, ...overrides }),
    [stored, overrides],
  );

  // Debounced persistence — only runs when overrides change after hydration.
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    if (!hydrated || Object.keys(overrides).length === 0) return;
    clearTimeout(saveTimeoutRef.current);
    saveTimeoutRef.current = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(preferences));
        storageCache.set(storageKey, { ...preferences });
      } catch {}
    }, 300);
    return () => clearTimeout(saveTimeoutRef.current);
  }, [overrides, preferences, storageKey, hydrated]);

  const setColumnVisibility = useCallback(
    (updater: React.SetStateAction<Record<string, boolean>>) => {
      setOverrides((prev) => ({
        ...prev,
        columnVisibility:
          typeof updater === "function"
            ? updater(preferences.columnVisibility ?? {})
            : updater,
      }));
    },
    [preferences.columnVisibility],
  );

  const setColumnSizing = useCallback(
    (updater: React.SetStateAction<Record<string, number>>) => {
      setOverrides((prev) => ({
        ...prev,
        columnSizing:
          typeof updater === "function"
            ? updater(preferences.columnSizing ?? {})
            : updater,
      }));
    },
    [preferences.columnSizing],
  );

  const setColumnPinning = useCallback(
    (updater: React.SetStateAction<{ left?: string[]; right?: string[] }>) => {
      setOverrides((prev) => ({
        ...prev,
        columnPinning:
          typeof updater === "function"
            ? updater(preferences.columnPinning ?? {})
            : updater,
      }));
    },
    [preferences.columnPinning],
  );

  const setColumnOrder = useCallback(
    (updater: React.SetStateAction<string[]>) => {
      setOverrides((prev) => ({
        ...prev,
        columnOrder:
          typeof updater === "function"
            ? updater(preferences.columnOrder ?? [])
            : updater,
      }));
    },
    [preferences.columnOrder],
  );

  const resetPreferences = useCallback(() => {
    try {
      localStorage.removeItem(storageKey);
    } catch {}
    storageCache.delete(storageKey);
    setOverrides({});
  }, [storageKey]);

  return {
    preferences,
    setColumnVisibility,
    setColumnSizing,
    setColumnPinning,
    setColumnOrder,
    resetPreferences,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sanitizeVisibility(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeSizing(value: unknown): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

function sanitizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    return undefined;
  }
  return value;
}

function sanitizePinning(
  value: unknown,
): { left?: string[]; right?: string[] } | undefined {
  if (!isRecord(value)) return undefined;
  const left = sanitizeStringArray(value.left);
  const right = sanitizeStringArray(value.right);
  if (!left && !right) return undefined;
  const out: { left?: string[]; right?: string[] } = {};
  if (left) out.left = left;
  if (right) out.right = right;
  return out;
}

function sanitizePreferences(
  value: unknown,
): PersistentTablePreferences | null {
  if (!isRecord(value)) return null;
  const columnVisibility = sanitizeVisibility(value.columnVisibility);
  const columnSizing = sanitizeSizing(value.columnSizing);
  const columnPinning = sanitizePinning(value.columnPinning);
  const columnOrder = sanitizeStringArray(value.columnOrder);
  if (!columnVisibility && !columnSizing && !columnPinning && !columnOrder) {
    return null;
  }
  const out: PersistentTablePreferences = {};
  if (columnVisibility) out.columnVisibility = columnVisibility;
  if (columnSizing) out.columnSizing = columnSizing;
  if (columnPinning) out.columnPinning = columnPinning;
  if (columnOrder) out.columnOrder = columnOrder;
  return out;
}

function loadPreferences(
  storageKey: string,
): PersistentTablePreferences | null {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const sanitized = sanitizePreferences(JSON.parse(raw));
    if (sanitized) return sanitized;
    localStorage.removeItem(storageKey);
  } catch {
    try {
      localStorage.removeItem(storageKey);
    } catch {}
  }
  return null;
}
