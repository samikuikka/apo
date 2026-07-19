"use client";

import { useState, useEffect, useRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSelection } from "./contexts/SelectionContext";

interface TraceLayoutMobileProps {
  /** Tree / Timeline / Graph content */
  navContent: ReactNode;
  /** Call detail / Run detail */
  detailContent: ReactNode;
  /** View mode tabs (always visible) */
  tabs: ReactNode;
}

/**
 * Mobile trace layout: a vertical accordion replacing the desktop
 * resizable split panels. The navigation section collapses on tap and
 * auto-collapses when a node is selected so the detail view can expand.
 *
 * Nav section never exceeds 40vh so the detail view always stays visible.
 */
export function TraceLayoutMobile({ navContent, detailContent, tabs }: TraceLayoutMobileProps) {
  const [navExpanded, setNavExpanded] = useState(true);
  const { selectedCallId } = useSelection();
  const skipFirstRunRef = useRef(true);

  // Auto-collapse nav when the user selects a node (gives detail max space).
  // Skip the initial mount so a URL-driven selection keeps the tree visible.
  useEffect(() => {
    if (skipFirstRunRef.current) {
      skipFirstRunRef.current = false;
      return;
    }
    if (selectedCallId) {
      setNavExpanded(false);
    }
  }, [selectedCallId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Tabs bar - always visible */}
      <div className="shrink-0 border-b border-border/70 bg-background px-2.5 pb-1.5 pt-1">
        {tabs}
      </div>

      {/* Nav section - collapsible accordion (max 40vh) */}
      <section
        className={cn(
          "flex shrink-0 flex-col overflow-hidden border-b border-border/70 transition-[max-height] duration-200",
          navExpanded ? "max-h-[40vh]" : "max-h-12",
        )}
        aria-label="Trace navigation"
      >
        <button
          type="button"
          onClick={() => setNavExpanded((expanded) => !expanded)}
          aria-label={navExpanded ? "Hide navigation" : "Show navigation"}
          aria-expanded={navExpanded}
          className="flex min-h-11 w-full shrink-0 items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/30"
        >
          <span>{navExpanded ? "Hide" : "Show"} navigation</span>
          <ChevronDown
            className={cn("h-4 w-4 transition-transform duration-200", navExpanded && "rotate-180")}
            aria-hidden="true"
          />
        </button>
        <div className="min-h-0 flex-1 overflow-auto">{navContent}</div>
      </section>

      {/* Detail section - fills remaining space */}
      <div className="min-h-0 flex-1 overflow-auto border-t border-border bg-background">
        {detailContent}
      </div>
    </div>
  );
}
