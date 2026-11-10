"use client";

import { useCallback, useSyncExternalStore, type ReactNode } from "react";
import { PanelLeftClose } from "lucide-react";

import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

/**
 * The shared filter-rail shell: the collapsible sidebar frame both the Runs
 * and Traces pages host their filter sections in. The shell owns placement,
 * the header with its close button, the mobile sheet, and the remembered
 * per-browser visibility; the pages own everything inside.
 *
 * Visibility is remembered per browser under a page-scoped storage key, so
 * closing the rail on Runs does not close it on Traces (or vice versa). The
 * external-store pattern keeps the server snapshot neutral (null means
 * visible) so hydration never mismatches; storage events keep other tabs in
 * sync.
 */

const railVisibleListeners = new Set<() => void>();
const railVisibleCache = new Map<string, boolean>();

function subscribeRailVisible(onChange: () => void) {
  railVisibleListeners.add(onChange);
  window.addEventListener("storage", onChange);
  return () => {
    railVisibleListeners.delete(onChange);
    window.removeEventListener("storage", onChange);
  };
}

function readRailVisible(storageKey: string): () => string | null {
  return () => {
    try {
      return window.localStorage.getItem(storageKey);
    } catch {
      return null;
    }
  };
}

/**
 * Rail visibility, remembered per browser under the given storage key.
 * Each page passes its own key ("runs-filters-visible", "traces-filters-visible")
 * so the two rails remember independently.
 */
export function useFilterRailVisible(storageKey: string): [boolean, (next: boolean) => void] {
  const read = readRailVisible(storageKey);
  const stored = useSyncExternalStore(subscribeRailVisible, read, () => null);
  const setVisible = useCallback(
    (next: boolean) => {
      railVisibleCache.set(storageKey, next);
      try {
        window.localStorage.setItem(storageKey, String(next));
      } catch {
        // Storage unavailable: the in-memory notification below still applies.
      }
      railVisibleListeners.forEach((notify) => notify());
    },
    [storageKey],
  );
  return [stored !== "false", setVisible];
}

/** The sheet (mobile rail) open flag, shared in memory per storage key. */
const sheetListeners = new Set<() => void>();
const sheetOpenCache = new Map<string, boolean>();

export function useFilterRailSheetOpen(storageKey: string): [boolean, (next: boolean) => void] {
  const read = () => sheetOpenCache.get(storageKey) ?? false;
  const open = useSyncExternalStore(
    (onChange) => {
      const wrapped = () => onChange();
      sheetListeners.add(wrapped);
      return () => sheetListeners.delete(wrapped);
    },
    read,
    () => false,
  );
  const setOpen = useCallback(
    (next: boolean) => {
      sheetOpenCache.set(storageKey, next);
      sheetListeners.forEach((notify) => notify());
    },
    [storageKey],
  );
  return [open, setOpen];
}

/**
 * The desktop sidebar frame: fixed-width aside with a header, a close
 * button, and the children (the page's filter sections) filling the rest.
 * The page supplies the close handler; the shell does not own visibility
 * so both the toggle and the header's close button can drive it.
 */
export function FilterRailFrame({
  onClose,
  children,
  className,
}: {
  onClose: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      aria-label="Filters"
      className={className ?? "flex w-[264px] shrink-0 flex-col border-r border-border"}
    >
      <div className="flex items-center justify-between px-4 pb-2 pt-4">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Filters
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Hide filters"
          title="Hide filters"
          className="flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelLeftClose className="h-4 w-4" />
        </button>
      </div>
      {children}
    </aside>
  );
}

/**
 * The mobile sidebar frame: the same sections in a slide-over sheet. The
 * page passes the same children it puts in the desktop frame.
 */
export function FilterRailSheetFrame({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-4/5 max-w-xs overflow-y-auto p-0 sm:max-w-xs">
        <SheetHeader className="border-b border-border">
          <SheetTitle className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Filters
          </SheetTitle>
        </SheetHeader>
        <div className="p-4">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
