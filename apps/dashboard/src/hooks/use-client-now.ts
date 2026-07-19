"use client";

import { useSyncExternalStore } from "react";

/**
 * Returns `Date.now()` on the client and `null` during SSR, refreshing on an
 * interval. Uses `useSyncExternalStore` so the server snapshot (`null`) and the
 * client snapshot (current timestamp) are deterministic — no hydration mismatch,
 * no `useEffect` state adjustment.
 *
 * The client snapshot is cached at module level and only mutated inside the
 * interval callback. `getSnapshot` must return a value that is stable between
 * notifications — returning a fresh `Date.now()` every call would make React
 * detect a "change" on every render and loop forever ("Maximum update depth
 * exceeded").
 */
let cachedNow: number | null = null;

function getNowSnapshot(): number | null {
  if (cachedNow === null) cachedNow = Date.now();
  return cachedNow;
}

export function useClientNow(intervalMs = 30_000): number | null {
  return useSyncExternalStore(
    (onChange) => {
      if (cachedNow === null) cachedNow = Date.now();
      const id = setInterval(() => {
        cachedNow = Date.now();
        onChange();
      }, intervalMs);
      return () => clearInterval(id);
    },
    getNowSnapshot, // client snapshot
    () => null, // server snapshot
  );
}

/**
 * Returns the browser's current date broken into `{ year, month, day }` on the
 * client, and `null` during SSR. No hydration mismatch because the server
 * snapshot is deterministic. The object is cached so `getSnapshot` returns a
 * stable reference (read once on mount).
 */
let cachedDate: { year: number; month: number; day: number } | null = null;

function getDateSnapshot(): { year: number; month: number; day: number } | null {
  if (cachedDate === null) {
    const d = new Date();
    cachedDate = { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
  }
  return cachedDate;
}

export function useClientDate(): { year: number; month: number; day: number } | null {
  return useSyncExternalStore(
    () => () => {}, // no subscription — the date is read once on mount
    getDateSnapshot,
    () => null,
  );
}

/**
 * Returns the browser's timezone (e.g. `"America/New_York"`) on the client, and
 * `null` during SSR. Deferred because `Intl.DateTimeFormat().resolvedOptions()`
 * gives different values on server vs. client. Cached so the work runs once.
 */
let cachedTimezone: string | null | undefined = undefined;

function getTimezoneSnapshot(): string | null {
  if (cachedTimezone === undefined) {
    try {
      cachedTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
    } catch {
      cachedTimezone = null;
    }
  }
  return cachedTimezone;
}

export function useBrowserTimezone(): string | null {
  return useSyncExternalStore(
    () => () => {},
    getTimezoneSnapshot,
    () => null,
  );
}

/**
 * Returns `Intl.supportedValuesOf("timeZone")` on the client and `["UTC"]`
 * during SSR. The array is cached so `getSnapshot` returns a stable reference.
 */
let cachedTimezones: string[] | null = null;

function getSupportedTimezonesSnapshot(): string[] {
  if (cachedTimezones === null) {
    try {
      if (typeof Intl !== "undefined" && "supportedValuesOf" in Intl) {
        cachedTimezones = (Intl as unknown as { supportedValuesOf: (key: string) => string[] }).supportedValuesOf("timeZone");
      }
    } catch {
      // keep default
    }
    if (cachedTimezones === null) cachedTimezones = ["UTC"];
  }
  return cachedTimezones;
}

export function useSupportedTimezones(): string[] {
  return useSyncExternalStore(
    () => () => {},
    getSupportedTimezonesSnapshot,
    () => ["UTC"],
  );
}
