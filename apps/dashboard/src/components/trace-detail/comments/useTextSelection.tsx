"use client";

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  selectionToPath,
  type JsonDataField,
  type SelectionPathResult,
} from "./selectionToPath";

/**
 * Tracks text selection within a JSON viewer container so an inline comment
 * bubble can be shown at the selection. The pending selection is shared via
 * context so the bubble (rendered outside the viewer) can consume it.
 */

export interface PendingSelection extends SelectionPathResult {
  /** Bounding rect of the full selection, for positioning the bubble. */
  anchorRect: DOMRect;
  /** Bounding rect collapsed to the start, for tighter positioning. */
  startRect: DOMRect;
}

interface InlineCommentSelectionContextValue {
  pending: PendingSelection | null;
  setSelection: (s: PendingSelection | null) => void;
  clearSelection: () => void;
}

const InlineCommentSelectionContext =
  createContext<InlineCommentSelectionContextValue | null>(null);

export function InlineCommentSelectionProvider({
  children,
}: {
  children: ReactNode;
}) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const setSelection = useCallback(
    (s: PendingSelection | null) => setPending(s),
    [],
  );
  const clearSelection = useCallback(() => setPending(null), []);
  const value = useMemo(
    () => ({ pending, setSelection, clearSelection }),
    [pending, setSelection, clearSelection],
  );
  return (
    <InlineCommentSelectionContext.Provider value={value}>
      {children}
    </InlineCommentSelectionContext.Provider>
  );
}

export function useInlineCommentSelection() {
  const ctx = useContext(InlineCommentSelectionContext);
  if (!ctx) {
    throw new Error(
      "useInlineCommentSelection must be used within InlineCommentSelectionProvider",
    );
  }
  return ctx;
}

export function useInlineCommentSelectionOptional() {
  return useContext(InlineCommentSelectionContext);
}

interface UseTextSelectionOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  dataField: JsonDataField;
  enabled?: boolean;
}

/** Attach selectionchange handling to a JSON viewer container. */
export function useTextSelection({
  containerRef,
  dataField,
  enabled = true,
}: UseTextSelectionOptions) {
  const context = useInlineCommentSelectionOptional();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSelectionChange = useCallback(() => {
    if (!enabled || !containerRef.current || !context) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        const focusNode = selection?.focusNode;
        if (focusNode && containerRef.current?.contains(focusNode)) {
          context.clearSelection();
        }
        return;
      }

      const range = selection.getRangeAt(0);
      if (!containerRef.current?.contains(range.commonAncestorContainer)) {
        return;
      }

      const result = selectionToPath(selection, containerRef.current, dataField);
      if (!result) return;

      const startRange = range.cloneRange();
      startRange.collapse(true);
      context.setSelection({
        ...result,
        anchorRect: range.getBoundingClientRect(),
        startRect: startRange.getBoundingClientRect(),
      });
    }, 150);
  }, [enabled, containerRef, dataField, context]);

  useEffect(() => {
    if (!enabled || !context) return;
    document.addEventListener("selectionchange", handleSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", handleSelectionChange);
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [enabled, handleSelectionChange, context]);

  return { clearSelection: context?.clearSelection };
}
