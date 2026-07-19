"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface UseTableSelectionProps {
  projectId: string;
  tableName: string;
}

/**
 * Hook for managing "select all" state in table selections
 *
 * Features:
 * - Persists "select all" state in sessionStorage
 * - Auto-clears selection on route changes
 * - Project and table-specific storage keys
 *
 * @example
 * const { selectAll, setSelectAll } = useTableSelection({
 *   projectId: "default",
 *   tableName: "runs"
 * });
 */
export function useTableSelection({
  projectId,
  tableName,
}: UseTableSelectionProps) {
  const _router = useRouter();

  // Generate storage key unique to project and table
  const storageKey = `selectAll-${projectId}-${tableName}`;

  // Read initial value from session storage
  const initialValue =
    typeof window !== "undefined"
      ? window.sessionStorage.getItem(storageKey) === "true"
      : false;

  const [selectAll, setSelectAll] = useState<boolean>(initialValue);

  // Sync state to session storage
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.sessionStorage.setItem(storageKey, selectAll.toString());
    }
  }, [selectAll, storageKey]);

  // Clear selection on navigation (similar to Langfuse)
  useEffect(() => {
    const handleRouteChange = () => {
      setSelectAll(false);
    };

    // Note: Next.js App Router doesn't have router.events like Pages Router
    // We use popstate for browser back/forward
    window.addEventListener("popstate", handleRouteChange);

    return () => {
      window.removeEventListener("popstate", handleRouteChange);
    };
  }, []);

  return { selectAll, setSelectAll };
}
