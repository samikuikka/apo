"use client";

/**
 * URL-backed view state.
 *
 * Lets a component read/write a piece of UI state from the query string so the
 * page can be shared, bookmarked, or restored via back/forward. Mirrors the
 * pattern established by `UrlSelectionContext` (used by the trace workspace):
 * it writes with `router.replace` + `{ scroll: false }` so selection changes
 * don't pollute history or jump the viewport.
 *
 * NOTE: `useSearchParams` requires a <Suspense> boundary above any page that
 * renders these hooks at the top level. The pages that consume them wrap their
 * client tree in <Suspense> already.
 */

import { useCallback } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * Read/write a single-valued query param.
 *
 * @param key      Query-string key.
 * @param fallback Value used when the param is absent/empty.
 */
export function useUrlParam(key: string, fallback = ""): [string, (value: string | null) => void] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const value = searchParams.get(key) ?? fallback;

  const setValue = useCallback(
    (next: string | null) => {
      updateParam(router, pathname, searchParams, key, next);
    },
    [router, pathname, searchParams, key],
  );

  return [value, setValue];
}

/**
 * Read/write a set of values encoded as a comma-separated query param
 * (e.g. `?check=a,b,c`). Useful for "expanded rows" style state where more
 * than one item can be open at once.
 */
export function useUrlParamSet(key: string): [
  Set<string>,
  (value: string, open?: boolean) => void,
] {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const raw = searchParams.get(key) ?? "";
  const values = parseCsvSet(raw);

  const toggle = useCallback(
    (value: string, open?: boolean) => {
      const next = parseCsvSet(raw);
      const shouldOpen = open ?? !next.has(value);
      if (shouldOpen) next.add(value);
      else next.delete(value);
      updateParam(router, pathname, searchParams, key, setToParam(next));
    },
    [router, pathname, searchParams, key, raw],
  );

  return [values, toggle];
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Parse a comma-separated query param into a Set of trimmed, non-empty values. */
function parseCsvSet(raw: string): Set<string> {
  return new Set(
    raw.split(",").flatMap((s) => {
      const t = s.trim();
      return t ? [t] : [];
    }),
  );
}

/** Shared writer: rebuild the query string, preserving other params. */
function updateParam(
  router: ReturnType<typeof useRouter>,
  pathname: string,
  searchParams: ReturnType<typeof useSearchParams>,
  key: string,
  value: string | null,
): void {
  const params = new URLSearchParams(searchParams.toString());
  if (value) {
    params.set(key, value);
  } else {
    params.delete(key);
  }
  const qs = params.toString();
  router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
}

function setToParam(set: Set<string>): string | null {
  const joined = Array.from(set).filter(Boolean).join(",");
  return joined || null;
}
